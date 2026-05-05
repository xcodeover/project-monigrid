# Monitoring Backend (monigrid-be)

monigrid-fe와 연동되는 Python 기반 모니터링 백엔드입니다.
**공유 설정 DB (`monigrid_*` 테이블)** 에 저장된 연결·API·SQL 정보를 바탕으로 REST API 를 구성하고, JDBC 로 대상 DB 조회 결과를 제공합니다.
네트워크 테스트(Ping/Telnet), 서버 리소스 모니터링(CPU/Memory/Disk), DB 성능 진단 등의 기능을 포함합니다.

> **v2.0+ 주요 변경**
> - 설정/SQL 저장소가 파일(`config.json`, `sql/*.sql`)에서 **공유 설정 DB** 로 이전되었습니다 (Active-Active 대응).
> - 부트스트랩은 [`initsetting.json`](initsetting.json) 으로 설정 DB 접속 정보를 읽고, 최초 1회 `config.json`·`sql/*.sql` 을 설정 DB 로 시드한 뒤 파일을 `.bak` 으로 이름 변경합니다.
> - 대시보드 설정 편집기 / SQL 편집기에서의 변경은 `monigrid_*` 테이블에 저장되어 양 A-A 노드에 즉시 반영됩니다.

---

## 목차

1. [주요 기능](#1-주요-기능)
2. [요구사항](#2-요구사항)
3. [폴더 구조](#3-폴더-구조)
4. [빠른 시작 (Quick Start)](#4-빠른-시작-quick-start)
5. [개발 모드 실행](#5-개발-모드-실행)
6. [EXE 빌드 (PyInstaller)](#6-exe-빌드-pyinstaller)
7. [설정 (설정 DB 스키마 / 시드 JSON 구조)](#7-설정-설정-db-스키마--시드-json-구조)
8. [SQL 쿼리 작성](#8-sql-쿼리-작성)
9. [DB 드라이버 준비 (JDBC)](#9-db-드라이버-준비-jdbc)
10. [주요 API 레퍼런스](#10-주요-api-레퍼런스)
11. [환경 변수](#11-환경-변수)
12. [로그](#12-로그)
13. [운영 가이드](#13-운영-가이드)
14. [IIS 단일 사이트 배포 (Frontend + Backend 같은 포트)](#14-iis-단일-사이트-배포-frontend--backend-같은-포트)
15. [트러블슈팅](#15-트러블슈팅)
16. [initsetting.json (설정 DB 접속 정보)](#16-initsettingjson-설정-db-접속-정보)

---

## 1. 주요 기능

### 데이터 수집 & 캐싱

- **설정 DB 기반 REST API 라우팅** — `monigrid_apis` 테이블의 `rest_api_path` 로 동적 엔드포인트 생성
- **설정 DB 기반 SQL 쿼리 실행** — `monigrid_sql_queries.content` 를 읽어 JDBC 로 실행
- **DB 연결 풀** — 스레드 안전한 JDBC 커넥션 풀 관리. 풀에서 커넥션을 꺼낼 때 `Connection.isValid(2)` 로 stale 여부를 검증하고, 새 커넥션 생성 시 백오프 재시도(기본 3회) 로 일시적 네트워크 단절을 흡수합니다.
- **설정 DB 자동 재연결** — 설정 DB 연결이 서버 측(`wait_timeout` 등)에서 끊겨도 다음 호출 시 lazy retry 로 재연결 (한 번 실패해도 다음 호출에서 다시 시도).
- **백그라운드 캐시 자동 갱신** — 엔드포인트별 주기적 캐시 리프레시 (데몬 스레드). 매 tick 마다 엔드포인트 카탈로그를 재조회하여 `refresh_interval_sec` / SQL / 활성화 변경이 즉시 반영됩니다.
- **기동 시 캐시 워밍업** — 서버 시작 시 모든 활성 엔드포인트의 DB 쿼리를 병렬 실행하여 캐시 사전 적재

### 인증 & 보안

- **JWT 로그인/인증** — `POST /auth/login`으로 토큰 발급, 모든 API에 `Bearer` 토큰 필요
- **DB 기반 사용자 계정** — `monigrid_users` 테이블에 bcrypt 해시(비용 12) 로 비밀번호 저장, admin/user 역할을 통해 권한 구분. 사용자명/비밀번호/표시 이름은 길이 상한이 적용됩니다.
- **환경변수 부트스트랩 로그인** — `AUTH_USERNAME`/`AUTH_PASSWORD` 환경변수는 `monigrid_users` 에 admin 계정이 하나도 없을 때만 사용 가능. DB 에 admin 이 한 명이라도 생기면 환경변수 로그인은 자동 차단됩니다(마스터 잠금 방지).
- **관리자 전용 API** — SQL Editor, 사용자 관리, 모니터 타겟 생성/수정/삭제, `reload-config`, 전체 캐시 리프레시 / 강제 reset_connection 등 민감 작업은 admin 권한만 허용 (단일 엔드포인트 캐시 리프레시는 일반 사용자 허용)
- **사용자 자기보호 불변식** — admin 이 자기 계정을 삭제·비활성·다운그레이드 할 수 없도록 admin_user_routes 에서 차단
- **에러 메시지 일반화** — 외부 응답에는 내부 예외 문자열 대신 일반화된 메시지를 반환하여 스택/내부 상세 노출을 방지 (자세한 내용은 로그 파일에서 확인)
- **WMI / SSH 명령 안전화** — 원격 실행은 argv list + `shell=False` 로만 호출되어 자격증명/호스트가 셸 인자로 합쳐지지 않습니다.
- **Health-check 프록시 SSRF 방어** — URL 스킴(http/https)·길이 검증, 환경변수 `HEALTHCHECK_BLOCK_PRIVATE` 로 사설 IP 차단 옵션
- **per-endpoint 429 격리** — 한 위젯/엔드포인트의 429 가 다른 엔드포인트 폴링을 막지 않도록 endpoint 별로 cooldown 맵을 유지
- **Rate Limiting** — Flask-Limiter 기반 요청 제한 (기본 100/분)

### 네트워크 & 서버 모니터링

- **Ping/Telnet 테스트** — `POST /dashboard/network-test`로 네트워크 연결 진단
- **서버 리소스 모니터링** — `POST /dashboard/server-resources`로 원격/로컬 서버 CPU·메모리·디스크 수집
  - Linux: SSH(paramiko)로 원격 접속하여 `top`, `/proc/meminfo`, `df` 실행
  - Windows: WMI 명령, SSH+PowerShell, 또는 WinRM(pywinrm)으로 수집
- **Health-Check 프록시** — `POST /dashboard/health-check-proxy`로 CORS 우회 HTTP 상태 체크

### DB 성능 진단

- **슬로우 쿼리 / 테이블스페이스 / 오브젝트 락** 진단 쿼리 실행
- Oracle / MariaDB / MSSQL 지원

### 운영 편의

- **설정 핫 리로드** — `POST /dashboard/reload-config`로 서버 재시작 없이 설정 반영. 새 executor + 새 풀을 atomic swap 한 후 구 executor 를 drain → 구 풀을 닫는 순서로 동작하여 진행 중이던 쿼리가 끊기지 않습니다.
- **SQL Editor** — 대시보드에서 설정 DB의 SQL 쿼리 조회·수정 (관리자 전용, SELECT만 허용; MariaDB/MSSQL 은 `FROM` 없는 SELECT 허용, Oracle 만 `FROM DUAL` 요구). 변경 로그는 쿼리 전문 대신 `sha256` prefix 만 기록합니다.
- **모니터 타겟 중앙 수집** — 서버 리소스 / 네트워크 / HTTP 상태(API 상태 리스트) 타겟을 `monigrid_monitor_targets` 에 등록하면 BE 의 단일 백그라운드 수집기가 주기적으로 실행, 모든 브라우저가 `/dashboard/monitor-snapshot` 으로 동일 스냅샷 조회 (폴링 부하를 BE 에 1회 집중). 수집 루프는 매 tick 마다 타겟 카탈로그를 다시 읽어 `interval_sec` 변경이 즉시 반영됩니다.
- **사용자별 환경설정** — 위젯 레이아웃·임계값·알람 설정 등을 `monigrid_user_preferences` 에 저장하여 계정 단위로 복원 (`/dashboard/me/preferences`)
- **설정 DB 이관 스크립트** — `migrate_settings_db.py` 로 Oracle / MariaDB / MSSQL 간 monigrid_* 테이블을 그대로 복사
- **일자별 로그 파일** — 자동 생성 및 보관 기간 자동 정리

---

## 2. 요구사항

### 개발 모드

| 항목 | 버전 | 비고 |
|------|------|------|
| Python | 3.13+ | |
| JDK | 11+ | `JAVA_HOME` 환경변수 필수 |
| pip 패키지 | `requirements.txt` | 아래 참조 |

```bash
pip install -r requirements.txt
```

### 주요 패키지

| 패키지 | 용도 |
|--------|------|
| Flask, flask-cors, flask-limiter | 웹 프레임워크 / CORS / Rate Limit |
| pydantic | 요청 데이터 검증 |
| PyJWT | JWT 인증 |
| JayDeBeApi, JPype1 | JDBC 브릿지 (Java DB 드라이버 사용) |
| paramiko | SSH 원격 명령 실행 (서버 리소스 모니터링) |
| pywinrm | WinRM 원격 명령 실행 (Windows 서버 리소스 모니터링) |
| requests | HTTP 클라이언트 (Health-Check 프록시) |
| pyinstaller | EXE 패키징 |

### EXE 빌드 추가 요구사항

- PyInstaller 6.x (requirements.txt에 포함)
- Windows 환경에서 빌드

---

## 3. 폴더 구조

### 소스 트리

```text
monigrid-be/
├── monigrid_be.py              # Flask 앱 진입점, 라우트 정의
├── monigrid_be.spec            # PyInstaller 빌드 스펙
├── build_backend_exe.bat       # 원클릭 EXE 빌드 스크립트
├── requirements.txt
├── pyproject.toml              # 프로젝트 메타데이터
├── .env.example                # 환경변수 참고 파일
├── initsetting.json            # 설정 DB 접속 정보 (부트스트랩) ★ (git 제외)
├── initsetting.example.json    # 템플릿 (운영자가 복사하여 편집)
├── initsetting.oracle.json     # (선택) Oracle 용 템플릿 — 이관 스크립트 입력
├── initsetting.mssql.json      # (선택) MSSQL 용 템플릿 — 이관 스크립트 입력
├── migrate_settings_db.py      # 설정 DB 간 이관 스크립트 (Oracle ⇄ MariaDB ⇄ MSSQL)
├── config.json                 # 최초 1회 시드 소스 (시드 후 config.json.bak 로 rename)
├── sql/                        # 최초 1회 시드 소스 (시드 후 sql.bak/ 로 rename)
├── drivers/                    # JDBC 드라이버 JAR (설정 DB + 대상 DB 용)
│   ├── ojdbc11.jar
│   ├── mariadb-java-client-3.4.1.jar
│   └── mssql-jdbc-12.8.1.jre11.jar
├── logs/                       # 날짜별 로그 파일 (자동 생성)
├── app/                        # 핵심 비즈니스 로직 패키지
│   ├── __init__.py             # 패키지 초기화
│   ├── auth.py                 # JWT 인증, bcrypt 해시, 로그인 검증
│   ├── cache.py                # 엔드포인트 캐시 엔트리 관리
│   ├── config.py               # 설정 DTO / AppConfig 데이터클래스
│   ├── db.py                   # JVM 라이프사이클, JDBC 커넥션 풀
│   ├── exceptions.py           # 커스텀 예외 클래스
│   ├── jdbc_executor.py        # 엔드포인트 SQL 실행기
│   ├── logging_setup.py        # 로깅 설정 (파일·콘솔)
│   ├── monitor_collector_manager.py # 모니터 타겟 백그라운드 수집기 ★
│   ├── service.py              # MonitoringBackend 서비스 (핵심 로직)
│   ├── settings_store.py       # 설정 DB (SettingsStore, SqlRepository) ★
│   ├── sql_editor_service.py   # SQL 편집기 서비스
│   ├── sql_validator.py        # SQL SELECT 검증 (dialect-aware)
│   ├── utils.py                # 유틸리티 함수
│   └── routes/                 # HTTP 라우트 그룹 (SRP 분리)
│       ├── admin_user_routes.py        # 사용자 관리 API (/admin/users) ★
│       ├── auth_routes.py              # 로그인/로그아웃
│       ├── dashboard_routes.py         # 설정·SQL 편집기·캐시·DB health
│       ├── dynamic_routes.py           # /<rest_api_path> 동적 라우팅
│       ├── health_proxy_routes.py      # /dashboard/health-check-proxy*
│       ├── monitor_routes.py           # /dashboard/monitor-* ★
│       ├── network_routes.py           # /dashboard/network-test*
│       ├── server_routes.py            # /dashboard/server-resources*
│       ├── system_routes.py            # /health, /logs
│       └── user_preferences_routes.py  # /dashboard/me/preferences ★
└── exe_api_smoke_test.py       # EXE 기동 후 빠른 API 검증 스크립트
```

### EXE 빌드 결과물 트리

```text
dist/
├── monigrid-be.exe        # 실행 파일
├── _internal/                 # Python 런타임 (수정 불필요)
├── config.json                # ★ 편집 가능 — DB 연결·API·인증 설정
├── sql/                       # ★ 편집 가능 — SQL 쿼리 파일
├── drivers/                   # ★ 편집 가능 — JDBC JAR 파일
├── logs/                      # 첫 실행 시 자동 생성
└── .env.example               # 환경변수 참고 파일
```

> `_internal/` 외 폴더/파일(`config.json`, `sql/`, `drivers/`)은 exe 옆에 위치하므로
> **재빌드 없이 자유롭게 편집** 가능합니다.

---

## 4. 빠른 시작 (Quick Start)

### 초보자를 위한 단계별 안내

#### Step 1: 사전 준비

1. **Python 3.13+** 설치 (https://www.python.org/downloads/)
   - 설치 시 "Add Python to PATH" 체크 필수
2. **JDK 11+** 설치 (https://adoptium.net/)
3. **JAVA_HOME 환경변수 설정**:
   - 시작 → "환경 변수" 검색 → 시스템 환경 변수 → `JAVA_HOME` 추가
   - 값: JDK 설치 경로 (예: `C:\Program Files\Eclipse Adoptium\jdk-17.0.x`)
4. 설정 확인:
   ```bash
   python --version       # Python 3.13.x
   java -version          # openjdk 17.x.x 등
   echo %JAVA_HOME%       # JDK 경로 출력 확인
   ```

#### Step 2: 의존성 설치 및 실행

```bash
cd monigrid-be
pip install -r requirements.txt
python monigrid_be.py
```

#### Step 3: 동작 확인

```bash
# 1. 서버 상태 확인
curl http://127.0.0.1:5000/health

# 2. 로그인
curl -X POST http://127.0.0.1:5000/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"username\":\"admin\",\"password\":\"admin\"}"
# → {"token":"eyJhbG...","user":{"id":1,"username":"admin","role":"admin"}}

# 3. 토큰으로 API 호출
curl http://127.0.0.1:5000/api/status ^
  -H "Authorization: Bearer eyJhbG..."
```

#### Step 4: 프론트엔드 연동

- 프론트엔드(`monigrid-fe`)를 실행하고 로그인 화면에서 백엔드 URL `http://127.0.0.1:5000` 입력
- 기본 로그인: `admin` / `admin`

---

## 5. 개발 모드 실행

```bash
cd monigrid-be

# 의존성 설치 (최초 1회)
pip install -r requirements.txt

# 서버 실행
python monigrid_be.py
```

기본 접속: `http://127.0.0.1:5000`

서버 시작 시 다음이 자동으로 수행됩니다:
1. `initsetting.json` 로드 → 설정 DB 에 연결 (JVM 시작, JDBC 드라이버 JAR 클래스패스 포함)
2. 최초 기동 시: `monigrid_*` 테이블 DDL 생성 + `config.json` / `sql/*.sql` 시드 → 원본을 `.bak` 으로 rename
3. 설정 DB 에서 `AppConfig` (연결·API·SQL·검증 규칙) 로드 및 유효성 검증
4. 활성 엔드포인트 캐시 워밍업 (모든 DB 쿼리 1회 병렬 실행)
5. 백그라운드 캐시 리프레시 스레드 시작

---

## 6. EXE 빌드 (PyInstaller)

### 6.1 원클릭 빌드

```bat
cd monigrid-be
build_backend_exe.bat
```

내부적으로 다음 단계를 순서대로 실행합니다:

| 단계 | 내용 |
|------|------|
| 1 | `pip install -r requirements.txt` |
| 2 | 이전 빌드 산출물 정리 (`_internal/`, `monigrid-be.exe`만 삭제, 런타임 파일 보존) |
| 3 | `pyinstaller --noconfirm --clean monigrid_be.spec` |
| 4 | dist 폴더 플래튼 (`dist\monigrid-be\` → `dist\`로 exe, `_internal` 이동) |
| 5 | 런타임 파일 확인 — `config.json`, `sql/`, `drivers/`가 없을 때만 초기 복사 (기존 파일 보존) |
| 6 | `logs/` 디렉토리 생성 (없을 때만) |

> **재빌드 시 `config.json`, `sql/`, `drivers/`, `logs/`는 덮어쓰지 않습니다.**
> 운영 환경에서 수정한 설정이 빌드로 인해 초기화되지 않으므로 안심하고 재빌드할 수 있습니다.

### 6.2 빌드 결과물 확인

```text
dist\
  monigrid-be.exe    ← 배포 대상 실행 파일
  _internal\             ← Python 런타임 (함께 배포, 수정 불필요)
  config.json            ← 배포 후 환경에 맞게 편집
  sql\                   ← SQL 파일 추가·수정 가능
  drivers\               ← JDBC JAR 추가·교체 가능
  logs\                  ← 첫 실행 시 자동 생성
```

### 6.3 배포 시 체크리스트

- [ ] 배포 서버에 **JDK 11+** 설치 및 `JAVA_HOME` 환경변수 설정
- [ ] `config.json` 내 DB 접속 정보 (host, port, username, password) 배포 환경에 맞게 수정
- [ ] `config.json` 내 `auth.username`, `auth.password`를 실제 운영 계정으로 변경
- [ ] `drivers/` 에 연결할 DB 종류에 맞는 JDBC JAR가 있는지 확인
- [ ] 방화벽에서 백엔드 포트 (기본 5000) 허용
- [ ] **(필수)** `.env` 파일로 `JWT_SECRET_KEY` 설정 — 기본값(`default-secret-key`) 사용 시 운영 환경에서 서버가 시작되지 않음

### 6.4 EXE 직접 실행

```bat
cd dist
monigrid-be.exe
```

### 6.5 기동 후 API 검증

```bash
# Python이 설치된 환경에서
python exe_api_smoke_test.py
```

---

## 7. 설정 (설정 DB 스키마 / 시드 JSON 구조)

> 아래 JSON 구조는 **최초 기동 시 설정 DB 로 시드되는 `config.json` 의 형태** 이자, 대시보드 **설정 편집기** 가 설정 DB 테이블을 노출할 때 사용하는 논리적 스키마입니다. 운영 중에는 파일이 아닌 `monigrid_*` 테이블이 진실 공급원(source of truth) 입니다. 부트스트랩 파일에 대한 설명은 [initsetting.json](#16-initsettingjson-설정-db-접속-정보) 을 참조하세요.

### 7.0 `monigrid_*` 테이블 요약

모든 테이블은 부트스트랩 시 방언(Oracle / MariaDB / MSSQL) 에 맞는 DDL 로 자동 생성됩니다. 또한 매 시작 시점에 `SettingsStore.create_schema()` 가 idempotent DDL(`CREATE TABLE IF NOT EXISTS` / Oracle 의 `user_tables` 체크) 로 호출되므로, 신규 버전에서 추가된 테이블은 이미 부트스트랩된 환경에서도 자동으로 보강됩니다 (예: 구버전에서 운용 중이던 DB 에 `monigrid_users` / `monigrid_monitor_targets` 가 없어도 다음 기동 시 자동 생성).

| 테이블 | 용도 |
|-------|------|
| `monigrid_settings_meta` | 부트스트랩 플래그, 스키마 버전 등 키-값 메타 |
| `monigrid_settings_kv` | `server` / `auth` / `rate_limits` / `logging` / `sql_validation` 같은 섹션 단위 JSON 저장 |
| `monigrid_connections` | DB 연결 카탈로그 (`connections[]`) |
| `monigrid_apis` | REST API 엔드포인트 카탈로그 (`apis[]`) |
| `monigrid_sql_queries` | `sql_id` → SQL 본문 (CLOB/LONGTEXT/NVARCHAR(MAX)) |
| `monigrid_monitor_targets` | BE 중앙 수집기용 타겟 카탈로그 (서버 리소스 / 네트워크 / HTTP 상태) |
| `monigrid_user_preferences` | 사용자별 UI 환경설정 JSON |
| `monigrid_users` | 로그인 계정 — bcrypt 해시 + role(admin/user) + enabled |

### 7.1 전체 구조

```json
{
    "server": {
        "host": "127.0.0.1",
        "port": 5000,
        "thread_pool_size": 16,
        "refresh_interval_sec": 5,
        "query_timeout_sec": 10
    },
    "auth": {
        "username": "admin",
        "password": "admin"
    },
    "sql_validation": {
        "typo_patterns": {
            "where":    ["whre", "wehre", "wher"],
            "order_by": ["oder", "odrer", "ordder"],
            "group_by": ["gorup", "gruop", "gropu"],
            "having":   ["havng", "hvaing"],
            "join":     ["jion", "joim"]
        }
    },
    "logging": {
        "directory": "logs",
        "file_prefix": "monigrid_be",
        "level": "INFO",
        "retention_days": 7,
        "slow_query_threshold_sec": 10
    },
    "global_jdbc_jars": "drivers/ojdbc11.jar;drivers/mariadb-java-client-3.4.1.jar;drivers/mssql-jdbc-12.8.1.jre11.jar",
    "connections": [...],
    "apis": [...]
}
```

### 7.2 server — 서버 설정

| 키 | 설명 | 기본값 |
|----|------|--------|
| `host` | 바인드 주소 (`0.0.0.0`이면 외부 접근 허용) | `127.0.0.1` |
| `port` | 서버 포트 | `5000` |
| `thread_pool_size` | DB 쿼리 실행 스레드 풀 크기 | `16` |
| `refresh_interval_sec` | 기본 캐시 갱신 주기 (초) | `5` |
| `query_timeout_sec` | 기본 쿼리 타임아웃 (초) | `10` |

### 7.3 connections — DB 연결 설정

```json
"connections": [
    {
        "id": "oracle-main",
        "db_type": "oracle",
        "jdbc_driver_class": "oracle.jdbc.OracleDriver",
        "jdbc_url": "jdbc:oracle:thin:@//localhost:1521/XEPDB1",
        "username": "monitor",
        "password": "monitor"
    },
    {
        "id": "mariadb-main",
        "db_type": "mariadb",
        "jdbc_driver_class": "org.mariadb.jdbc.Driver",
        "jdbc_url": "jdbc:mariadb://192.168.0.71:3336/mydb",
        "username": "dbuser",
        "password": "dbpass"
    },
    {
        "id": "mssql-main",
        "db_type": "mssql",
        "jdbc_driver_class": "com.microsoft.sqlserver.jdbc.SQLServerDriver",
        "jdbc_url": "jdbc:sqlserver://127.0.0.1:1433;databaseName=mydb;encrypt=true;trustServerCertificate=true",
        "username": "sa",
        "password": "YourPassword!"
    }
]
```

| 키 | 설명 |
|----|------|
| `id` | 연결 고유 식별자 (apis에서 참조) |
| `db_type` | `oracle` / `mariadb` / `mssql` |
| `jdbc_driver_class` | JDBC 드라이버 클래스명 |
| `jdbc_url` | JDBC 접속 URL |
| `username` / `password` | DB 접속 계정 |
| `jdbc_jars` | (선택) 이 연결 전용 JAR 경로 |

`global_jdbc_jars`에 세미콜론(`;`)으로 모든 DB의 JAR를 나열하면, 모든 connection에 자동 적용됩니다.

### 7.4 apis — REST API 엔드포인트 설정

```json
"apis": [
    {
        "id": "status",
        "rest_api_path": "/api/status",
        "connection_id": "mariadb-main",
        "sql_id": "status",
        "enabled": true,
        "refresh_interval_sec": 5,
        "query_timeout_sec": 10
    }
]
```

| 키 | 설명 |
|----|------|
| `id` | API 고유 식별자 |
| `rest_api_path` | REST 경로 (중복 불가) |
| `connection_id` | `connections[].id` 참조 |
| `sql_id` | `sql/<sql_id>.sql` 파일과 매핑 |
| `enabled` | `false`로 설정 시 라우팅에서 제외 |
| `refresh_interval_sec` | 백그라운드 캐시 갱신 주기 (초) |
| `query_timeout_sec` | 쿼리 타임아웃 (초) |

### 7.5 설정 변경 후 적용

| 방법 | 적용 범위 |
|------|-----------|
| `POST /dashboard/reload-config` | DB 연결·API 엔드포인트·SQL 검증 규칙 (서버 재시작 불필요) |
| EXE 재시작 | 서버 포트·스레드 풀 등 서버 레벨 설정 변경 |

---

## 8. SQL 쿼리 작성

- 저장 위치: **설정 DB** 의 `monigrid_sql_queries` 테이블 (`sql_id` PK, `content` TEXT/CLOB)
- `apis[].sql_id` 와 `monigrid_sql_queries.sql_id` 가 매핑됩니다.
- **SELECT / WITH(CTE) 구문만 허용**합니다. UPDATE·DELETE·DROP 등은 차단됩니다.

예시 (`status` 엔트리 내용):

```sql
SELECT app_name, status, cpu_usage, memory_usage, collected_at
FROM app_status
ORDER BY collected_at DESC
LIMIT 100
```

> 대시보드 **SQL 편집기** 에서 저장하면 `monigrid_sql_queries` 에 즉시 반영 + 엔드포인트 캐시가 자동 갱신됩니다. 별도 reload-config 호출이 필요하지 않습니다.
> 파일 기반 편집이 필요하면 `sql.bak/` 에 남은 시드 파일을 편집한 뒤 SQL 편집기로 복사-붙여넣기하거나, `POST /dashboard/sql-editor/files` API 를 활용하세요.

### SQL 편집 주의사항

- SQL 오타 자동 감지: 설정 DB 의 `sql_validation.typo_patterns` 에 정의된 패턴으로 검사
- **FROM 절**: Oracle 은 필수 (스칼라 SELECT 에도 `FROM DUAL` 필요). MariaDB/MSSQL 은 `SELECT NOW()`, `SELECT 1+1` 등 FROM 없는 SELECT 허용
- 세미콜론(`;`)은 있어도 없어도 무방 (단일 문장만 허용)
- 주석(`--`, `/* */`)은 허용

---

## 9. DB 드라이버 준비 (JDBC)

`drivers/` 폴더에 사용할 DB의 JDBC JAR를 배치합니다.

| DB 종류 | 드라이버 파일 예시 | 다운로드 |
|---------|-------------------|----------|
| Oracle | `ojdbc11.jar` | Oracle JDBC Downloads |
| MariaDB / MySQL | `mariadb-java-client-3.4.1.jar` | MariaDB Connector/J |
| MS SQL Server | `mssql-jdbc-12.8.1.jre11.jar` | Microsoft JDBC Driver |

### JAR 경로 설정

```json
// 방법 1: 모든 연결에 공통 적용
"global_jdbc_jars": "drivers/ojdbc11.jar;drivers/mariadb-java-client-3.4.1.jar"

// 방법 2: 특정 연결에만 적용 (connection 항목에 추가)
"jdbc_jars": "drivers/special-driver.jar"
```

> JVM 시작 시 모든 JAR가 클래스패스에 등록됩니다.
> 새 JAR를 추가한 경우 EXE를 **재시작**해야 합니다 (JVM 클래스패스는 시작 시 고정).

---

## 10. 주요 API 레퍼런스

### 10.1 인증

| 메서드 | 경로 | 설명 | 인증 |
|--------|------|------|------|
| POST | `/auth/login` | JWT 토큰 발급 | 불필요 |
| POST | `/auth/logout` | 로그아웃 | 필요 |

> **로그인 처리 순서** — 먼저 `monigrid_users` 테이블에서 bcrypt 해시를 확인합니다. 일치하는 row 가 없고 DB 에 admin 계정이 한 명도 없을 때만 환경변수(`AUTH_USERNAME`/`AUTH_PASSWORD`) 에 정의된 부트스트랩 계정이 허용됩니다. 실제 운영에서는 최초 기동 후 즉시 `POST /admin/users` 로 관리자 계정을 생성하세요.

```bash
# 로그인
curl -X POST http://127.0.0.1:5000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'

# 응답: {"token":"eyJhbG...","user":{"id":1,"username":"admin","role":"admin"}}
```

이후 모든 요청에 `Authorization: Bearer <token>` 헤더가 필요합니다.

### 10.2 데이터 조회 (동적 라우팅)

- `GET /<rest_api_path>` — `config.json`의 `apis[]` 기준 동적 라우팅
- 예: `GET /api/status` → `sql/status.sql` 실행 결과 반환

### 10.3 운영 관리

| 메서드 | 경로 | 권한 | 설명 |
|--------|------|------|------|
| GET | `/health` | 불필요 | 인증 없이 status+timestamp 만 반환 (저비용 헬스 프로브) |
| GET | `/dashboard/health` | auth | 버전 / 활성 엔드포인트 수 등 상세 상태 |
| GET | `/dashboard/endpoints` | auth | 활성화된 엔드포인트 목록 |
| POST | `/dashboard/reload-config` | admin | 설정 재적재 (무중단) — atomic swap 으로 진행 중 쿼리 보호 |
| GET | `/dashboard/cache/status` | auth | 캐시 상태 (갱신 시각, 행 수, 오류) |
| POST | `/dashboard/cache/refresh` | auth(단일) / admin(전체·reset_connection) | 캐시 즉시 갱신 |
| GET | `/dashboard/config` | admin | 설정 조회 |
| PUT | `/dashboard/config` | admin | 설정 수정 및 핫 리로드 |

**캐시 리프레시 요청 예시:**

```bash
# 특정 엔드포인트 캐시 갱신
curl -X POST http://127.0.0.1:5000/dashboard/cache/refresh \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"api_id":"status","reset_connection":true}'

# 전체 엔드포인트 캐시 갱신
curl -X POST http://127.0.0.1:5000/dashboard/cache/refresh \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 10.4 SQL Editor (관리자 전용)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/dashboard/sql-editor/endpoints` | 편집 가능 API 목록 |
| GET | `/dashboard/sql-editor/<api_id>` | SQL 파일 조회 |
| PUT | `/dashboard/sql-editor/<api_id>` | SQL 파일 수정 |
| GET | `/dashboard/sql-editor/validation-rules` | 오타 검증 규칙 조회 |

### 10.5 사용자 계정 관리 (관리자 전용)

`monigrid_users` 테이블의 CRUD 엔드포인트. 비밀번호는 `bcrypt` 로 해시되어 저장되며 응답에는 절대 포함되지 않습니다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET    | `/admin/users` | 사용자 목록 (password_hash 제외) |
| POST   | `/admin/users` | 사용자 생성 — body: `{username, password, role, display_name?, enabled?}` |
| PUT    | `/admin/users/<username>` | 부분 수정 (password/role/display_name/enabled 중 전달된 값만 반영) |
| DELETE | `/admin/users/<username>` | 사용자 삭제 |

자기보호 규칙:
- admin 은 자기 계정을 **삭제**할 수 없습니다 (400).
- admin 은 자기 자신을 **role != admin** 으로 바꿀 수 없습니다 (400).
- admin 은 자기 자신의 `enabled` 를 **false** 로 내릴 수 없습니다 (400).

### 10.6 사용자 환경설정

로그인된 JWT 사용자 본인의 UI 선호값을 읽고 씁니다. 다른 사용자의 preferences 는 접근할 수 없습니다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/dashboard/me/preferences` | 본인 환경설정 조회 (없으면 `{}`) |
| PUT | `/dashboard/me/preferences` | 환경설정 저장 — body: `{preferences: {...}}` 또는 raw object |

저장 포맷은 프론트엔드가 자유롭게 정의할 수 있는 JSON 객체입니다 (위젯 레이아웃, 임계값, 알람 소리 등).

### 10.7 모니터 타겟 (중앙 수집)

브라우저에서 개별 위젯이 서버 리소스 / 네트워크 테스트 / HTTP 상태 요청을 보내는 대신, BE 의 단일 수집기가 타겟 카탈로그를 주기적으로 실행하여 결과를 메모리에 캐시합니다.

| 메서드 | 경로 | 권한 | 설명 |
|--------|------|------|------|
| GET    | `/dashboard/monitor-targets` | auth | 타겟 목록 (비관리자에게는 spec 내 password/secret/token 이 마스킹됨) |
| POST   | `/dashboard/monitor-targets` | admin | 타겟 생성 |
| PUT    | `/dashboard/monitor-targets/<id>` | admin | 타겟 수정 |
| DELETE | `/dashboard/monitor-targets/<id>` | admin | 타겟 삭제 |
| GET    | `/dashboard/monitor-snapshot?ids=a,b,c` | auth | 최신 스냅샷 조회 (ids 생략 시 전체) |
| POST   | `/dashboard/monitor-snapshot/<id>/refresh` | auth | 해당 타겟 즉시 재수집 |

타겟 `type` 은 다음 세 가지 중 하나이며, `spec` 에는 각 수집기에 전달할 파라미터가 들어갑니다.

| type | 용도 | 주요 spec 키 |
|------|------|--------------|
| `server_resource` | CPU/MEM/DISK 수집 (SSH / WMI / WinRM) | `os_type`, `host`, `username`, `password`, `port`, `domain`, `transport` |
| `network` | Ping / Telnet 진단 | `type`(`ping`/`telnet`), `host`, `port`(telnet), `timeout` |
| `http_status` | API 상태 리스트용 HTTP GET 프로브 | `url`(필수), `timeout_sec`(1~30, 기본 10) |

> `http_status` 타겟은 v2.3+ 에서 추가되었습니다. 기존에 위젯이 직접 호출하던 `/dashboard/health-check-proxy-batch` fan-out 을 대체하므로, 같은 URL 을 보는 브라우저가 100개여도 BE 가 1회만 외부 호출을 수행합니다. 위젯 측의 자동 마이그레이션은 없으며, 새 카드로 다시 등록해야 합니다 (자세한 내용은 `monitor_collector_manager.py` 의 `_collect_one`).

### 10.8 DB 성능 진단

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/dashboard/db-health/connections` | 설정된 DB 연결 목록 |
| GET | `/dashboard/db-health/status` | DB 성능 진단 쿼리 실행 |

쿼리 파라미터:

| 파라미터 | 필수 | 설명 |
|----------|------|------|
| `connection_id` | O | `connections[].id` 값 |
| `category` | O | `slow_queries` / `tablespace` / `locks` |
| `timeout_sec` | X | 타임아웃 초 (기본 10, 최대 60) |

### 10.9 네트워크 테스트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/dashboard/network-test` | Ping 또는 TCP 연결(Telnet) 테스트 (단건) |
| POST | `/dashboard/network-test-batch` | 다중 타겟 Ping/Telnet 테스트 (배치) |

**요청 body:**

```json
{
    "type": "ping",       // "ping" 또는 "telnet"
    "host": "192.168.0.71",
    "port": 322,          // telnet일 때 필수
    "count": 4,           // ping 횟수 (기본 4, 최대 10)
    "timeout": 5          // 초 (기본 5, 최대 30)
}
```

**응답 예시 (Ping):**

```json
{
    "type": "ping",
    "host": "192.168.0.71",
    "count": 4,
    "success": true,
    "responseTimeMs": 1234,
    "output": "Reply from 192.168.0.71: bytes=32 time<1ms TTL=64\n...",
    "message": "Ping successful"
}
```

**응답 예시 (Telnet):**

```json
{
    "type": "telnet",
    "host": "192.168.0.71",
    "port": 322,
    "success": true,
    "responseTimeMs": 15,
    "message": "Connection successful"
}
```

**배치 요청 body (`/dashboard/network-test-batch`):**

```json
{
    "targets": [
        { "type": "ping", "host": "192.168.0.71", "count": 4, "timeout": 5 },
        { "type": "telnet", "host": "192.168.0.71", "port": 322, "timeout": 5 }
    ]
}
```

배치 응답은 `results` 배열로 각 타겟의 결과를 동일 순서로 반환합니다.

### 10.10 서버 리소스 모니터링

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/dashboard/server-resources` | CPU/Memory/Disk 사용률 수집 (단건) |
| POST | `/dashboard/server-resources-batch` | 다중 서버 리소스 수집 (배치) |

**요청 body (Linux 원격 서버):**

```json
{
    "os_type": "linux-rhel8",
    "host": "192.168.0.71",
    "username": "sshuser",
    "password": "sshpass",
    "port": 322
}
```

**요청 body (로컬 Windows):**

```json
{
    "os_type": "windows",
    "host": "localhost"
}
```

**요청 body (Windows WinRM 원격 서버):**

```json
{
    "os_type": "windows-winrm",
    "host": "192.168.0.100",
    "username": "Administrator",
    "password": "winpass",
    "port": 5985,
    "domain": "MYDOMAIN",
    "transport": "ntlm"
}
```

> - `port`: WinRM 포트 (기본 5985=HTTP, 5986=HTTPS)
> - `transport`: 인증 방식 — `ntlm`(기본), `basic`, `kerberos`, `credssp`
> - `domain`: 도메인 지정 시 `DOMAIN\username` 형태로 인증

**응답 예시:**

```json
{
    "osType": "linux-rhel8",
    "host": "192.168.0.71",
    "cpu": { "usedPct": 23.5 },
    "memory": {
        "totalGb": 31.25,
        "usedGb": 18.72,
        "usedPct": 59.9
    },
    "disks": [
        { "mount": "/", "totalGb": 50.0, "usedGb": 32.1, "usedPct": 64.0 },
        { "mount": "/data", "totalGb": 200.0, "usedGb": 145.3, "usedPct": 72.0 }
    ],
    "error": null
}
```

| os_type 값 | 설명 |
|------------|------|
| `windows` | Windows 서버 (로컬: WMI, 원격: WMI /node) |
| `windows-ssh` | Windows 서버 (SSH + PowerShell, paramiko) |
| `windows-winrm` | Windows 서버 (WinRM + PowerShell, pywinrm) |
| `linux-rhel8` | RHEL 8.x / CentOS 8.x |
| `linux-rhel7` | RHEL 7.x / CentOS 7.x |
| `linux-ubuntu24` | Ubuntu 24.04 |
| `linux-generic` | 범용 Linux (Ubuntu, Debian 등) |

**배치 요청 body (`/dashboard/server-resources-batch`):**

```json
{
    "servers": [
        { "os_type": "linux-rhel8", "host": "192.168.0.71", "username": "sshuser", "password": "sshpass", "port": 322 },
        { "os_type": "windows", "host": "localhost" },
        { "os_type": "windows-winrm", "host": "192.168.0.100", "username": "Administrator", "password": "winpass", "port": 5985 }
    ]
}
```

배치 응답은 `results` 배열로 각 서버의 결과를 동일 순서로 반환합니다.

### 10.11 Health-Check 프록시

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/dashboard/health-check-proxy` | 외부 URL HTTP GET 프록시 (CORS 우회, 단건) |
| POST | `/dashboard/health-check-proxy-batch` | 다중 URL HTTP GET 프록시 (배치) |

**배치 요청 body (`/dashboard/health-check-proxy-batch`):**

```json
{
    "urls": [
        { "id": "svc1", "url": "https://example.com/health", "timeout": 5 },
        { "id": "svc2", "url": "https://api.example.com/status", "timeout": 5 }
    ]
}
```

배치 응답은 `results` 배열로 각 URL의 결과를 동일 순서로 반환합니다.

### 10.12 로그 조회

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/logs` | 로그 조회 |
| GET | `/logs/available-dates` | 로그 파일이 존재하는 날짜 목록 |

`/logs` 쿼리 파라미터:

| 파라미터 | 설명 |
|----------|------|
| `start_date` | 시작일 (YYYY-MM-DD) |
| `end_date` | 종료일 (YYYY-MM-DD) |
| `max_lines` | 최대 행 수 (기본 1000, 1~10000 으로 clamp) |
| `cursor` | 페이지네이션 커서 |
| `follow_latest` | `true`이면 최신 로그부터 |

---

## 11. 환경 변수

`.env` 파일 또는 시스템 환경변수로 설정합니다. `config.json` 값보다 **우선 적용**됩니다.

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
| `MONITORING_CONFIG_PATH` | config.json 경로 오버라이드 | `(exe 옆 config.json)` |
| `FLASK_ENV` | Flask 실행 환경 | `development` |
| `DEBUG` | 디버그 모드 | `False` |
| `API_HOST` | 서버 바인드 주소 | `127.0.0.1` |
| `API_PORT` | 서버 포트 | `5000` |
| `API_RATE_LIMIT` | API 요청 제한 | `100/minute` |
| `CORS_ORIGINS` | 허용 CORS 출처 (쉼표 구분) | `http://127.0.0.1:3000` |
| `AUTH_USERNAME` | 로그인 계정 오버라이드 | config.json 값 |
| `AUTH_PASSWORD` | 로그인 비밀번호 오버라이드 | config.json 값 |
| `ADMIN_USERNAME` | 관리자 판별 사용자명 | `admin` |
| `JWT_SECRET_KEY` | JWT 서명 키 — **운영 필수 설정**. 기본값 그대로 사용 시 `FLASK_ENV != development` 환경에서 RuntimeError로 부팅 실패 | `default-secret-key` |
| `JWT_ALGORITHM` | JWT 알고리즘 | `HS256` |
| `JWT_EXPIRATION_HOURS` | JWT 만료 시간 (시간) | `24` |
| `LOG_LEVEL` | 로그 레벨 | `INFO` |
| `LOG_DIRECTORY` | 로그 디렉토리 | `logs` |
| `LOG_FILE_PREFIX` | 로그 파일 접두사 | `monitoring_backend` |
| `LOG_RETENTION_DAYS` | 로그 보관 일수 | `7` |
| `LOG_SLOW_QUERY_THRESHOLD_SEC` | 슬로우 쿼리 경고 기준 (초) | `10` |
| `DB_POOL_SIZE` | DB 연결 풀 크기 | `5` |
| `DB_POOL_TIMEOUT_SEC` | DB 풀 연결 타임아웃 (초) | `30` |
| `DB_POOL_RECYCLE_SEC` | DB 풀 연결 재활용 주기 (초) | `3600` |
| `CACHE_TTL_SEC` | 캐시 TTL (초) | `300` |
| `ENABLE_CACHE` | 캐시 활성화 여부 | `true` |
| `THREAD_POOL_SIZE` | 스레드 풀 크기 | `16` |

### 보안 권장 사항

운영 환경에서는 반드시 다음 환경변수를 설정하세요. `JWT_SECRET_KEY`는 기본값 사용 시 서버가 시작되지 않습니다:

```env
JWT_SECRET_KEY=your-very-long-random-secret-key-here
AUTH_USERNAME=your_admin_id
AUTH_PASSWORD=your_secure_password
```

---

## 12. 로그

### 로그 파일 위치

```text
logs/monigrid_be-YYYY-MM-DD.log
```

### 로그 설정 (config.json)

| 항목 | 설명 | 기본값 |
|------|------|--------|
| `logging.directory` | 로그 디렉토리 | `logs` |
| `logging.file_prefix` | 파일명 접두사 | `monigrid_be` |
| `logging.level` | 로그 레벨 (`DEBUG`/`INFO`/`WARN`/`ERROR`) | `INFO` |
| `logging.retention_days` | 자동 삭제 보관 일수 | `7` |
| `logging.slow_query_threshold_sec` | 슬로우 쿼리 경고 기준 (초) | `10` |

### 로그 형식 예시

```
2026-04-01 10:23:45,123 INFO  [monitoring_backend] JVM started successfully
2026-04-01 10:23:46,456 INFO  [monitoring_backend] Starting initial cache warm-up for 1 endpoints...
2026-04-01 10:23:47,789 INFO  [monitoring_backend] Cache refreshed apiId=status path=/api/status source=startup rows=42 durationSec=0.123 clientIp=scheduler
2026-04-01 10:23:47,790 INFO  [monitoring_backend] Initial cache warm-up completed.
2026-04-01 10:23:47,791 INFO  [monitoring_backend] Starting MonitoringBackend host=127.0.0.1 port=5000
```

슬로우 쿼리 경고:

```
2026-04-01 10:30:15,123 WARNING [monitoring_backend] Slow query apiId=metrics durationSec=12.5 threshold=10
```

---

## 13. 운영 가이드

### 13.1 일상 운영

| 작업 | 방법 |
|------|------|
| 설정 변경 후 적용 | `POST /dashboard/reload-config` (재시작 불필요) |
| SQL 쿼리 수정 | `sql/` 폴더의 파일 수정 후 reload-config |
| 캐시 즉시 갱신 | `POST /dashboard/cache/refresh` |
| 캐시 상태 확인 | `GET /dashboard/cache/status` |
| 새 DB 드라이버 추가 | `drivers/`에 JAR 복사 → `config.json` 수정 → EXE 재시작 |
| 로그 확인 | `GET /logs?follow_latest=true` 또는 `logs/` 폴더 직접 확인 |

### 13.2 새 API 엔드포인트 추가

1. `sql/` 폴더에 SQL 파일 생성 (예: `sql/new-report.sql`)
2. `config.json`의 `apis` 배열에 항목 추가:
   ```json
   {
       "id": "new-report",
       "rest_api_path": "/api/new-report",
       "connection_id": "mariadb-main",
       "sql_id": "new-report",
       "enabled": true,
       "refresh_interval_sec": 30
   }
   ```
3. `POST /dashboard/reload-config` 호출
4. 프론트엔드에서 위젯 추가 시 엔드포인트 URL: `http://<backend>/api/new-report`

### 13.3 새 DB 연결 추가

1. `drivers/` 폴더에 해당 DB의 JDBC JAR 배치
2. `config.json`의 `global_jdbc_jars`에 JAR 경로 추가 (세미콜론 구분)
3. `config.json`의 `connections` 배열에 연결 정보 추가
4. EXE **재시작** (JVM 클래스패스 변경은 재시작 필요)

### 13.4 서버 리소스 모니터링 설정

프론트엔드 위젯에서 직접 서버 접속 정보를 설정합니다 (백엔드 config.json에 설정 불필요).

- **Linux 서버**: SSH 접속 정보 필요 (호스트, 포트, 계정, 비밀번호)
- **Windows 서버 (WMI)**: 로컬은 자동, 원격은 WMI 접근 필요
- **Windows 서버 (WinRM)**: WinRM 접속 정보 필요 (호스트, 포트, 계정, 비밀번호, 도메인, transport)
- 백엔드에 `paramiko` 패키지가 설치되어 있어야 SSH 접속 가능
- 백엔드에 `pywinrm` 패키지가 설치되어 있어야 WinRM 접속 가능
- WinRM 대상 서버에서 `winrm quickconfig` 실행으로 WinRM 서비스가 활성화되어 있어야 함

### 13.5 백업 & 복원

| 백업 대상 | 파일/폴더 |
|-----------|-----------|
| 설정 | `config.json` |
| SQL 쿼리 | `sql/` 폴더 전체 |
| 드라이버 | `drivers/` 폴더 전체 |
| 로그 | `logs/` 폴더 (선택) |

복원: 백업한 파일/폴더를 `dist/` 아래에 덮어쓰기 후 EXE 재시작

---

## 14. IIS 단일 사이트 배포 (Frontend + Backend 같은 포트)

Windows IIS 환경에서 **프론트엔드와 백엔드를 하나의 사이트(같은 포트)로 통합 배포**할 때 백엔드가 어떻게 동작해야 하는지 설명합니다.

> **전체 구성과 IIS web.config 작성법은 프론트엔드 README의 "7. IIS 단일 사이트 배포" 섹션을 참조하세요.**
> 이 섹션은 백엔드 측면에서 필요한 설정과 주의사항만 다룹니다.

### 14.1 배포 구조 개요

```
다른 PC 브라우저
  → IIS (서버:80)                           ← 외부 노출
       │
       ├─ 정적 파일 (frontend dist/)        ← IIS 직접 서빙
       └─ /auth/*, /dashboard/*, /api/* 등  ← 리버스 프록시
              │
              ▼
         Flask Backend (127.0.0.1:5000)     ← 서버 내부 (외부 노출 X)
```

이 구성에서 백엔드는 **서버 내부에서만 접근 가능**하면 충분합니다. 외부 방화벽에서 5000 포트를 열 필요가 없습니다.

### 14.2 백엔드 바인딩 설정 (`config.json`)

`config.json`의 `server.host`를 **127.0.0.1**(localhost)로 설정합니다.

```json
{
    "server": {
        "host": "127.0.0.1",
        "port": 5000,
        "query_timeout_sec": 30,
        "refresh_interval_sec": 5,
        "thread_pool_size": 16
    }
}
```

| 항목 | 값 | 이유 |
|------|----|------|
| `host` | `127.0.0.1` | 외부 네트워크에서 직접 접근 차단. IIS만 접근 가능 |
| `port` | `5000` | IIS web.config의 프록시 대상 포트와 일치해야 함 |

> **`0.0.0.0`으로 두면** 백엔드가 모든 인터페이스에서 LISTEN 됩니다. 외부 PC에서 `http://<서버IP>:5000`으로 직접 접근 가능해지므로, 단일 사이트 배포 의도에 어긋나고 보안상 권장하지 않습니다.

### 14.3 백엔드 실행 방법

IIS와 백엔드는 **별개의 프로세스**입니다. IIS가 백엔드를 자동으로 띄워주지 않으므로 별도로 실행해야 합니다.

**옵션 A: 콘솔 실행 (개발/테스트)**

```bash
cd monigrid-be
python monigrid_be.py
```

**옵션 B: PyInstaller EXE 실행 (운영)**

```bash
cd dist\monigrid-be
monigrid-be.exe
```

**옵션 C: Windows 서비스 등록 (운영 권장)**

[NSSM (Non-Sucking Service Manager)](https://nssm.cc/)을 사용하여 서비스로 등록하면 서버 부팅 시 자동 실행됩니다.

```bash
nssm install monigrid-be "D:\path\to\monigrid-be\dist\monigrid-be\monigrid-be.exe"
nssm set monigrid-be AppDirectory "D:\path\to\monigrid-be\dist\monigrid-be"
nssm set monigrid-be Start SERVICE_AUTO_START
nssm set monigrid-be AppStdout "D:\path\to\logs\stdout.log"
nssm set monigrid-be AppStderr "D:\path\to\logs\stderr.log"
nssm start monigrid-be
```

서비스 상태 확인:

```bash
sc query monigrid-be
nssm status monigrid-be
```

### 14.4 CORS 설정

IIS 단일 사이트 배포에서는 프론트엔드와 백엔드가 **같은 origin**(IIS 자체)이므로 **CORS가 필요 없습니다**.

기존 `monigrid_be.py`의 CORS 설정은 그대로 두어도 무방합니다 (요청이 같은 origin이면 CORS 헤더가 무시됨). 보안을 더 강화하려면 다음과 같이 origin을 제한할 수도 있습니다.

```python
CORS(
    app,
    resources={r"/*": {"origins": ["http://your-iis-host"]}},
    supports_credentials=False,
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)
```

### 14.5 클라이언트 IP 추적 (X-Forwarded-For)

기본 상태에서는 백엔드의 모든 요청 client IP가 `127.0.0.1`(IIS 자신)로 기록됩니다.
실제 사용자의 IP를 로그에 남기려면 다음 두 가지 작업이 필요합니다.

**1) IIS web.config에 X-Forwarded-For 헤더 추가**

```xml
<rewrite>
  <rules>
    <rule name="API - auth" stopProcessing="true">
      <match url="^auth/(.*)" />
      <serverVariables>
        <set name="HTTP_X_FORWARDED_FOR" value="{REMOTE_ADDR}" />
      </serverVariables>
      <action type="Rewrite" url="http://127.0.0.1:5000/auth/{R:1}" />
    </rule>
    <!-- 다른 규칙들도 동일하게 serverVariables 추가 -->
  </rules>
</rewrite>
```

> `<serverVariables>`의 `HTTP_X_FORWARDED_FOR` 변수를 IIS Manager의 **URL Rewrite → View Server Variables → Add** 메뉴에서 먼저 허용 목록에 등록해야 합니다.

**2) 백엔드의 클라이언트 IP 추출 함수가 X-Forwarded-For를 인식하는지 확인**

`app/utils.py`의 `get_client_ip()` 함수가 X-Forwarded-For 헤더를 우선 참조하면 됩니다. 일반적으로 다음과 같이 구현됩니다:

```python
def get_client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"
```

### 14.6 API 경로 접두어 (Rate Limit, 라우트 매칭)

백엔드의 라우트 경로(`/auth/*`, `/dashboard/*`, `/health`, `/logs`, `/api/*`)는 IIS의 web.config 프록시 규칙과 **1:1 대응**되어야 합니다. 백엔드에 새 라우트를 추가하면 web.config에도 해당 경로 프록시 규칙을 추가해야 합니다.

**예시 — `/metrics` 신규 추가 시:**

`monigrid_be.py`:

```python
@app.route("/metrics", methods=["GET"])
def metrics():
    ...
```

`web.config`:

```xml
<rule name="API - metrics" stopProcessing="true">
  <match url="^metrics$" />
  <action type="Rewrite" url="http://127.0.0.1:5000/metrics" />
</rule>
```

> 이 규칙이 없으면 IIS는 `/metrics` 요청을 정적 파일로 처리하려고 시도하다가 SPA fallback으로 빠져 `index.html`을 반환하게 됩니다.

### 14.7 동작 검증 (백엔드 측면)

**1) 백엔드 단독 LISTEN 확인**

```bash
netstat -an | findstr :5000
# TCP 127.0.0.1:5000 ... LISTENING  ← 이렇게 떠야 함
# TCP 0.0.0.0:5000 ... LISTENING    ← 이건 외부에 노출됨 (의도와 다름)
```

**2) 백엔드 직접 호출**

```bash
curl http://127.0.0.1:5000/health
```

**3) IIS를 통한 호출 (프록시 동작 확인)**

```bash
curl http://localhost/health
```

같은 응답이 나와야 합니다.

**4) 외부 PC에서 백엔드 직접 호출 → 실패해야 정상**

외부 PC에서 `http://<서버IP>:5000/health` 요청 시 **연결 거부**되어야 합니다 (`host: "127.0.0.1"` 설정 효과).

### 14.8 백엔드 측 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| IIS가 502 Bad Gateway 반환 | 백엔드가 죽어 있음 | `curl http://127.0.0.1:5000/health` 로 확인 후 재시작 |
| IIS가 500 반환, 백엔드 로그에 에러 | 백엔드 자체 오류 | `logs/monigrid_be_*.log` 확인 |
| 외부에서 5000 포트 직접 접근 가능 | `host: "0.0.0.0"`으로 설정됨 | `config.json`의 `server.host`를 `127.0.0.1`로 변경 후 재시작 |
| 백엔드 로그의 client IP가 모두 127.0.0.1 | X-Forwarded-For 미설정 | 14.5 참조 |
| Rate limit이 IIS 한 IP(127.0.0.1)로 묶여 모든 사용자가 차단됨 | X-Forwarded-For 미인식 | 14.5의 `get_client_ip()` 적용 |

---

## 15. 트러블슈팅

### 15.1 서버가 시작되지 않음

**증상**: 실행 시 바로 종료되거나 에러 출력

| 원인 | 해결 |
|------|------|
| Python 버전 부족 | `python --version`으로 3.13+ 확인 |
| JAVA_HOME 미설정 | `echo %JAVA_HOME%` 확인 → JDK 경로 설정 |
| JDK 미설치 | JDK 11+ 설치 (JRE만으로는 부족할 수 있음) |
| config.json 오류 | JSON 문법 확인 (쉼표, 중괄호 등) |
| 포트 충돌 | `config.json`의 `server.port` 변경 또는 기존 프로세스 종료 |

### 15.2 "Class org.mariadb.jdbc.Driver is not found"

**원인**: JVM 시작 시 JDBC 드라이버 JAR가 클래스패스에 포함되지 않음

**해결**:
1. `drivers/` 폴더에 해당 JAR 파일이 존재하는지 확인
2. `config.json`의 `global_jdbc_jars`에 JAR 경로가 올바르게 설정되어 있는지 확인
3. JAR 경로가 상대경로인 경우 `config.json` 기준 상대경로인지 확인
4. EXE 재시작 (JVM은 한 번 시작되면 클래스패스 변경 불가)

### 15.3 DB 연결 실패

**증상**: 캐시 갱신 실패, 500 에러

| 확인 사항 | 방법 |
|-----------|------|
| DB 서버 접속 가능 여부 | `telnet <host> <port>` 또는 프론트엔드 네트워크 테스트 위젯 |
| JDBC URL 형식 | DB 종류별 형식 확인 (oracle: `jdbc:oracle:thin:@//`, mariadb: `jdbc:mariadb://`) |
| 계정/비밀번호 | `config.json`의 `connections[].username/password` 확인 |
| 방화벽 | 백엔드 서버에서 DB 서버 포트 접근 허용 확인 |

**진단 방법**:
```bash
# 캐시 상태에서 에러 확인
curl -H "Authorization: Bearer <token>" http://127.0.0.1:5000/dashboard/cache/status
```

### 15.4 서버 리소스 모니터링 실패

**증상**: 위젯에 "ERROR" 표시 또는 N/A

| 원인 | 해결 |
|------|------|
| paramiko 미설치 | `pip install paramiko` 후 EXE 재빌드 |
| pywinrm 미설치 | `pip install pywinrm` 후 EXE 재빌드 |
| SSH 접속 실패 | 호스트/포트/계정 확인, 방화벽 확인 |
| SSH 포트가 기본(22)이 아닌 경우 | 위젯 설정에서 SSH 포트 지정 |
| WinRM 접속 실패 | 대상 서버에서 `winrm quickconfig` 실행 확인, 방화벽에서 5985/5986 포트 허용 확인 |
| WinRM 인증 실패 | 계정/비밀번호/도메인 확인, transport 설정 확인 (기본 NTLM) |
| 원격 서버에 `top` 명령이 없음 | `procps` 패키지 설치 (`yum install procps`) |

### 15.5 프론트엔드 연결 실패 (CORS)

**증상**: 브라우저 콘솔에 CORS 에러

**해결**:
1. `.env` 파일에 프론트엔드 URL 추가:
   ```env
   CORS_ORIGINS=http://127.0.0.1:3000,http://localhost:3000,http://프론트엔드IP:3000
   ```
2. 또는 `monigrid_be.py`의 CORS 설정 확인
3. EXE 재시작

### 15.6 JWT 토큰 만료

**증상**: 모든 API가 401 반환

**해결**: 프론트엔드에서 다시 로그인 (기본 24시간 유효)

### 15.7 로그 파일이 생성되지 않음

| 확인 사항 | 해결 |
|-----------|------|
| `logs/` 디렉토리 존재 여부 | 수동 생성 또는 EXE 재시작 |
| 디렉토리 쓰기 권한 | 권한 확인 (Windows: 관리자 실행) |
| `config.json`의 `logging.directory` 경로 | 올바른 상대/절대 경로인지 확인 |

### 15.8 EXE 빌드 실패

| 증상 | 해결 |
|------|------|
| `ModuleNotFoundError` | `monigrid_be.spec`의 `hiddenimports`에 누락 모듈 추가 |
| JAR 파일 누락 | `drivers/` 폴더 확인, `build_backend_exe.bat` 실행 |
| 빌드 후 실행 시 에러 | `dist/config.json`, `dist/sql/`, `dist/drivers/` 존재 확인 |

### 15.9 캐시가 갱신되지 않음

**해결**:
1. `GET /dashboard/cache/status`로 마지막 갱신 시각·에러 확인
2. `POST /dashboard/cache/refresh`로 수동 갱신 시도
3. 로그 파일에서 `Cache refresh failed` 검색
4. DB 연결 문제인 경우 `reset_connection: true` 옵션으로 강제 재연결

### 15.10 설정 DB `Connection is closed`

**증상**: `/api/*` 가 500 으로 응답하고 로그에 `java.sql.SQLNonTransientConnectionException: (conn=NN) Connection is closed` 기록됨 — 설정 DB(MariaDB 등) 의 `wait_timeout` 으로 유휴 연결이 서버 측에서 끊긴 경우입니다.

**해결**:
- v2.0+ 는 커서 발급 직전에 `Connection.isValid(2)` 로 상태를 확인하고 자동 재연결하므로, 재기동 없이 다음 요청부터 정상화됩니다.
- 반복적으로 발생하면 설정 DB 서버의 `wait_timeout` 을 늘리거나 네트워크 방화벽의 idle timeout 을 확인하세요.

---

## 16. initsetting.json (설정 DB 접속 정보)

설정 DB 에 접속하기 위한 부트스트랩 파일입니다. 실행 경로 기준으로 아래 위치에서 찾습니다(오버라이드: 환경변수 `MONITORING_INIT_SETTINGS_PATH`):

- **개발 모드**: `monigrid_be.py` 와 같은 폴더 (`monigrid-be/initsetting.json`)
- **onedir 빌드**: `monigrid-be.exe` 와 같은 폴더 (`dist/initsetting.json`)

### 16.1 예시 (MariaDB)

```json
{
    "settings_db": {
        "db_type": "mariadb",
        "jdbc_driver_class": "org.mariadb.jdbc.Driver",
        "jdbc_url": "jdbc:mariadb://192.168.0.71:3336/monigrid_db",
        "username": "monigrid",
        "password": "change-me",
        "jdbc_jars": ["drivers/mariadb-java-client-3.4.1.jar"]
    }
}
```

| 키 | 설명 |
|----|------|
| `db_type` | `oracle` / `mariadb` / `mssql` |
| `jdbc_driver_class` | JDBC 드라이버 클래스 FQCN |
| `jdbc_url` | JDBC 접속 URL |
| `username` / `password` | 설정 DB 계정 — **최초 기동 시 DDL 권한 필요** (테이블 자동 생성) |
| `jdbc_jars` | JDBC 드라이버 JAR 경로 배열 |

### 16.2 최초 기동 시 시드 동작

1. `initsetting.json` 로드 → JDBC 연결 수립
2. `monigrid_settings_meta.bootstrapped` 조회 → `true` 면 시드 건너뜀
3. `false` / 테이블 없음 → DDL 실행 후 `config.json` 및 `sql/*.sql` 내용을 각각 `monigrid_settings_kv` / `monigrid_connections` / `monigrid_apis` / `monigrid_sql_queries` 로 삽입
4. 시드 완료 시 원본을 `config.json.bak` / `sql.bak/` 로 rename

이후 기동부터는 파일이 읽히지 않으며, 운영 중의 모든 설정 변경은 대시보드 편집기 또는 `PUT /dashboard/config` / `PUT /dashboard/sql-editor/*` API 를 통해 설정 DB 에 기록됩니다.

### 16.3 방언 전환 / 다른 설정 DB 로 이관

설정 DB 를 Oracle / MariaDB / MSSQL 사이에서 옮기거나, 신규 환경에 기존 설정을 그대로 복사할 때는 `migrate_settings_db.py` 를 사용합니다.

```bash
# 현재 MariaDB → Oracle
python migrate_settings_db.py --from initsetting.json --to initsetting.oracle.json

# 현재 MariaDB → MSSQL
python migrate_settings_db.py --from initsetting.json --to initsetting.mssql.json
```

- `--from` / `--to` 모두 `initsetting.json` 과 동일한 스키마(`settings_db` 블록) 를 가진 JSON 파일이어야 합니다.
- 양 JSON 의 `jdbc_jars` 가 병합되어 **단일 JVM 클래스패스** 로 묶입니다. 양쪽 드라이버 JAR 를 모두 `drivers/` 에 두십시오.
- 대상 DB 에 `monigrid_*` 스키마가 없으면 `SettingsStore.create_schema()` 가 방언별 DDL 로 자동 생성합니다.
- 대상의 `monigrid_*` 테이블은 복사 전 **DELETE** 되며, 이후 원본의 `created_at` / `updated_at` 을 그대로 유지한 채 INSERT 됩니다.
- CLOB(Oracle) / LONGTEXT(MariaDB) / NVARCHAR(MAX)(MSSQL) 컬럼은 `_read_clob` 로 Python 문자열로 안전하게 unwrap 된 뒤 대상에 바인딩됩니다.

> ⚠️ 저장소에 커밋하지 마세요 — 모든 `initsetting*.json` 변종은 `.gitignore` 로 제외됩니다. 운영자는 각 환경에서 `initsetting.example.json` 을 복사해서 사용하거나, 로컬에 `initsetting.oracle.json` / `initsetting.mssql.json` 같은 대상 파일을 직접 작성한 뒤 이관 스크립트를 돌리면 됩니다.

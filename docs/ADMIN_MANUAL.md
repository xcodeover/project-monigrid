# MoniGrid 관리자 메뉴얼

## 목차

0. [설정 저장소 개요 (Settings DB)](#0-설정-저장소-개요-settings-db)
1. [시스템 구성](#1-시스템-구성)
2. [설치 및 배포](#2-설치-및-배포)
3. [설정 편집 (이전: config.json)](#3-설정-편집-이전-configjson)
4. [인증 및 보안](#4-인증-및-보안)
5. [Rate Limit 설정](#5-rate-limit-설정)
5-1. [Phase 2 운영 변경사항](#5-1-phase-2-운영-변경사항)
5-2. [Phase 3 운영 변경사항](#5-2-phase-3-운영-변경사항)
5-3. [Phase 4 운영 변경사항](#5-3-phase-4-운영-변경사항)
5-4. [일괄 저장](#5-4-일괄-저장-6)
6. [데이터베이스 연결 관리](#6-데이터베이스-연결-관리)
7. [데이터 API 관리](#7-데이터-api-관리)
8. [SQL 편집기](#8-sql-편집기)
9. [백엔드 설정 편집기](#9-백엔드-설정-편집기)
10. [캐시 관리](#10-캐시-관리)
11. [로그 관리](#11-로그-관리)
12. [프론트엔드 환경 변수](#12-프론트엔드-환경-변수)
13. [백엔드 환경 변수](#13-백엔드-환경-변수)
14. [운영 가이드](#14-운영-가이드)
15. [문제 해결](#15-문제-해결)
16. [사용자 계정 관리](#16-사용자-계정-관리)
17. [사용자 환경설정](#17-사용자-환경설정)
18. [서버 리소스 / 네트워크 체크 (모니터 대상)](#18-서버-리소스--네트워크-체크-모니터-대상)
19. [설정 DB 이관](#19-설정-db-이관)

---

## 0. 설정 저장소 개요 (Settings DB)

백엔드 설정·DB 연결 정의·API 엔드포인트·SQL 쿼리는 모두 **공유 설정 DB**에 저장됩니다. Active-Active 배포 시 두 노드가 동일 설정을 바라보도록 하기 위함입니다.

### 0.1 파일 vs 테이블

| 과거 (v1.x) | 현재 (v2.0+) |
|-------------|--------------|
| `config.json` (파일) | `monigrid_settings_kv` / `monigrid_connections` / `monigrid_apis` (테이블) |
| `sql/*.sql` (파일) | `monigrid_sql_queries` (테이블) |
| 환경변수 로그인 (파일) | `monigrid_users` (테이블, bcrypt 해시) — 환경변수는 부트스트랩 폴백으로만 동작 |
| 브라우저 로컬 스토리지 (UI) | `monigrid_user_preferences` (테이블, 사용자별 JSON) |
| 위젯 자체 호스트/자격증명/URL | `monigrid_monitor_targets` (테이블, server_resource / network / http_status 타입의 중앙 수집기 카탈로그) |

`config.json` 과 `sql/*.sql` 파일은 **최초 기동 시 1회만** 설정 DB로 시드(seed)되며, 이후 `.bak` 으로 이름이 바뀌고 더 이상 읽히지 않습니다. v2.1+ 에서 추가된 `monigrid_users` / `monigrid_user_preferences` / `monigrid_monitor_targets` 테이블도 동일 DB 에 자동 생성됩니다.

### 0.2 설정 DB 접속 정보 — `initsetting.json`

부트스트랩 파일 [`monigrid-be/initsetting.json`](../monigrid-be/initsetting.json) 에 설정 DB(Oracle / MariaDB / MSSQL) 접속 정보를 기록합니다.

```json
{
    "settings_db": {
        "db_type": "mariadb",
        "jdbc_driver_class": "org.mariadb.jdbc.Driver",
        "jdbc_url": "jdbc:mariadb://192.168.0.71:3336/monigrid_db",
        "username": "monigrid",
        "password": "****",
        "jdbc_jars": ["drivers/mariadb-java-client-3.4.1.jar"]
    }
}
```

| 키 | 설명 |
|----|------|
| `db_type` | `oracle` / `mariadb` / `mssql` |
| `jdbc_driver_class` | JDBC 드라이버 클래스명 |
| `jdbc_url` | JDBC 접속 URL |
| `username` / `password` | 설정 DB 접속 계정 (스키마에 DDL 권한 필요 — 최초 기동 시 테이블을 자동 생성) |
| `jdbc_jars` | JDBC 드라이버 JAR 경로 배열 |

환경변수 `MONITORING_INIT_SETTINGS_PATH` 로 경로를 오버라이드할 수 있습니다.

### 0.3 최초 기동 시 동작

1. `initsetting.json` 로드 → 설정 DB에 연결
2. `monigrid_settings_meta.bootstrapped = true` 확인
3. 미부트스트랩 상태면 `monigrid_*` 테이블 DDL 실행 + `config.json` / `sql/*.sql` 데이터를 설정 DB로 시드
4. `config.json` → `config.json.bak`, `sql/` → `sql.bak/` 로 이름 변경

### 0.4 설정 변경

- **대시보드 → 백엔드 설정 편집기** — Connections / APIs / 개별 섹션을 편집, 저장 시 `monigrid_*` 테이블에 즉시 반영 + 양 노드에 핫 리로드
- **대시보드 → SQL 편집기** — `monigrid_sql_queries` 에 저장, 저장 즉시 엔드포인트 캐시가 갱신됨

### 0.5 연결 복구

- **설정 DB** — `wait_timeout` 등으로 끊겨도 다음 호출 시 lazy retry 로 재연결합니다 (한 번 실패해도 다음 호출에서 다시 시도).
- **대상 DB JDBC 풀** — 풀에서 커넥션을 꺼낼 때 `Connection.isValid(2)` 로 stale 여부를 검증하고 stale 이면 즉시 폐기 후 새 커넥션을 발급합니다. 새 커넥션 생성은 백오프 재시도(기본 3회) 로 일시적 단절을 흡수합니다.
- **결론** — 설정 DB / 대상 DB 모두 백엔드 재기동 없이 단절 → 다음 요청부터 자동 정상화됩니다. 반복 발생 시 DB 의 `wait_timeout` 또는 방화벽 idle timeout 을 점검하세요.

---

## 1. 시스템 구성

### 1.1 아키텍처

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│   브라우저    │────▶│   IIS (프록시)     │────▶│  Flask 백엔드 │
│  (React SPA) │◀────│   정적 파일 서빙    │◀────│  (Python)     │
└──────────────┘     └───────────────────┘     └──────┬───────┘
                                                      │
                                          ┌───────────┼───────────┐
                                          ▼           ▼           ▼
                                     ┌────────┐ ┌────────┐ ┌────────┐
                                     │ Oracle │ │MariaDB │ │ MSSQL  │
                                     └────────┘ └────────┘ └────────┘
                                          ▲           ▲
                                          │   JDBC    │
                                          └───────────┘
```

### 1.2 기술 스택

| 구성 요소 | 기술 |
|----------|------|
| **프론트엔드** | React + Vite + Zustand + Recharts |
| **백엔드** | Python Flask + Waitress (WSGI) |
| **DB 연결** | JayDeBeApi (JDBC over Python) |
| **인증** | JWT (HS256) |
| **Rate Limit** | Flask-Limiter (in-memory) |
| **원격 서버 수집** | paramiko (SSH), pywinrm (WinRM) |

### 1.3 디렉토리 구조

```
monigrid-be/
├── initsetting.json     # 설정 DB 접속 정보 (부트스트랩)
├── monigrid_be.py       # 서버 진입점
├── .env                 # 환경 변수 (선택)
├── config.json.bak      # 최초 시드 후 백업 (더 이상 읽히지 않음)
├── sql.bak/             # 최초 시드 후 백업 (더 이상 읽히지 않음)
├── drivers/             # JDBC 드라이버 JAR 파일
│   ├── ojdbc11.jar
│   ├── mariadb-java-client-3.4.1.jar
│   └── mssql-jdbc-12.8.1.jre11.jar
├── logs/                # 로그 파일 (자동 생성)
└── app/                 # 애플리케이션 코드

monigrid-fe/
├── .env.development     # 개발 환경 변수
├── .env.production      # 운영 환경 변수
├── .env.iis             # IIS 배포용 환경 변수
└── src/                 # 프론트엔드 소스
```

---

## 2. 설치 및 배포

### 2.1 개발 환경 실행

**백엔드**:
```bash
cd monigrid-be
pip install -r requirements.txt
python monigrid_be.py
# 서버 시작: http://127.0.0.1:5000
```

**프론트엔드**:
```bash
cd monigrid-fe
npm install
npm run dev
# 개발 서버: http://127.0.0.1:5173
```

### 2.2 프로덕션 빌드

**프론트엔드 빌드**:
```bash
# 일반 빌드 (별도 백엔드 서버)
npm run build

# IIS same-origin 빌드 (프록시 환경)
npm run build:iis
```

빌드 결과물은 `dist/` 폴더에 생성됩니다.

**백엔드 EXE 패키징**:
```bash
cd monigrid-be
pyinstaller --noconfirm --clean monigrid_be.spec
# 결과: dist/monigrid-be/monigrid-be.exe
```

### 2.3 Windows 서비스 등록

NSSM(Non-Sucking Service Manager)을 사용하여 Windows 서비스로 등록합니다:

```bash
nssm install monigrid-be "C:\monitoring\monigrid-be.exe"
nssm set monigrid-be AppDirectory "C:\monitoring"
nssm start monigrid-be
```

### 2.4 IIS 프록시 설정

IIS에서 ARR(Application Request Routing)을 사용하여 백엔드를 프록시합니다:

- `/api/*`, `/dashboard/*`, `/auth/*`, `/health`, `/logs` → Flask 백엔드 (127.0.0.1:5000)
- 나머지 경로 → 정적 프론트엔드 파일

> IIS 프록시 환경에서는 `X-Forwarded-For` 헤더가 자동 전달되어야 Rate Limit이 클라이언트별로 올바르게 적용됩니다.

---

## 3. 설정 편집 (이전: config.json)

> **v2.0+ 부터 설정은 `config.json` 파일이 아닌 공유 설정 DB (`monigrid_*` 테이블) 에 저장됩니다.** 아래 구조는 대시보드 **설정 편집기** 에 나타나는 논리적 구조입니다. 파일명 `config.json` 은 **최초 기동 시에만** 시드 용도로 읽히며, 이후 `config.json.bak` 으로 이름이 바뀝니다. 상세는 [섹션 0](#0-설정-저장소-개요-settings-db) 을 참조하세요.

### 3.1 전체 구조 (설정 편집기의 탭 구성)

```json
{
    "version": "2.0.0",
    "server": { ... },
    "auth": { ... },
    "rate_limits": { ... },
    "logging": { ... },
    "sql_validation": { ... },
    "global_jdbc_jars": "...",
    "connections": [ ... ],
    "apis": [ ... ]
}
```

### 3.2 server 섹션

```json
"server": {
    "host": "127.0.0.1",
    "port": 5000,
    "thread_pool_size": 16,
    "refresh_interval_sec": 5,
    "query_timeout_sec": 30
}
```

| 키 | 기본값 | 설명 |
|----|--------|------|
| `host` | `0.0.0.0` | 서버 바인딩 주소 |
| `port` | `5000` | 서버 포트 |
| `thread_pool_size` | `8` | Waitress 워커 스레드 수 |
| `refresh_interval_sec` | `5` | 캐시 자동 갱신 주기 (초) |
| `query_timeout_sec` | `10` | SQL 쿼리 기본 타임아웃 (초) |

### 3.3 auth 섹션

```json
"auth": {
    "username": "admin",
    "password": "admin"
}
```

| 키 | 설명 |
|----|------|
| `username` | 로그인 사용자명 (환경변수 `AUTH_USERNAME`으로 오버라이드 가능) |
| `password` | 로그인 비밀번호 (환경변수 `AUTH_PASSWORD`으로 오버라이드 가능) |

> **운영 환경에서는 반드시 기본 비밀번호를 변경하세요.**

### 3.4 logging 섹션

```json
"logging": {
    "directory": "logs",
    "file_prefix": "monigrid_be",
    "level": "INFO",
    "retention_days": 7,
    "slow_query_threshold_sec": 10
}
```

| 키 | 기본값 | 설명 |
|----|--------|------|
| `directory` | `logs` | 로그 파일 저장 디렉토리 (상대/절대 경로) |
| `file_prefix` | `monitoring_backend` | 로그 파일명 접두사 |
| `level` | `INFO` | 로그 레벨 (`DEBUG`, `INFO`, `WARN`, `ERROR`) |
| `retention_days` | `7` | 로그 보관 일수 (이전 파일 자동 삭제) |
| `slow_query_threshold_sec` | `10` | 이 시간을 초과하는 쿼리를 느린 쿼리로 기록 |

### 3.5 sql_validation 섹션

```json
"sql_validation": {
    "typo_patterns": {
        "where": ["whre", "wehre", "wher"],
        "order_by": ["oder", "odrer"],
        "group_by": ["gorup", "gruop"],
        "having": ["havng", "hvaing"],
        "join": ["jion", "joim"]
    }
}
```

SQL 편집기에서 오타를 감지하기 위한 패턴입니다. 조직에 맞게 추가/제거할 수 있습니다.

---

## 4. 인증 및 보안

### 4.1 JWT 설정

환경변수로 JWT 관련 설정을 합니다:

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| `JWT_SECRET_KEY` | `default-secret-key` | JWT 서명 키 (**운영 환경에서 반드시 변경**) |
| `JWT_ALGORITHM` | `HS256` | JWT 알고리즘 |
| `JWT_EXPIRATION_HOURS` | `24` | 토큰 유효 시간 |

### 4.2 로그인 처리 순서 (DB-first)

로그인 요청은 다음 순서로 검증됩니다:

1. **`monigrid_users` 테이블 조회** — 해당 username 이 존재하면 `bcrypt.checkpw` 로 저장된 해시와 비교
2. **DB 계정이 일치하지 않을 때**, 그리고 **DB 에 admin 역할의 계정이 하나도 없을 때만** 환경변수(`AUTH_USERNAME` / `AUTH_PASSWORD`) 기반 부트스트랩 로그인이 허용됩니다
3. DB 에 admin 이 한 명이라도 생기는 순간 부트스트랩 로그인은 자동으로 비활성화됩니다 — 이는 신규 환경의 "최초 로그인 수단 확보" 와 운영 환경의 "환경변수 탈취만으로 관리자 권한 획득" 방지 양쪽을 동시에 달성하기 위한 규칙입니다.

> **운영 절차**: 최초 기동 직후 `POST /admin/users` 로 실제 관리자 계정을 생성하세요. 이후 환경변수 `AUTH_PASSWORD` 는 비워 두거나 랜덤 토큰으로 돌려 두셔도 문제 없습니다.

### 4.3 관리자 역할

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| `ADMIN_USERNAME` | `admin` | 환경변수 부트스트랩 로그인이 허용된 경우, 이 이름으로 로그인하면 admin 역할 부여 |

DB 기반 계정의 경우 `monigrid_users.role` 이 `admin` 이면 관리자 권한이 부여됩니다.

관리자 전용 기능:
- SQL 편집기 (`monigrid_sql_queries` 조회/수정)
- 백엔드 설정 편집기 (설정 DB 테이블 — DB 연결 / 데이터 API / 인증 / 로깅 / 서버 리소스 / 네트워크 체크 등)
  - 진입 시 현재 사용자 비밀번호 재확인이 필요합니다 (실수 진입/세션 탈취 방지). 검증 통과 시 토큰도 함께 갱신됩니다.
- 사용자 계정 관리 (`/admin/users`) — 섹션 16 참조
- 서버 리소스 / 네트워크 체크 대상 생성/수정/삭제 (`/dashboard/monitor-targets`) — 섹션 18 참조
- 설정 핫 리로드
- 캐시 수동 갱신

### 4.4 보안 체크리스트

- [ ] `JWT_SECRET_KEY`를 랜덤 문자열로 변경
- [ ] 기본 admin 계정 (`admin` / `admin`) 부트스트랩으로 최초 로그인 → 즉시 `/admin/users` 에서 실제 관리자 계정 생성
- [ ] 운영 환경에서 `AUTH_PASSWORD` 를 랜덤값으로 바꾸거나 비움 (DB admin 생성 후 부트스트랩은 자동 잠금)
- [ ] IIS에서 HTTPS 적용
- [ ] `CORS_ORIGINS`를 실제 프론트엔드 도메인으로 제한
- [ ] 방화벽에서 백엔드 포트(5000) 외부 직접 접근 차단
- [ ] `HEALTHCHECK_BLOCK_PRIVATE=1` 설정 검토 — health-check-proxy / `http_status` 타겟이 사설 IP 로 SSRF 되는 것을 차단하고 싶을 때 활성화

### 4.5 v2.3+ 보안 강화 요약

- **권한 누락 패치** — `/dashboard/reload-config`, `/dashboard/cache/refresh-all`, `reset_connection: true` 옵션은 admin 만 호출 가능. 단일 엔드포인트 캐시 리프레시(`api_id` 단건) 만 일반 사용자 허용.
- **에러 메시지 일반화** — dashboard / dynamic / monitor / admin_user 라우트의 4xx/5xx 응답에서 내부 예외 문자열 노출 제거. 상세는 백엔드 로그 파일에서 확인하세요.
- **WMI / 원격 명령** — `subprocess.run(... shell=False)` + argv list 로만 호출되어 호스트/계정/비밀번호가 셸 인자로 합쳐지지 않습니다. password injection 차단.
- **SQL 변경 로그 마스킹** — SQL 편집기 저장 로그에 쿼리 전문이 들어가지 않고 `sha256` prefix 만 기록됩니다.
- **per-endpoint 429 격리** — 한 위젯/엔드포인트의 429 가 전역 폴링을 멈추지 않도록 endpoint 별 cooldown 맵 사용.
- **JDBC 풀 동시성** — `service.reload()` 가 새 executor + 새 풀을 atomic swap 한 후 구 executor 를 drain → 구 풀을 닫는 순서를 따르므로 진행 중이던 쿼리가 끊기지 않습니다.

---

## 5. Rate Limit 설정

### 5.1 백엔드 Rate Limit (config.json)

`config.json`의 `rate_limits` 섹션에서 엔드포인트별 Rate Limit을 설정합니다. Flask-Limiter 형식(`"횟수/단위"`)을 사용합니다.

```json
"rate_limits": {
    "global_default": "200/minute",
    "auth_login": "10/minute",
    "dynamic_endpoint": "120/minute",
    "health_check": "60/minute",
    "health_check_batch": "60/minute",
    "network_test": "60/minute",
    "network_test_batch": "60/minute",
    "server_resources": "60/minute",
    "server_resources_batch": "60/minute",
    "monitor_refresh": "10/minute"
}
```

| 키 | 기본값 | 적용 대상 |
|----|--------|----------|
| `global_default` | `200/minute` | 명시적 limit이 없는 모든 엔드포인트 |
| `auth_login` | `10/minute` | `POST /auth/login` |
| `dynamic_endpoint` | `120/minute` | `GET /<path>` (데이터 조회 API) |
| `health_check` | `60/minute` | `POST /dashboard/health-check-proxy` |
| `health_check_batch` | `60/minute` | `POST /dashboard/health-check-proxy-batch` |
| `network_test` | `60/minute` | `POST /dashboard/network-test` |
| `network_test_batch` | `60/minute` | `POST /dashboard/network-test-batch` |
| `server_resources` | `60/minute` | `POST /dashboard/server-resources` |
| `server_resources_batch` | `60/minute` | `POST /dashboard/server-resources-batch` |
| `monitor_refresh` | `10/minute` | `POST /dashboard/monitor-snapshot/<id>/refresh` |

#### 형식 예시

```
"60/minute"      → 분당 60회
"10/second"      → 초당 10회
"1000/hour"      → 시간당 1000회
"5/minute;100/hour" → 분당 5회 AND 시간당 100회 (복합 조건)
```

### 5.2 Rate Limit 적용 방식

- **클라이언트 IP별** 독립 카운트 (`X-Forwarded-For` 헤더에서 실제 IP 추출)
- IIS 프록시 환경에서도 클라이언트별로 올바르게 분리됩니다.
- `rate_limits` 섹션이 없거나 특정 키가 없으면 내장 기본값이 적용됩니다.

### 5.3 프론트엔드 Rate Limit 관련 설정

`.env.development` / `.env.production` 파일에서 설정합니다:

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| `VITE_API_TIMEOUT_MS` | `10000` | API 요청 타임아웃 (ms) |
| `VITE_RETRY_ATTEMPTS` | `3` | 실패 시 최대 재시도 횟수 (429 제외) |
| `VITE_RETRY_DELAY_MS` | `1000` | 재시도 간 초기 대기 시간 (ms, 이후 2배 증가) |
| `VITE_RATE_LIMIT_WAIT_MS` | `10000` | 429 수신 시 Retry-After 헤더가 없을 때 대기 시간 (ms) |

> 프론트엔드는 429 에러를 수신하면 재시도하지 않고, `Retry-After` 헤더(또는 `VITE_RATE_LIMIT_WAIT_MS`) 기간 동안 모든 요청을 자동 대기시킵니다.

### 5.4 Rate Limit 튜닝 가이드

위젯 수와 갱신 주기에 따라 적절한 limit을 설정합니다:

```
분당 요청 수 = (위젯 수) × (60 / 갱신주기초)

예: 테이블 위젯 10개, 갱신 주기 5초
   → 10 × (60/5) = 120 요청/분
   → dynamic_endpoint를 최소 "120/minute" 이상으로 설정
```

여러 사용자가 동시 접속하는 환경에서는 IP별로 카운트되므로 개별 사용자 기준으로 계산합니다.

---

## 5-1. Phase 2 운영 변경사항

Phase 2(BE 안정성 강화) 에서 도입된 운영자 가시성 변경 사항 3가지를 정리합니다.

### HTTP 504 — 동적 엔드포인트 쿼리 타임아웃

`GET /<dynamic_path>` 호출 시 JDBC 쿼리 타임아웃 또는 coalesce 대기 타임아웃이 발생하면 이전(500) 대신 **HTTP 504**가 반환됩니다. 응답 본문은 `{"message": "...", "apiId": "<api_id>", "detail": "..."}` 형식입니다. 504 수신 시 `query_timeout_sec` 설정과 해당 DB 쿼리 실행 계획을 점검하세요.

### WARNING 로그 — `setQueryTimeout 실패`

JDBC 드라이버가 `Statement.setQueryTimeout()` 을 지원하지 않을 때(일부 구버전 Oracle thin / 비표준 드라이버) 백엔드 로그에 `setQueryTimeout 실패` WARNING 이 기록됩니다. 쿼리 자체는 계속 실행되며 Python 측 Future 타임아웃이 대체 적용됩니다. **주류 드라이버(ojdbc11, mariadb-java-client, mssql-jdbc)에서 이 메시지가 보이면 드라이버 버전을 점검하세요**; 구버전 비표준 드라이버에서는 무시해도 무방합니다.

### 네트워크 핑 응답 — `"limited": true` 필드

`POST /dashboard/network-test` (단건) 및 배치 응답에서 핑 횟수 상한 또는 벽시계 시간 상한에 의해 수집이 조기 종료된 경우 응답에 `"limited": true` 필드가 추가됩니다. 진단용 대량 핑 테스트(`count` 값이 큰 요청) 시 이 필드가 보이면 count 또는 timeout 설정을 낮추거나 Rate Limit(`network_test`) 을 조정하세요.

---

## 5-2. Phase 3 운영 변경사항

Phase 3(FE 부하 감소) 에서 도입된 운영자 가시성 변경 사항 2가지를 정리합니다.

### 탭 hidden 시 위젯 폴링 일시 정지

브라우저 탭이 백그라운드로 전환되면(`document.visibilityState === 'hidden'`) 모든 위젯의 폴링이 자동으로 일시 정지됩니다. 탭이 다시 활성화되는 순간 즉시 재개됩니다.

- **운영자 주의**: 백그라운드 탭으로 모니터링하는 경우, 알람 감지가 최대 해당 위젯의 갱신 주기만큼 지연될 수 있습니다 (예: 5초 주기 위젯 → 최대 5초, 30초 주기 위젯 → 최대 30초).
- 백그라운드 탭에서 실시간 감시가 필요한 운영자는 해당 탭을 포그라운드 상태로 유지하거나, 별도 전용 모니터 화면을 사용하세요.

### BE 장애 시 폴링 Exponential Backoff

백엔드 응답이 연속으로 실패하면 프론트엔드 폴링 주기가 자동으로 연장됩니다: 기본 주기 → ×2 → ×4 → … → 최대 5분(300초) 상한.

- **운영자 주의**: BE 복구 후에도 최대 5분까지 위젯이 이전 실패 상태를 표시할 수 있습니다.
- 빠른 복구 확인이 필요하면 해당 위젯의 **새로고침(↺) 버튼**을 수동으로 클릭하면 backoff 카운터가 초기화되고 즉시 재폴링됩니다.

---

## 5-3. Phase 4 운영 변경사항

Phase 4(IO/UX 개선) 에서 도입된 운영자 가시성 변경 사항 3가지를 정리합니다.

### 5-3-1. 로그 뷰어 LIVE 모드 개선 (Task 4.1 + 4.3)

- **BE**: "실시간 모니터링" 체크 시 마지막 폴링 이후 추가된 바이트만 read합니다 (이전: 매 5초 전체 파일 재독). byte-offset 방식으로 대용량 로그(수 GB)에서도 폴링 부하가 일정합니다.
- 자정 날짜 전환 및 로그 파일 truncation(크기 감소)을 자동 감지하여 cursor를 reset합니다.
- **FE**: 최대 1만 라인을 react-window 가상 스크롤로 렌더링 — 대용량 로그에서도 브라우저 메모리 사용이 크게 감소합니다.

### 5-3-2. refresh-all 병렬화 (Task 4.2)

- `POST /dashboard/cache/refresh` 호출 시 body 에 `api_id` 가 없으면 모든 endpoint 가 **병렬**로 새로고침됩니다 (이전: N개 순차 직렬, 최대 N×60초 소요).
- Overall timeout: `max(120, N×5)` 초. Timeout 도달 시 응답의 `refreshedCount` 가 전체 endpoint 수보다 작을 수 있으며, 이는 일부 쿼리가 여전히 진행 중임을 의미합니다.

### 5-3-3. 알림 이력 자동 갱신 (Task 4.4)

- 알림 이력 페이지가 **30초마다 자동 갱신**되어 새 incident 가 즉시 반영됩니다.
- 브라우저 탭이 백그라운드(`hidden`) 상태일 때는 폴링이 일시 정지됩니다 (Phase 3 패턴 적용). 탭 활성화 시 즉시 재개됩니다.

---

## 5-4. 일괄 저장 (#6)

### 5-4-1. 모니터 대상 / 데이터 API 일괄 저장

- **백엔드 설정 → 모니터 대상 탭 / 데이터 API 탭** 의 항목 변경/추가/삭제는 이제 **하단 "저장 & 적용" 버튼 1회** 로 일괄 반영됩니다.
- 이전: 항목별 저장 버튼을 매번 눌러야 했고, 매번 backend reload 가 트리거되어 N개 변경 시 N×수십초 소요.
- 변경 사항은 시각적으로 표시:
  - 신규: `+ 녹색 좌측 바`
  - 수정: `● 노란 점`
  - 삭제 예정: 회색 + 취소선 + `↺ 복원` 버튼 (실제 삭제는 저장 시점)
- 삭제 예정 항목은 리스트 맨 아래로 자동 정렬됩니다.
- atomic 트랜잭션 — 한 항목이라도 실패하면 **전체 롤백**, 응답에 `failedItem` 으로 어느 항목이 문제인지 안내됩니다.
- monitor 대상 batch 는 **단일 reload** 로 처리되어 이전 대비 압도적으로 빠릅니다 (예: 5건 변경 ~50초 → 1~3초).

### 5-4-2. 모달 닫기 가드

- 변경 사항이 있는 상태에서 **X 버튼 / Esc** 시도 시 confirm dialog: `"저장하지 않은 변경 사항 N건이 있습니다. 폐기하고 닫으시겠습니까?"`
- 모달 영역 바깥 클릭으로 닫히지 않습니다 (Phase A #5 와 동일 정책).
- 저장 진행 중에는 close 가 차단됩니다.

### 5-4-3. 신규 BE endpoint

| Endpoint | Method | Rate limit (KV key) |
|---|---|---|
| `/dashboard/monitor-targets/batch` | POST (admin) | `monitor_targets_batch` (default `10/minute`) |

기존 개별 endpoint (`POST/PUT/DELETE /dashboard/monitor-targets/<id>`) 는 호환을 위해 유지됩니다.

### 5-4-4. 새 rate limit 키

`monigrid_settings_kv` 의 `rate_limits` JSON 에 `monitor_targets_batch` 가 추가되었습니다. 기존 deployment 는 자동으로 default `"10/minute"` 로 fallback (안전한 backward compat).

### 5-4-5. 검증 정책

각 row 는 **입력 즉시** per-field 검증되어 invalid 면 빨간 테두리 표시. "저장 & 적용" 버튼은 항상 활성 — 시도 시 invalid 가 있으면 **첫 invalid row 로 자동 스크롤** + alert.

---

## 6. 데이터베이스 연결 관리

### 6.1 연결 설정

```json
"connections": [
    {
        "id": "oracle-main",
        "db_type": "oracle",
        "jdbc_driver_class": "oracle.jdbc.OracleDriver",
        "jdbc_url": "jdbc:oracle:thin:@//192.168.0.10:1521/XEPDB1",
        "username": "monitor",
        "password": "monitor_password"
    }
]
```

| 키 | 설명 |
|----|------|
| `id` | 고유 식별자 (API에서 참조) |
| `db_type` | DB 종류: `oracle`, `mariadb`, `mssql` |
| `jdbc_driver_class` | JDBC 드라이버 클래스명 |
| `jdbc_url` | JDBC 연결 URL |
| `username` | DB 사용자명 |
| `password` | DB 비밀번호 |
| `jdbc_jars` | 연결별 추가 JAR 경로 (선택) |
| `driver_args` | 추가 드라이버 인자 (선택) |

### 6.2 지원 데이터베이스

| DB 종류 | 드라이버 | JDBC URL 형식 |
|---------|---------|--------------|
| **Oracle** | `ojdbc11.jar` | `jdbc:oracle:thin:@//<host>:<port>/<service>` |
| **MariaDB / MySQL** | `mariadb-java-client-*.jar` | `jdbc:mariadb://<host>:<port>/<database>` |
| **MS SQL Server** | `mssql-jdbc-*.jar` | `jdbc:sqlserver://<host>:<port>;databaseName=<db>;encrypt=true;trustServerCertificate=true` |

### 6.3 JDBC 드라이버

- `global_jdbc_jars`: 모든 연결에 공통으로 적용되는 JAR 경로
- 연결별 `jdbc_jars`: 해당 연결에만 적용되는 추가 JAR 경로
- JAR 파일은 `drivers/` 디렉토리에 배치합니다.

```json
"global_jdbc_jars": "drivers/ojdbc11.jar;drivers/mariadb-java-client-3.4.1.jar;drivers/mssql-jdbc-12.8.1.jre11.jar"
```

### 6.4 DB 진단 기능

`GET /dashboard/db-health/status` 엔드포인트로 DB 상태를 진단할 수 있습니다:

| 카테고리 | 설명 | 지원 DB |
|---------|------|---------|
| `slow_queries` | 느린 쿼리 / 장시간 실행 쿼리 | Oracle, MariaDB, MSSQL |
| `tablespace` | 테이블스페이스 / 파일그룹 사용량 | Oracle, MariaDB, MSSQL |
| `locks` | 현재 락 및 블로킹 세션 | Oracle, MariaDB, MSSQL |

---

## 7. 데이터 API 관리

> **명칭 변경**: 기존 "API 엔드포인트" 는 v2.2+ 부터 UI/문서에서 **"데이터 API"** 로 통일되었습니다 (실체는 동일하게 `monigrid_apis` 테이블 + 사용자 정의 SQL → JSON 응답). 백엔드 설정 편집기의 탭 라벨도 "데이터 API" 입니다.

### 7.1 엔드포인트 추가

`config.json`의 `apis` 배열에 새 항목을 추가합니다 (또는 백엔드 설정 → **데이터 API** 탭에서 GUI 로 추가):

```json
"apis": [
    {
        "id": "server-status",
        "rest_api_path": "/api/server-status",
        "connection_id": "oracle-main",
        "sql_id": "server_status",
        "enabled": true,
        "refresh_interval_sec": 10,
        "query_timeout_sec": 30
    }
]
```

| 키 | 설명 |
|----|------|
| `id` | 고유 식별자 |
| `rest_api_path` | 프론트엔드에서 호출할 URL 경로 |
| `connection_id` | 사용할 DB 연결 ID (`connections[].id` 참조) |
| `sql_id` | SQL 파일명 (`sql/<sql_id>.sql`) |
| `enabled` | 활성화 여부 (`true`/`false`) |
| `refresh_interval_sec` | 캐시 자동 갱신 주기 (초). 미지정 시 `server.refresh_interval_sec` 사용 |
| `query_timeout_sec` | 쿼리 타임아웃 (초). 미지정 시 `server.query_timeout_sec` 사용 |

### 7.2 SQL 파일 작성

`sql/<sql_id>.sql` 파일을 생성합니다:

```sql
-- sql/server_status.sql
SELECT
    host_name,
    cpu_usage,
    memory_usage,
    disk_usage,
    last_check_time
FROM v_server_status
ORDER BY host_name
```

**제한 사항**:
- `SELECT` / `WITH ... SELECT` 문만 허용
- `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `ALTER`, `TRUNCATE` 금지
- `FOR UPDATE` 금지

### 7.3 핫 리로드

설정 변경 후 서버를 재시작하지 않고 적용할 수 있습니다:

- **프론트엔드**: 설정 편집기에서 저장 시 자동 리로드
- **API**: `POST /dashboard/reload-config` 호출

핫 리로드 시 반영되는 항목:
- DB 연결 설정
- API 엔드포인트 설정
- SQL 유효성 검사 규칙
- Rate Limit 설정 (단, 글로벌 기본값은 서버 시작 시에만 적용)

핫 리로드로 반영되지 않는 항목 (서버 재시작 필요):
- `server.host` / `server.port`
- `server.thread_pool_size`
- JWT 관련 설정

---

## 8. SQL 편집기

관리자 전용 기능으로, 대시보드 헤더의 **SQL 편집기** 버튼에서 접근합니다.

### 8.1 기능

- 활성화된 API 엔드포인트 목록 조회
- 엔드포인트별 SQL 쿼리 조회/수정
- SQL 구문 하이라이팅
- 실시간 유효성 검사 (금지 구문, 오타 감지) — MariaDB/MSSQL 은 `FROM` 없는 SELECT 허용, Oracle 만 `FROM DUAL` 요구
- 저장 시 `monigrid_sql_queries` 에 즉시 반영 및 캐시 갱신 (A-A 양 노드)

### 8.2 유효성 검사 규칙

| 규칙 | 설명 |
|------|------|
| SELECT 전용 | SELECT 또는 WITH ... SELECT만 허용 |
| DML 차단 | INSERT, UPDATE, DELETE 등 데이터 변경문 차단 |
| DDL 차단 | CREATE, DROP, ALTER, TRUNCATE 등 스키마 변경문 차단 |
| FOR UPDATE 차단 | 행 잠금 방지 |
| 오타 감지 | 설정 DB `sql_validation.typo_patterns` 에 정의된 패턴 |
| FROM 절 | Oracle 만 강제, MariaDB/MSSQL 은 `SELECT NOW()` 등 허용 |

### 8.3 API 엔드포인트

| 메서드 | 경로 | 설명 |
|-------|------|------|
| `GET` | `/dashboard/sql-editor/endpoints` | 편집 가능한 엔드포인트 목록 |
| `GET` | `/dashboard/sql-editor/<api_id>` | SQL 조회 (`monigrid_sql_queries`) |
| `PUT` | `/dashboard/sql-editor/<api_id>` | SQL 수정 및 캐시 갱신 |
| `GET` | `/dashboard/sql-editor/files` | SQL 엔트리 목록 |
| `POST` | `/dashboard/sql-editor/files` | 새 SQL 엔트리 생성 |

---

## 9. 백엔드 설정 편집기

관리자 전용 기능으로, 대시보드 헤더의 **백엔드 설정**(`⚙` 슬라이더 아이콘) 버튼에서 접근합니다.

### 9.1 진입 게이트 (비밀번호 재확인)

버튼을 눌러도 모달이 바로 열리지 않고 **비밀번호 확인 팝업**이 먼저 표시됩니다. 현재 로그인한 사용자의 비밀번호를 입력해 검증을 통과해야 편집기가 열립니다.

- 내부적으로 `/auth/login` 을 다시 한 번 호출하여 검증하며, 성공 시 토큰이 자동 갱신됩니다 (세션 연장 효과).
- 비밀번호 입력 칸은 우측 눈 모양 아이콘으로 평문 토글이 가능합니다.
- 자리 비움 후 누군가 admin 세션으로 백엔드 설정에 들어가는 사고를 방지하는 안전장치입니다.

### 9.2 탭 구성

편집기는 다음 탭으로 구성되며, 모두 설정 DB(`monigrid_*` 테이블) 상태를 직접 편집합니다.

| 탭 | 저장 위치 | 비고 |
|----|----------|------|
| **서버** | `monigrid_settings_kv` (`server`) | 일부 필드(host/port)는 표시만, 핫 리로드 불가 |
| **인증** | `monigrid_settings_kv` (`auth`) | 부트스트랩 계정 — DB 에 admin 이 생기면 자동 비활성 |
| **DB 연결** | `monigrid_connections` | 카드 단위, 복제(`Copy`)·삭제(`Trash`) 지원 |
| **데이터 API** | `monigrid_apis` | 카드 단위, 복제·삭제 지원. 대응 SQL 은 **SQL 편집기** 에서 관리 |
| **서버 리소스** | `monigrid_monitor_targets` (`type=server_resource`) | 즉시 저장. 카드 단위 추가/복제/삭제. 자세한 스키마는 [섹션 18](#18-서버-리소스--네트워크-체크-모니터-대상) |
| **네트워크 체크** | `monigrid_monitor_targets` (`type=network`) | 즉시 저장. 카드 단위 추가/복제/삭제 |
| **로깅** | `monigrid_settings_kv` (`logging`) | 디렉토리 / 레벨 / 보관일수 / 느린쿼리 임계 |
| **고급** | `monigrid_settings_kv` (`global_jdbc_jars`, `sql_validation`) | 글로벌 JDBC JAR · 오타 패턴 |
| **JSON** | (메모리만) | 위 전체 구조를 raw JSON 으로 일괄 편집 |

> **저장 흐름의 차이**: 서버/인증/DB 연결/데이터 API/로깅/고급/JSON 탭은 모달 푸터의 **저장 & 적용** 한 번으로 한꺼번에 커밋됩니다. 반면 **서버 리소스 / 네트워크 체크** 탭은 별도 엔드포인트(`/dashboard/monitor-targets`) 를 사용하므로, 카드 우측 하단의 **저장 / 추가** 버튼으로 카드 단위로 즉시 반영됩니다 (변경된 카드는 헤더에 `변경됨`, 신규 카드는 `신규` 배지).

### 9.3 카드 공통 동작

- **펼치기/접기** — 카드 헤더(또는 chevron) 클릭. 처음에는 모두 접힌 상태로 표시되어 화면이 길어지지 않습니다.
- **복제** — 헤더의 복사 아이콘. 바로 아래에 복사본을 생성하며 `id` / `rest_api_path` 등은 자동으로 고유 접미사가 붙습니다 (`db-01` → `db-02` → ...).
- **삭제** — 휴지통 아이콘. DB 연결 / 데이터 API 는 모달 닫지 않고 즉시 화면에서 제거되며, 푸터 저장 시 DB 에 반영. 모니터 대상은 즉시 백엔드 호출.

### 9.4 주의사항

- JSON 문법 오류가 있으면 저장이 차단됩니다.
- DB 비밀번호 등 민감 정보가 설정 DB 에 저장되므로 설정 DB 접근 권한을 엄격히 관리하세요.
- 변경 전 반드시 현재 설정을 백업하세요 (`mysqldump` / `expdp` / SSMS 백업 등).

---

## 10. 캐시 관리

### 10.1 캐시 동작 원리

백엔드는 각 API 엔드포인트의 쿼리 결과를 메모리에 캐싱합니다:

1. 서버 시작 시 모든 활성 엔드포인트를 병렬로 워밍업
2. `refresh_interval_sec` 주기로 백그라운드 자동 갱신
3. 프론트엔드 요청 시 캐시된 결과 반환 (DB 재조회 없음)
4. `?fresh=1` 파라미터 사용 시 캐시를 무시하고 즉시 쿼리 실행

### 10.2 캐시 상태 확인

```
GET /dashboard/cache/status
```

응답:
```json
{
    "endpoints": [
        {
            "apiId": "status",
            "lastUpdated": "2026-04-16T10:30:00",
            "durationMs": 45,
            "rowCount": 25,
            "error": null
        }
    ],
    "totalCount": 4,
    "healthyCount": 3
}
```

### 10.3 수동 캐시 갱신

```
POST /dashboard/cache/refresh
Body: { "api_id": "status", "reset_connection": false }
```

- `api_id` 생략 시: 전체 엔드포인트 갱신
- `reset_connection: true`: DB 연결 풀 재생성 후 갱신 (연결 문제 시 사용)

---

## 11. 로그 관리

### 11.1 로그 파일

- 위치: `logs/<file_prefix>-YYYY-MM-DD.log`
- 예: `logs/monigrid_be-2026-04-16.log`
- 일별 자동 로테이션
- `retention_days` 경과 후 자동 삭제

### 11.2 로그 레벨

| 레벨 | 용도 |
|------|------|
| `DEBUG` | 상세 디버깅 (HTTP 요청/응답 기록 포함) |
| `INFO` | 일반 운영 정보 (시작, 로그인, 설정 변경) |
| `WARN` | 경고 (느린 쿼리, 연결 실패 재시도) |
| `ERROR` | 오류 (쿼리 실패, 인증 오류, 예외) |

### 11.3 로그 조회 API

```
GET /logs?start_date=2026-04-16&end_date=2026-04-16&max_lines=1000
```

프론트엔드 로그 뷰어 페이지에서도 동일한 기능을 사용할 수 있습니다.

### 11.4 느린 쿼리 로그

`slow_query_threshold_sec`(기본 10초)를 초과하는 쿼리는 자동으로 WARNING 레벨로 기록됩니다:

```
2026-04-16 10:30:15 WARNING [endpoint_cache] Slow query apiId=status durationMs=12340 threshold=10000
```

---

## 12. 프론트엔드 환경 변수

`.env.development` / `.env.production` 파일에서 설정합니다.

### 12.1 필수 설정

| 변수 | 설명 | 예시 |
|------|------|------|
| `VITE_API_URL` | 백엔드 API 주소 | `http://192.168.0.52:5000` |
| `VITE_APP_TITLE` | 대시보드 타이틀 | `Monitoring Dashboard` |

> `VITE_API_URL`을 빈 문자열(`""`)로 설정하면 **same-origin 모드**로 동작합니다 (IIS 프록시 환경용).

### 12.2 갱신 관련 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `VITE_REFRESH_INTERVAL` | `5000` | 기본 갱신 주기 (ms) |
| `VITE_MIN_REFRESH_INTERVAL_SEC` | `5` | 위젯 갱신 주기 최솟값 (초) |
| `VITE_MAX_REFRESH_INTERVAL_SEC` | `3600` | 위젯 갱신 주기 최댓값 (초) |

### 12.3 네트워크 및 Rate Limit 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `VITE_API_TIMEOUT_MS` | `10000` | API 요청 타임아웃 (ms) |
| `VITE_RETRY_ATTEMPTS` | `3` | 실패 시 최대 재시도 횟수 |
| `VITE_RETRY_DELAY_MS` | `1000` | 재시도 초기 대기 시간 (ms, 이후 2배 증가) |
| `VITE_RATE_LIMIT_WAIT_MS` | `10000` | 429 수신 시 기본 대기 시간 (ms) |

### 12.4 기타 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `VITE_APP_VERSION` | `2.0.0` | (deprecated) 빌드 시점 식별자. 푸터 버전 표시는 이제 monigrid_settings_kv 의 `version` 키로 통합됨 (#8) |
| `VITE_COMPANY_NAME` | `Monitoring Dashboard` | 푸터 저작권 회사명 |
| `VITE_DEBUG` | `false` | 디버그 모드 |

---

## 13. 백엔드 환경 변수

`.env` 파일 또는 시스템 환경변수로 설정합니다. config.json 설정보다 우선합니다.

### 13.1 서버 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `FLASK_ENV` | `production` | `development` 시 Werkzeug 개발 서버 사용 |
| `USE_WAITRESS` | `1` | `0`이면 Werkzeug, `1`이면 Waitress 사용 |
| `WAITRESS_THREADS` | `16` | Waitress 워커 스레드 수 |
| `MONITORING_CONFIG_PATH` | `./config.json` | config.json 경로 |
| `CORS_ORIGINS` | (없음) | CORS 허용 오리진 (쉼표 구분) |

### 13.2 인증 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `AUTH_USERNAME` | config.json 값 | 로그인 사용자명 (config.json 오버라이드) |
| `AUTH_PASSWORD` | config.json 값 | 로그인 비밀번호 (config.json 오버라이드) |
| `ADMIN_USERNAME` | `admin` | 관리자 역할을 부여할 사용자명 |
| `JWT_SECRET_KEY` | `default-secret-key` | JWT 서명 키 |
| `JWT_ALGORITHM` | `HS256` | JWT 알고리즘 |
| `JWT_EXPIRATION_HOURS` | `24` | 토큰 유효 시간 |

### 13.3 데이터베이스 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DB_POOL_SIZE` | `5` | DB 연결 풀 크기 |
| `DB_POOL_TIMEOUT_SEC` | `30` | 풀에서 연결 대기 타임아웃 |
| `DB_POOL_RECYCLE_SEC` | `3600` | 연결 재사용 주기 |
| `ENABLE_CACHE` | `true` | 캐시 사용 여부 |
| `CACHE_TTL_SEC` | `300` | 캐시 TTL (초) |

---

## 14. 운영 가이드

### 14.1 일상 모니터링 체크리스트

- [ ] `GET /health` 엔드포인트로 서버 상태 확인
- [ ] 로그 뷰어에서 ERROR 레벨 로그 확인
- [ ] 캐시 상태에서 모든 엔드포인트가 정상 갱신되는지 확인
- [ ] 느린 쿼리 로그 확인 및 SQL 최적화

### 14.2 성능 튜닝

**위젯이 많을 때 (20개 이상)**:
- 위젯별 갱신 주기를 10초 이상으로 설정
- 배치 엔드포인트 rate limit을 상향 조정
- `server.thread_pool_size`를 워커 수에 맞게 증가

**DB 쿼리가 느릴 때**:
- `query_timeout_sec`을 쿼리 실행 시간보다 충분히 크게 설정
- SQL에 적절한 인덱스 사용
- `slow_query_threshold_sec`으로 느린 쿼리 감지

**429 에러가 빈발할 때**:
- `rate_limits` 섹션의 해당 엔드포인트 limit 상향
- IIS 프록시 환경에서 `X-Forwarded-For` 헤더가 올바르게 전달되는지 확인
- 프론트엔드 `VITE_RATE_LIMIT_WAIT_MS`를 늘려 대기 시간 확보

### 14.3 백업

다음을 정기적으로 백업하세요:

| 대상 | 중요도 | 설명 |
|------|--------|------|
| 설정 DB (`monigrid_*` 테이블) | **필수** | 모든 연결/API/설정/SQL 쿼리 — DB 백업 도구(mysqldump, expdp, SSMS 백업 등) 활용 |
| `initsetting.json` | **필수** | 설정 DB 접속 정보 (파일 자체는 기동 시에만 필요) |
| `drivers/*.jar` | 권장 | JDBC 드라이버 |
| `.env` | 권장 | 환경변수 (JWT 시크릿 등) |
| `config.json.bak` / `sql.bak/` | 선택 | 시드 이전의 초기값 스냅샷 |

### 14.4 업데이트 절차

1. 현재 `config.json`, `sql/`, `.env`를 백업
2. 새 버전의 실행 파일 교체
3. 백업한 `config.json`, `sql/`, `.env`를 복원
4. 서비스 재시작
5. `GET /health`로 정상 동작 확인

---

## 15. 문제 해결

### 15.1 서버 시작 실패

| 증상 | 원인 | 해결 |
|------|------|------|
| `connections must contain at least one item` | config.json에 connections 없음 | connections 배열에 최소 1개 연결 추가 |
| `apis must contain at least one item` | config.json에 apis 없음 | apis 배열에 최소 1개 엔드포인트 추가 |
| `duplicate connection id` | 연결 ID 중복 | 중복 ID 수정 |
| `duplicate rest_api_path` | API 경로 중복 | 경로를 고유하게 변경 |
| `Port already in use` | 다른 프로세스가 포트 사용 중 | 포트 변경 또는 기존 프로세스 종료 |

### 15.2 DB 연결 문제

| 증상 | 원인 | 해결 |
|------|------|------|
| `JVM not found` | Java 미설치 | JRE/JDK 설치 또는 JAVA_HOME 설정 |
| `Driver class not found` | JAR 경로 오류 | `global_jdbc_jars` 경로 확인 |
| `Connection refused` | DB 서버 미실행 또는 방화벽 | DB 서버 상태 및 네트워크 확인 |
| `Login failed` | 인증 실패 | DB 계정/비밀번호 확인 |

### 15.3 429 에러 (Too Many Requests)

| 증상 | 원인 | 해결 |
|------|------|------|
| 모든 사용자에게 429 발생 | IIS에서 X-Forwarded-For 미전달 | IIS ARR 설정에서 헤더 전달 확인 |
| 특정 사용자만 429 | 해당 사용자의 위젯/갱신주기 과다 | 갱신 주기를 늘리거나 rate_limits 상향 |
| 서버 시작 직후 429 | 캐시 워밍업 시 대량 요청 | global_default limit 상향 |

### 15.4 서버 리소스 모니터링 문제

| 증상 | 원인 | 해결 |
|------|------|------|
| 전체 서버 DEAD | 배치 요청 자체 실패 | 백엔드 로그 확인, 네트워크 확인 |
| 특정 서버만 에러 | SSH/WinRM 연결 실패 | 접속 정보(호스트, 계정, 포트) 확인 |
| `paramiko not installed` | SSH 라이브러리 미설치 | `pip install paramiko` |
| `pywinrm not installed` | WinRM 라이브러리 미설치 | `pip install pywinrm` |
| WinRM 인증 실패 | NTLM/Kerberos 설정 오류 | 도메인, 전송방식(transport) 설정 확인 |

### 15.5 프론트엔드 문제

| 증상 | 원인 | 해결 |
|------|------|------|
| API 연결 실패 | VITE_API_URL 설정 오류 | .env 파일 또는 대시보드 설정에서 URL 확인 |
| CORS 오류 | 백엔드 CORS 설정 미포함 | CORS_ORIGINS에 프론트엔드 도메인 추가 |
| 대시보드 레이아웃 초기화 | 브라우저 데이터 삭제 | 내보내기 기능으로 사전 백업 권장 |
| 빈 화면 (White screen) | JavaScript 오류 | 브라우저 개발자도구(F12) 콘솔 확인 |

---

## 16. 사용자 계정 관리

`monigrid_users` 테이블의 계정은 **대시보드 → 사용자 계정 관리** 화면(admin 전용) 또는 `/admin/users` API 로 관리합니다.

### 16.1 스키마

| 컬럼 | 설명 |
|------|------|
| `username` | PK, 소문자로 정규화하여 저장 |
| `password_hash` | bcrypt 해시 (비용 12) — 평문 비밀번호는 저장되지 않습니다 |
| `role` | `admin` 또는 `user` |
| `display_name` | UI 표기용 이름 (선택) |
| `enabled` | `true` / `false`. `false` 계정은 로그인 차단 |
| `created_at` / `updated_at` | 타임스탬프 (DB 기본값) |

### 16.2 API

| 메서드 | 경로 | 설명 |
|-------|------|------|
| GET    | `/admin/users` | 전체 사용자 목록 (password_hash 비노출) |
| POST   | `/admin/users` | 사용자 생성 — `{username, password, role, display_name?, enabled?}` |
| PUT    | `/admin/users/<username>` | 부분 수정 — 전달된 필드만 반영 |
| DELETE | `/admin/users/<username>` | 사용자 삭제 |

### 16.3 admin 자기보호 규칙

admin 이 자기 자신에게 적용할 수 없는 작업:

| 요청 | 응답 |
|------|------|
| `DELETE /admin/users/<본인>` | 400 — 자기 자신 삭제 금지 |
| `PUT /admin/users/<본인>` with `role != admin` | 400 — 자기 강등 금지 |
| `PUT /admin/users/<본인>` with `enabled: false` | 400 — 자기 비활성 금지 |

이 규칙은 "관리자가 1명 남은 상태에서 실수로 자기를 잘라 마스터 잠금이 되는" 상황을 막습니다. 다른 admin 을 먼저 만든 뒤, 그 계정으로 로그인해 기존 admin 을 내리세요.

### 16.4 초기 관리자 생성 절차

1. 최초 기동 시 `AUTH_USERNAME` / `AUTH_PASSWORD` 환경변수(기본값 `admin`/`admin`) 로 로그인
2. **사용자 계정 관리** 화면에서 실제 운영용 admin 계정 생성 (예: `alice` / 강력한 임시 비밀번호)
3. 로그아웃 후 신규 계정으로 재로그인 — 이 시점부터 환경변수 부트스트랩 로그인은 자동으로 잠깁니다
4. (선택) `.env` 에서 `AUTH_PASSWORD` 를 랜덤값으로 덮어써서 사고를 방지

---

## 17. 사용자 환경설정

사용자별 UI 선호값(위젯 레이아웃, 임계값, 알람 소리 등) 은 `monigrid_user_preferences` 테이블에 JSON 으로 저장됩니다.

### 17.1 스키마

| 컬럼 | 설명 |
|------|------|
| `username` | PK — 소유자의 username |
| `value` | JSON 문자열 (CLOB / LONGTEXT / NVARCHAR(MAX) — 방언별) |
| `updated_at` | 마지막 저장 시각 |

### 17.2 API (본인 전용)

| 메서드 | 경로 | 설명 |
|-------|------|------|
| GET | `/dashboard/me/preferences` | 본인 환경설정 조회 — 없으면 `{}` 반환 |
| PUT | `/dashboard/me/preferences` | 환경설정 저장 — body: `{preferences: {...}}` 혹은 raw object |

다른 사용자의 환경설정은 읽을 수도, 덮어쓸 수도 없습니다 (request path 에 username 이 없고 JWT 의 username 만 사용).

### 17.3 운영 고려사항

- 같은 사용자가 다른 브라우저 / 다른 PC 에서 로그인해도 **동일한 레이아웃** 으로 복원됩니다.
- 사용자를 **삭제** 하면 해당 row 도 함께 사라집니다. 복원이 필요하면 DB 백업에서 복구해야 합니다.
- 대용량(수 MB 이상) 값을 저장하지 않는 것이 바람직합니다. JSON 은 전체가 통째로 저장/전송됩니다.

---

## 18. 서버 리소스 / 네트워크 체크 (모니터 대상)

서버 리소스 / 네트워크 위젯은 **BE 의 단일 수집기**가 `monigrid_monitor_targets` 에 등록된 대상을 주기적으로 실행하여 메모리 스냅샷을 갱신하는 방식으로 동작합니다. 모든 브라우저는 `/dashboard/monitor-snapshot` 한 번의 호출로 전체 상태를 조회하며, 자격증명은 BE 에만 존재합니다.

### 18.1 관리 화면

> v2.2+ 부터 별도 페이지(`/monitor-targets`) 가 사라지고 **백엔드 설정 → 서버 리소스 / 네트워크 체크 두 탭**에서 관리합니다. 헤더의 옛 🛰 버튼은 제거되었습니다.

각 탭에서:
- **추가** — 우측 상단 `＋ 추가` 버튼으로 신규 카드(`신규` 배지) 가 가장 위에 펼쳐진 상태로 생성됩니다. 입력 후 카드 하단의 **추가** 버튼으로 BE 에 즉시 저장됩니다.
- **수정** — 카드를 펼쳐 값을 변경하면 헤더에 `변경됨` 배지가 표시됩니다. 카드 하단의 **저장** 으로 즉시 반영.
- **복제** — 카드 헤더의 복사 아이콘. 바로 아래에 신규 카드로 복제되며 `id` 는 자동 증가, `label` 은 ` (사본)` 접미사. 그대로 저장하거나 host 등을 바꿔서 저장하면 됩니다.
- **삭제** — 카드 헤더의 휴지통 아이콘. 신규 카드는 즉시 사라지고, 기존 카드는 확인 다이얼로그 후 BE 에 DELETE 호출.
- **켜기/끄기 토글** — 카드 헤더의 토글 스위치. (현재는 카드 하단 저장 버튼과 함께 반영되도록 설계되어 있어, 변경 후 저장을 눌러 주세요.)

### 18.2 스키마

| 컬럼 | 설명 |
|------|------|
| `id` | PK — 대상 식별자 (예: `srv-db01`, `net-api-gw`) |
| `type` | `server_resource` 또는 `network` (탭 별로 자동 결정) |
| `label` | UI 표시 이름 |
| `spec` | 수집기에 전달할 JSON 파라미터 (host / username / password / port / os_type / type / url 등) |
| `interval_sec` | 수집 주기(초) |
| `enabled` | true/false |
| `updated_at` | 최종 수정 시각 |

`spec` 의 주요 키 (탭/타입별):

- **서버 리소스** (`type=server_resource`) — `os_type` (linux-rhel8 / linux-generic / windows / windows-ssh / windows-winrm 등), `host`, 원격일 경우 `username` / `password` / `port` / `domain` / `transport`(WinRM)
- **네트워크 체크** (`type=network`) — `type` (`ping` / `telnet`), `host`, telnet 일 때 `port`, `timeout`
- **API 상태** (`type=http_status`, v2.3+) — `url` (필수, http/https), `timeout_sec` (1~30, 기본 10). 위젯 측의 다중 URL 폴링을 BE 단일 호출로 모은 형태입니다.

비밀번호 입력 칸은 모두 우측 눈 모양 아이콘으로 평문 토글이 가능합니다.

### 18.3 API

| 메서드 | 경로 | 권한 | 설명 |
|-------|------|------|------|
| GET    | `/dashboard/monitor-targets` | auth | 대상 목록 (비관리자에게는 `spec` 내 `password`/`secret`/`token` 이 마스킹됨) |
| POST   | `/dashboard/monitor-targets` | admin | 대상 생성 |
| PUT    | `/dashboard/monitor-targets/<id>` | admin | 대상 수정 |
| DELETE | `/dashboard/monitor-targets/<id>` | admin | 대상 삭제 |
| GET    | `/dashboard/monitor-snapshot` | auth | 최신 스냅샷 (쿼리 `ids=a,b` 로 필터) |
| POST   | `/dashboard/monitor-snapshot/<id>/refresh` | auth | 해당 대상 즉시 재수집 |

### 18.4 위젯과의 연결

- 사용자가 **위젯 추가** 모달에서 "서버 리소스" / "네트워크 테스트" / "API 상태 리스트" 위젯 유형을 고르면, 엔드포인트 입력칸 대신 **해당 type 으로 등록된 대상 목록**이 체크박스로 표시됩니다.
- 해당 탭에 등록된 대상이 0개일 경우 위젯 추가 화면에 "백엔드 설정 → 해당 탭에서 먼저 추가하세요" 안내가 표시됩니다.
- 이미 만들어진 위젯의 ⚙ 설정 모달도 동일 픽커를 사용합니다. 위젯이 호스트/URL/자격증명을 직접 보관하지 않으므로, 자격증명 관리 책임은 전적으로 관리자에게 있습니다.

> **API 상태 리스트 마이그레이션 주의** — v2.2 이전에 위젯 자체에 URL 목록이 들어 있던 형태에서 v2.3+ 의 `http_status` 타겟 기반으로 자동 이전되지 않습니다. 위젯을 삭제 후 재추가하거나, ⚙ 에서 `targetIds` 로 다시 선택하도록 안내하세요.

### 18.5 운영 팁

- 대상 수가 많아지면 `interval_sec` 을 늘려 부하를 분산시키세요 (단일 BE 수집기).
- 비관리자 사용자 세션이 다수일 때도 DB / 외부 장비 / 외부 URL 쪽 부하는 일정합니다. 폴링이 BE 에 한 번 집중되기 때문입니다.
- 자격증명 / URL 회전 시 카드 한 곳만 업데이트하면 모든 위젯에 즉시 반영됩니다 (위젯들은 `targetIds` 만 보관).
- 수집 루프는 매 tick 마다 타겟 카탈로그를 재조회하므로 `interval_sec` / `enabled` 변경이 다음 tick 에 즉시 반영됩니다 (별도 reload-config 불필요).
- `http_status` 타겟의 URL 은 health-check-proxy 와 동일한 검증을 거칩니다 — 스킴 (`http`/`https`) / 길이 / `HEALTHCHECK_BLOCK_PRIVATE` 설정 시 사설 IP 차단.

---

## 19. 설정 DB 이관

Oracle / MariaDB / MSSQL 사이에서 설정 DB 내용을 통째로 옮길 때는 `monigrid-be/migrate_settings_db.py` 를 사용합니다.

### 19.1 사용법

```bash
cd monigrid-be
python migrate_settings_db.py --from initsetting.json --to initsetting.oracle.json
```

- `--from` 과 `--to` 에는 각각 원본·대상의 `initsetting.*.json` 파일 경로를 전달합니다.
- 대상 DB 에 `monigrid_*` 스키마가 없으면 자동 생성됩니다 (`SettingsStore.create_schema()`).
- 대상의 모든 `monigrid_*` 테이블은 **복사 전 삭제**되므로 원본이 곧 스냅샷 기준이 됩니다.
- `created_at` / `updated_at` 은 원본 값이 그대로 복사됩니다.
- 양쪽 JAR 가 한 JVM 에 올라가므로 양쪽 드라이버를 모두 `drivers/` 에 배치하고 `jdbc_jars` 에 나열하십시오.

### 19.2 주의사항

- `initsetting.json` / `initsetting.*.json` 에는 DB 자격 증명이 들어가므로 `.gitignore` 로 저장소 커밋이 차단됩니다. 로컬에서만 관리하세요.
- 이관 직후 신규 DB 로 기동할 때도 기존 환경변수(`JWT_SECRET_KEY` 등) 를 동일하게 유지하세요 — 기존 토큰의 무효화를 막고 싶을 때 중요합니다.
- Oracle → MSSQL 과 같이 방언을 바꿀 때는 MSSQL 의 `databaseName=master` 등 대상 파라미터가 실제 운영 DB 로 바뀌었는지 반드시 확인하세요. 테스트 완료 후 운영 DB 명으로 `initsetting.json` 을 교체합니다.

## 5-5. Phase 5B — Partial Config Reload (2026-05-07)

이전까지 `PUT /dashboard/config` 와 monitor target 저장은 **모든 connection pool / executor / cache / monitor thread 를 재생성**하는 nuclear reload 였다 (`backend.reload()`). 그래서 connection title 한 글자만 수정해도 다른 사용자의 위젯 cache 가 비워지면서 **모든 client 가 동시에 cache miss → 같은 timestamp 의 같은 데이터 수신 → 동시 알람** 현상이 발생할 수 있었다.

5B 부터는 **변경된 항목만** in-memory 에 적용한다. 변경 안 된 connection pool / endpoint cache / monitor thread 는 절대 건드리지 않는다.

### 응답 shape 변화

`PUT /dashboard/config` 응답에 `applied` / `skipped` / `errors` 배열 추가:

```json
{
  "saved": true,
  "reloaded": true,
  "endpointCount": 2,
  "connectionCount": 1,
  "applied": [
    {"resource": "api", "id": "status", "action": "data_changed_with_cache_invalidate"}
  ],
  "skipped": [
    {"resource": "global", "field": "thread_pool_size", "reason": "requires_restart"}
  ],
  "errors": []
}
```

`errors` 배열이 비어있지 않으면 HTTP **207 Multi-Status**. FE 가 부분 실패를 사용자에게 알림. 다른 항목은 적용되었으므로 settings DB 와 in-memory 가 일관 (실패한 항목만 다음 BE 재시작 시 자동 복구).

`POST /dashboard/monitor-targets/batch` 응답에도 `applied` / `errors` 추가됨. 동일하게 errors 있을 시 207.

### Runtime-immutable 필드

다음 필드 변경은 settings DB 에는 저장되지만 **BE 재시작 후에 적용**된다:

- `thread_pool_size` (ThreadPoolExecutor 는 runtime resize 불가)
- `server.host`, `server.port` (BE listen socket)
- `rate_limits.*` (Flask-Limiter 가 데코 시점 캡처)

이 필드들이 변경된 경우 응답의 `skipped` 배열에 등장 + BE 로그에 WARNING 1줄. 운영자는 의도된 변경 후 BE 서비스 재시작 (NSSM stop/start) 필요.

### Escape hatch — POST /dashboard/reload-config

기존 nuclear reload 는 보존됐다. 다음 경우에 명시적으로 호출:

- JDBC driver jar 를 새로 추가했는데 BE 재시작 없이 동작 확인하고 싶을 때 (실제로는 JVM classpath 가 갱신되지 않으므로 효과는 제한적)
- 테스트 / 디버그 시 모든 cache 를 명시적으로 비우고 싶을 때

`POST /dashboard/reload-config` (admin only) — 응답 shape 변경 없음. 기존 `endpointCount` 만. 5B 부터 `_reload_lock` 안에서 직렬화 되므로 동시 호출 시 두 번째 요청은 첫 번째가 끝날 때까지 대기 (이전엔 race 가능했음 — C-2 fix).

### JDBC classpath 로깅 (I-2 — 5B 와 함께 정리)

이전: 모든 reload 마다 `[ERROR] Reload introduced JDBC jars not on the running JVM classpath ... missing=...` 출력 → alert fatigue.

5B 부터:

- 부팅 시 1회: `[INFO] Loaded JDBC drivers: N jars` + 누락분이 있으면 `[INFO] JDBC jars not on classpath at boot (will be ignored on reload): [...]`
- 운영자가 **새 connection 추가 → 새로 누락된 jar** 가 등장한 경우만 `[WARNING] JDBC jars not on classpath — newly_missing=[...]` 1회. 같은 누락 jar 는 두 번 다시 로그 안 남.

### Partial reload 의 success criteria

다음 시나리오들이 5B 적용 후 동작 (구현 완료):

- Connection 의 jdbc_url / driver_args 변경 → 그 connection 의 pool 만 재생성, 다른 connection 영향 0
- API SQL 수정 (connection_id/sql_id 변경) → 그 endpoint cache 만 invalidate, 다른 endpoint cache 보존
- Monitor target 임계치 / interval 수정 → thread 재생성 없음, 다음 sleep tick 후 자연 적용
- Monitor target 추가 → 새 thread 1개만 spawn, 다른 target thread 영향 0
- Monitor target 삭제 → 해당 stop_event signal + thread join + 해당 host 의 SSH session 만 drain
- 동시 2개 reload 호출 → `_reload_lock` 으로 직렬화

### 관련 commit / PR

- 디자인 spec: `docs/superpowers/specs/2026-05-07-partial-config-reload-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-07-partial-config-reload.md`
- Smoke test scripts: `monigrid-be/scripts/test_config_diff.py` (단위), `monigrid-be/scripts/test_partial_reload.py` (통합)

## 5-6. I-1 / I-4 운영 변경사항 (2026-05-07)

### I-1: cache/refresh + reload-config rate limit 추가

이전엔 `/dashboard/cache/refresh` 와 `/dashboard/reload-config` 가 endpoint-specific rate limit 없이 global default (`200/minute`) 만 적용되어, 잘못 만들어진 FE 또는 의도적 abuse 시 BE 의 JDBC 풀과 reload 락을 점거할 위험이 있었다.

5B 와 함께 `RateLimitConfig` 에 두 키 추가 (settings DB `monigrid_settings_kv` 의 `rate_limits.*` 에서 override 가능):

| 키 | 기본값 | 비고 |
|---|---|---|
| `cache_refresh` | `30/minute` | 동일 IP/사용자가 cache 강제 새로고침. 30 초과 시 429. JDBC 재연결 (`reset_connection: true`) 폭주 방지. |
| `reload_config` | `5/minute` | admin 의 명시적 nuclear reload. 5 초과 시 429. 5B 의 `_reload_lock` 으로 어차피 직렬화되지만 폭주 자체를 차단. |

검증: `for i in {1..35}; do curl ...cache/refresh; done` → 30 개는 200, 마지막 5 개는 429.

### I-4: /auth/logout 응답 메시지 영문화

이전: `{"message": "로그아웃 되었습니다"}` — 다른 모든 BE 응답이 영어인 데 반해 한국어 1줄.
이후: `{"message": "Logged out"}` — 일관성. FE 가 사용자에게 노출하지 않는 internal message 라 i18n 영향 없음.

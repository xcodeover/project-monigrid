# MoniGrid 관리자 메뉴얼

## 목차

0. [설정 저장소 개요 (Settings DB)](#0-설정-저장소-개요-settings-db)
1. [시스템 구성](#1-시스템-구성)
2. [설치 및 배포](#2-설치-및-배포)
3. [설정 편집 (이전: config.json)](#3-설정-편집-이전-configjson)
4. [인증 및 보안](#4-인증-및-보안)
5. [Rate Limit 설정](#5-rate-limit-설정)
6. [데이터베이스 연결 관리](#6-데이터베이스-연결-관리)
7. [API 엔드포인트 관리](#7-api-엔드포인트-관리)
8. [SQL 편집기](#8-sql-편집기)
9. [설정 편집기](#9-설정-편집기)
10. [캐시 관리](#10-캐시-관리)
11. [로그 관리](#11-로그-관리)
12. [프론트엔드 환경 변수](#12-프론트엔드-환경-변수)
13. [백엔드 환경 변수](#13-백엔드-환경-변수)
14. [운영 가이드](#14-운영-가이드)
15. [문제 해결](#15-문제-해결)

---

## 0. 설정 저장소 개요 (Settings DB)

백엔드 설정·DB 연결 정의·API 엔드포인트·SQL 쿼리는 모두 **공유 설정 DB**에 저장됩니다. Active-Active 배포 시 두 노드가 동일 설정을 바라보도록 하기 위함입니다.

### 0.1 파일 vs 테이블

| 과거 (v1.x) | 현재 (v2.0+) |
|-------------|--------------|
| `config.json` (파일) | `monigrid_settings_kv` / `monigrid_connections` / `monigrid_apis` (테이블) |
| `sql/*.sql` (파일) | `monigrid_sql_queries` (테이블) |

`config.json` 과 `sql/*.sql` 파일은 **최초 기동 시 1회만** 설정 DB로 시드(seed)되며, 이후 `.bak` 으로 이름이 바뀌고 더 이상 읽히지 않습니다.

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

설정 DB 연결이 서버의 `wait_timeout` 등으로 끊겨도 커서 발급 시점에 `Connection.isValid(2)` 로 상태를 확인하여 자동 재연결합니다.

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

### 4.2 관리자 역할

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| `ADMIN_USERNAME` | `admin` | 이 사용자명으로 로그인하면 관리자 역할 부여 |

관리자 전용 기능:
- SQL 편집기 (`monigrid_sql_queries` 조회/수정)
- 설정 편집기 (설정 DB 테이블 — 연결/API/보안/로깅 등)
- 설정 핫 리로드
- 캐시 수동 갱신

### 4.3 보안 체크리스트

- [ ] `JWT_SECRET_KEY`를 랜덤 문자열로 변경
- [ ] `auth.password`를 기본값(`admin`)에서 변경
- [ ] IIS에서 HTTPS 적용
- [ ] `CORS_ORIGINS`를 실제 프론트엔드 도메인으로 제한
- [ ] 방화벽에서 백엔드 포트(5000) 외부 직접 접근 차단

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
    "server_resources_batch": "60/minute"
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

## 7. API 엔드포인트 관리

### 7.1 엔드포인트 추가

`config.json`의 `apis` 배열에 새 항목을 추가합니다:

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

## 9. 설정 편집기

관리자 전용 기능으로, 대시보드 헤더의 **설정 편집기** 버튼에서 접근합니다.

### 9.1 기능

- 설정 DB 에 저장된 모든 섹션(Server / Auth / Connections / APIs / Rate Limits / Logging / SQL Validation) 을 탭별 또는 원시 JSON 모드로 조회/수정
- 저장 시 `monigrid_*` 테이블에 즉시 커밋 + 양 A-A 노드에 자동 핫 리로드
- **Connections / APIs 카드 복제** — 항목 우측 `⧉` 버튼으로 바로 아래에 복사 생성 (`id` 와 `rest_api_path` 는 자동으로 고유 접미사 부여)

### 9.2 주의사항

- JSON 문법 오류가 있으면 저장이 차단됩니다.
- DB 비밀번호 등 민감 정보가 설정 DB 에 저장되므로 설정 DB 접근 권한을 엄격히 관리하세요.
- 변경 전 반드시 현재 설정을 백업하세요.

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
| `VITE_APP_VERSION` | `2.0.0` | 프론트엔드 버전 (푸터 표시) |
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

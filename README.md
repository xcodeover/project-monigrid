# MoniGrid

모니터링 대시보드 플랫폼 — 백엔드(`monigrid-be`) + 프론트엔드(`monigrid-fe`) 모노레포.

---

## 구성

| 모듈 | 설명 | 기술 스택 |
|------|------|-----------|
| `monigrid-be/` | Flask + JDBC 기반 REST API 서버 | Python 3.13+, Flask, JayDeBeApi, Waitress |
| `monigrid-fe/` | React SPA (대시보드, 위젯 에디터) | React + Vite + Zustand |
| `docs/` | 운영/관리자/사용자 매뉴얼 | Markdown |

---

## 아키텍처 요약

```
 ┌─────────────┐     HTTP       ┌─────────────┐     JDBC     ┌──────────────┐
 │  monigrid-fe │ ───────────▶ │ monigrid-be │ ───────────▶ │ 모니터링 대상  │
 │  (React SPA) │ ◀─────────── │  (Flask)     │ ◀─────────── │ DB (Oracle/    │
 └─────────────┘   JSON         └──────┬──────┘              │  MariaDB/MSSQL)│
                                       │                     └──────────────┘
                                       │ JDBC
                                       ▼
                                ┌────────────────┐
                                │  설정 DB          │
                                │ (monigrid_* 테이블)│  ← Active-Active 양 노드 공유
                                └────────────────┘
```

- **설정 DB 중심** — 백엔드 설정·SQL 쿼리·DB 연결 정보는 공유 DB(`monigrid_*` 테이블)에 저장되어 Active-Active 배포 시 양 노드가 동일 설정을 바라봅니다.
- **부트스트랩 파일** — 최초 기동 시 `initsetting.json`으로 설정 DB 접속 정보를, `config.json` / `sql/*.sql`로 초기 데이터를 시드합니다. 시드 이후 원본 파일은 `.bak`으로 이름이 바뀝니다. 신규 버전에서 추가된 테이블은 매 시작 시점에 idempotent DDL 로 자동 보강됩니다.
- **멀티 DB 방언 지원** — 설정 DB 는 Oracle / MariaDB / MSSQL 중 하나를 선택해 사용할 수 있으며, DDL·타입·UPSERT 가 방언별로 분기됩니다.
- **DB 기반 사용자 관리** — `monigrid_users` 테이블에 bcrypt 해시 비밀번호로 계정을 저장하고 admin / user 역할을 관리합니다. 최초 1회에 한해 환경변수(AUTH_USERNAME/AUTH_PASSWORD) 로 부트스트랩 로그인이 가능하며, DB 에 관리자 계정이 생기는 순간 환경변수 로그인은 비활성화됩니다.
- **개인 환경설정** — 위젯 레이아웃·임계값·알람 소리 등 사용자별 UI 선호는 `monigrid_user_preferences` 에 저장되어 같은 계정으로 다른 브라우저에서도 동일한 대시보드를 복원할 수 있습니다.
- **백엔드 설정 통합** — 데이터 API · DB 연결 · 서버 리소스 · 네트워크 체크 · 인증 · 로깅 등 모든 운영 설정은 대시보드 헤더의 **백엔드 설정** (`⚙` 슬라이더 아이콘) 한 곳에서 관리합니다. 진입 시 현재 사용자 비밀번호 재확인이 요구됩니다.
- **서버/네트워크 모니터링은 BE 중앙 수집** — 위젯에 호스트/자격증명을 직접 입력하지 않고, 백엔드 설정에 등록된 모니터 대상(`monigrid_monitor_targets`) 중에서 선택합니다. 자격증명은 BE 에만 보관되고, 모든 브라우저는 `/dashboard/monitor-snapshot` 한 번의 호출로 동일 결과를 받습니다.

---

## 빠른 시작

```bash
# 백엔드
cd monigrid-be
pip install -r requirements.txt
# 최초 1회: initsetting.json 편집 (설정 DB 접속 정보)
#  - initsetting.example.json 을 복사하여 사용하거나,
#  - initsetting.{oracle,mssql,mariadb}.json 템플릿을 로컬에서 참고하세요 (.gitignore 로 커밋 제외).
python monigrid_be.py

# 프론트엔드
cd monigrid-fe
npm install
npm run dev
```

기본 접속: `http://127.0.0.1:3000` (FE) → `http://127.0.0.1:5000` (BE)
최초 로그인(환경변수 부트스트랩): `admin` / `admin` — 로그인 후 즉시 관리자 계정을 생성하면 부트스트랩 로그인은 자동으로 차단됩니다.

---

## 설정 DB 간 이관

설정 DB 를 다른 방언(예: MariaDB → Oracle / MSSQL) 으로 옮길 때는 `monigrid-be/migrate_settings_db.py` 를 사용합니다.

```bash
cd monigrid-be
python migrate_settings_db.py \
  --from initsetting.json \
  --to   initsetting.oracle.json
```

- 양쪽 JDBC 드라이버 JAR 를 단일 JVM 클래스패스로 묶어서 한 번에 로드합니다.
- 대상 DB 에 `monigrid_*` 스키마가 없으면 자동 생성합니다.
- 대상 테이블은 복사 전 비워지므로, 원본이 곧 스냅샷의 기준이 됩니다.
- CLOB / LONGTEXT / NVARCHAR(MAX) 값을 방언별로 안전하게 unwrap 합니다.

---

## 문서

| 문서 | 대상 |
|------|------|
| [monigrid-be/README.md](monigrid-be/README.md) | 백엔드 개발·빌드·운영 |
| [monigrid-fe/README.md](monigrid-fe/README.md) | 프론트엔드 개발·빌드·배포 |
| [docs/ADMIN_MANUAL.md](docs/ADMIN_MANUAL.md) | 운영자 — 설정·보안·배포 |
| [docs/USER_MANUAL.md](docs/USER_MANUAL.md) | 최종 사용자 — 위젯 사용법 |

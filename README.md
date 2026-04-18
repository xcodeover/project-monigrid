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
- **부트스트랩 파일** — 최초 기동 시 `initsetting.json`으로 설정 DB 접속 정보를, `config.json` / `sql/*.sql`로 초기 데이터를 시드합니다. 시드 이후 원본 파일은 `.bak`으로 이름이 바뀝니다.

---

## 빠른 시작

```bash
# 백엔드
cd monigrid-be
pip install -r requirements.txt
# 최초 1회: initsetting.json 편집 (설정 DB 접속 정보)
python monigrid_be.py

# 프론트엔드
cd monigrid-fe
npm install
npm run dev
```

기본 접속: `http://127.0.0.1:3000` (FE) → `http://127.0.0.1:5000` (BE)
기본 로그인: `admin` / `admin`

---

## 문서

| 문서 | 대상 |
|------|------|
| [monigrid-be/README.md](monigrid-be/README.md) | 백엔드 개발·빌드·운영 |
| [monigrid-fe/README.md](monigrid-fe/README.md) | 프론트엔드 개발·빌드·배포 |
| [docs/ADMIN_MANUAL.md](docs/ADMIN_MANUAL.md) | 운영자 — 설정·보안·배포 |
| [docs/USER_MANUAL.md](docs/USER_MANUAL.md) | 최종 사용자 — 위젯 사용법 |

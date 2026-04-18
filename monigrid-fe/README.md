# Monitoring Dashboard Frontend (monigrid-fe)

REST API로부터 데이터를 수집하여 실시간으로 애플리케이션 상태 및 알람을 모니터링하는 React 기반 웹 대시보드입니다.
Electron으로 패키징하여 Windows 데스크탑 앱(EXE 설치 파일)으로도 배포할 수 있습니다.

---

## 목차

1. [주요 기능](#1-주요-기능)
2. [요구사항](#2-요구사항)
3. [프로젝트 구조](#3-프로젝트-구조)
4. [빠른 시작 (Quick Start)](#4-빠른-시작-quick-start)
5. [개발 모드 실행](#5-개발-모드-실행)
6. [웹 프로덕션 빌드](#6-웹-프로덕션-빌드)
7. [IIS 단일 사이트 배포 (Frontend + Backend 같은 포트)](#7-iis-단일-사이트-배포-frontend--backend-같은-포트)
8. [Electron 데스크탑 EXE 빌드](#8-electron-데스크탑-exe-빌드)
9. [위젯 사용법](#9-위젯-사용법)
10. [Criteria & ALERT](#10-criteria--alert)
11. [대시보드 설정](#11-대시보드-설정)
12. [백엔드 연동](#12-백엔드-연동)
13. [로컬 스토리지](#13-로컬-스토리지)
14. [운영 가이드](#14-운영-가이드)
15. [트러블슈팅](#15-트러블슈팅)
16. [기술 스택](#16-기술-스택)

---

## 1. 주요 기능

### 위젯 & 레이아웃

- **드래그&드롭 위젯 배치** — react-grid-layout 기반 자유 배치 및 크기 조절
- **7종 위젯 타입** 지원:
  | 위젯 | 설명 |
  |------|------|
  | 데이터 테이블 | JSON 배열·객체를 동적 테이블로 표시 |
  | 웹서버 상태 체크 | HTTP 상태 코드 기반 업·다운 모니터링 |
  | 시간대별 추이 (라인차트) | 시계열 데이터 추이 시각화 |
  | 기준별 수량 (바차트) | 카테고리별 집계 수량 시각화 |
  | API 상태 리스트 | 다중 URL HTTP 200 체크 |
  | 네트워크 테스트 (Ping/Telnet) | Ping, TCP 연결 테스트 |
  | 서버 리소스 모니터링 | CPU/Memory/Disk 사용률 실시간 조회 |
- **위젯별 독립 리프레시 주기 설정** — 1~3600초
- **LIVE / SLOW-LIVE / DEAD 상태 표시** — 응답 지연 시 노란색 경고

### 동적 테이블

- **자동 컬럼 생성** — JSON 구조에 관계없이 자동으로 테이블 구성
- **컬럼 선택/순서** — 체크박스로 표시 컬럼 선택·해제
- **컬럼 정렬** — 헤더 클릭으로 오름차순/내림차순/해제 순환
- **상태 값 자동 색상** — healthy/error/warning 등 자동 인식
- **행 더블클릭** — 상세 팝업 (실시간 업데이트, 서버 리소스 위젯은 CPU/MEM/DISK 실시간 차트 팝업)
- **Ctrl+C 복사** — 선택 행을 헤더 포함 TSV로 클립보드 복사
- **마우스 오버 툴팁** — 서버 리소스·네트워크 테스트 위젯에서 각 항목에 마우스를 올리면 설정 정보 툴팁 표시

### 알람 시스템

- **Criteria 기반 조건부 알람** — 컬럼별 임계치 설정 → 조건 충족 시 ALERT 표시
- **알람 배너** — 화면 상단에 경고 표시
- **경고음 선택** — Beep / Siren / Pulse / Mute

### SQL Editor (관리자 전용)

- 대시보드에서 SQL 파일 조회·저장
- SELECT 전용 검증 — UPDATE/DELETE/DROP 등 위험 구문 차단

### 백엔드 설정 관리

- **config.json 에디터** — 대시보드에서 백엔드 설정 직접 편집 (서버, 인증, DB 연결, API 엔드포인트, 로깅, 고급)
- **탭 기반 UI** — 설정 항목별 탭 전환 + JSON 직접 편집 모드
- **아코디언 카드** — DB 연결·API 엔드포인트를 접기/펼치기 카드 형식으로 관리
- **설정 핫 리로드** — 저장 시 서버 재시작 없이 즉시 반영

### 인증 & 보안

- JWT 기반 로그인·세션 관리
- 401 응답 시 자동 로그아웃

---

## 2. 요구사항

| 항목 | 버전 |
|------|------|
| Node.js | 18+ |
| npm | 9+ |

```bash
cd monigrid-fe
npm install
```

---

## 3. 프로젝트 구조

```text
monigrid-fe/
├── public/                          # 정적 리소스
├── electron/                        # Electron 메인 프로세스
│   ├── main.cjs
│   ├── preload.cjs                  # Electron preload 스크립트 (contextBridge)
│   └── package-portable.ps1         # 포터블 ZIP 빌드 스크립트
├── src/
│   ├── components/
│   │   ├── ApiCard.jsx              # 데이터 테이블 위젯 (헤더, 설정, ALERT)
│   │   ├── HealthCheckCard.jsx      # 웹서버 상태 체크 위젯
│   │   ├── LineChartCard.jsx        # 시간대별 추이 라인차트 위젯
│   │   ├── BarChartCard.jsx         # 기준별 수량 바차트 위젯
│   │   ├── StatusListCard.jsx       # API 상태 리스트 위젯
│   │   ├── NetworkTestCard.jsx      # Ping/Telnet 네트워크 테스트 위젯
│   │   ├── ServerResourceCard.jsx   # 서버 리소스 모니터링 위젯
│   │   ├── DynamicTable.jsx         # 동적 테이블 (정렬, 색상, 필터, 행 이벤트)
│   │   ├── AlarmBanner.jsx          # 상단 알람 배너
│   │   ├── SqlEditorModal.jsx       # SQL Editor 모달
│   │   ├── ConfigEditorModal.jsx    # 백엔드 config.json 에디터 모달
│   │   ├── IncidentTimelineCard.jsx # 장애 타임라인
│   │   └── *.css                    # 컴포넌트별 스타일
│   ├── hooks/
│   │   ├── useApi.js                # 위젯별 API 폴링 통합 훅
│   │   ├── useApiData.js            # 단일 API 데이터 훅
│   │   ├── useMultipleApiData.js    # 다중 API 데이터 훅
│   │   └── useWidgetApiData.js      # 위젯 API 데이터 매니저
│   ├── pages/
│   │   ├── DashboardPage.jsx        # 메인 대시보드
│   │   ├── DashboardPage.css        # 대시보드 스타일
│   │   ├── LoginPage.jsx            # 로그인 페이지
│   │   ├── LoginPage.css            # 로그인 스타일
│   │   ├── AlertHistoryPage.jsx     # 알람 이력 페이지
│   │   ├── LogViewerPage.jsx        # 서버 로그 뷰어
│   │   └── LogViewerPage.css        # 로그 뷰어 스타일
│   ├── services/
│   │   ├── http.js                  # Axios 인스턴스 (인터셉터 포함)
│   │   ├── api.js                   # API URL 헬퍼
│   │   ├── authService.js           # 인증 서비스
│   │   └── dashboardService.js      # 대시보드 API 서비스
│   ├── store/
│   │   ├── authStore.js             # 인증 상태 (Zustand)
│   │   ├── dashboardStore.js        # 위젯·레이아웃·설정 상태 (Zustand)
│   │   ├── alarmStore.js            # 알람 상태 (Zustand)
│   │   └── storageKeys.js           # 로컬 스토리지 키 상수
│   ├── utils/
│   │   └── helpers.js               # Criteria 계산, 데이터 정규화 등
│   ├── styles/
│   │   └── index.css                # 글로벌 스타일
│   ├── App.jsx                      # 라우터 설정
│   └── main.jsx                     # 앱 진입점
├── .env.example                     # 환경변수 참고 파일
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── package.json
```

---

## 4. 빠른 시작 (Quick Start)

### 초보자를 위한 단계별 안내

#### Step 1: 사전 준비

1. **Node.js 18+** 설치 (https://nodejs.org/)
   - LTS 버전 권장
   - 설치 확인: `node --version`
2. 백엔드(`monigrid-be`)가 실행 중이어야 합니다
   - 백엔드 설정 및 실행: `../monigrid-be/README.md` 참조

#### Step 2: 의존성 설치 및 실행

```bash
cd monigrid-fe
npm install
npm run dev
```

#### Step 3: 접속 및 로그인

1. 브라우저에서 `http://localhost:3000` 접속
2. 로그인 화면에서:
   - **Username**: `admin`
   - **Password**: `admin`
   - (기본 백엔드 URL: `http://127.0.0.1:5000`)
3. 로그인 성공 시 대시보드 페이지로 이동

#### Step 4: 첫 위젯 설정

- 기본 위젯(CoinTrader Status, Application Alerts, System Metrics)이 자동 생성됩니다
- 백엔드에서 활성화된 API가 있으면 데이터가 자동으로 표시됩니다
- 새 위젯 추가: 헤더의 **`＋`** 버튼 클릭

---

## 5. 개발 모드 실행

### 웹 개발 서버

```bash
npm run dev
```

브라우저에서 `http://localhost:3000` 접속

### 시뮬레이션 백엔드 연결 개발 서버

```bash
npm run dev:simulation
```

`http://127.0.0.1:5051` 시뮬레이션 백엔드에 연결됩니다.

### Electron 데스크탑 개발 모드

```bash
npm run dev:desktop
```

Vite 개발 서버와 Electron 창을 동시에 실행합니다.

---

## 6. 웹 프로덕션 빌드

### 일반 빌드

```bash
npm run build
```

결과물: `dist/`

### 빌드 미리보기

```bash
npm run preview
```

### 웹 서버 배포

`dist/` 폴더를 Nginx, Apache 등의 웹 서버로 서빙합니다.

**Nginx 설정 예시:**

```nginx
server {
    listen 80;
    server_name monitoring.example.com;
    root /var/www/monigrid-fe/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## 7. IIS 단일 사이트 배포 (Frontend + Backend 같은 포트)

Windows IIS 환경에서 **프론트엔드와 백엔드를 하나의 사이트(같은 포트)로 통합 배포**하는 방법입니다.
IIS가 정적 파일은 직접 서빙하고, API 요청만 백엔드(Flask)로 **리버스 프록시**합니다.

### 7.1 왜 이 방법이 필요한가

기본 구성에서는 프론트엔드(`http://server:80`)와 백엔드(`http://server:5000`)가 서로 다른 포트를 사용합니다.
이 경우 다른 PC 브라우저에서 접속하면 다음과 같은 문제가 발생합니다.

- `VITE_API_URL`이 `http://127.0.0.1:5000`이면 → **사용자 PC 자기 자신**의 5000번 포트로 요청 → 실패
- 백엔드 서버 IP를 직접 박으면 → 환경이 바뀔 때마다 재빌드 필요
- CORS 설정 / 방화벽 포트 추가 노출 등 운영 복잡도 증가

**IIS 리버스 프록시 구성:**

```
다른 PC 브라우저
  → IIS (서버:80)
       │
       ├─ /, /index.html, /assets/*  → 정적 파일 직접 서빙 (dist/)
       ├─ /auth/*                    → 프록시 → 127.0.0.1:5000 (Flask)
       ├─ /dashboard/*               → 프록시 → 127.0.0.1:5000
       ├─ /health, /logs/*           → 프록시 → 127.0.0.1:5000
       ├─ /api/*                     → 프록시 → 127.0.0.1:5000
       └─ 그 외 경로                 → index.html (SPA 라우팅 fallback)
```

이 구성의 장점:

- 외부에는 **IIS 포트 하나만** 노출 (백엔드 5000 포트는 방화벽 차단 가능)
- 브라우저 입장에서는 frontend / backend가 **같은 origin** → CORS 불필요
- 백엔드 서버 IP가 바뀌어도 프론트엔드 재빌드 불필요 (IIS의 web.config만 수정)

### 7.2 사전 요구사항

1. **IIS URL Rewrite 모듈 설치**
   https://www.iis.net/downloads/microsoft/url-rewrite

2. **IIS Application Request Routing (ARR) 모듈 설치**
   https://www.iis.net/downloads/microsoft/application-request-routing

3. **ARR 프록시 활성화**
   - IIS Manager 실행
   - 좌측 트리에서 **서버 노드(최상위)** 선택
   - 가운데 패널에서 **Application Request Routing Cache** 더블 클릭
   - 우측 Actions 패널에서 **Server Proxy Settings** 클릭
   - **`Enable proxy`** 체크박스 ON → **Apply**

   > 이 단계를 빠뜨리면 URL Rewrite의 `Rewrite to http://...` 규칙이 동작하지 않고
   > `404.4 - Not Found` 또는 `500.52` 에러가 발생합니다.

4. **백엔드 실행 환경 준비**
   - 백엔드(Flask)는 별도 프로세스로 실행하되, **127.0.0.1:5000** 에 바인딩되어 있어야 합니다.
   - 백엔드를 외부 노출할 필요가 없으므로 `host: "127.0.0.1"`로 두면 보안상 안전합니다.

### 7.3 빌드 (`.env.iis` 모드)

IIS 단일 사이트 모드에서는 프론트엔드의 API base URL을 **빈 문자열**로 설정해야 합니다.
빈 문자열이면 axios가 현재 origin(IIS 자체)으로 상대 경로 요청을 보내고, IIS가 이를 Flask로 프록시합니다.

**`.env.iis` 파일** (이미 프로젝트에 포함):

```env
# 프론트엔드와 백엔드가 같은 origin이므로 빈 문자열
VITE_API_URL=
```

**빌드 명령:**

```bash
npm run build:iis
```

내부적으로 `vite build --mode iis`를 실행하여 `.env.iis` 환경변수를 적용합니다.
빌드 결과물은 `dist/` 폴더에 생성됩니다.

### 7.4 web.config 배포

IIS는 사이트 루트에 `web.config` 파일이 있어야 URL Rewrite 규칙을 인식합니다.
프로젝트 루트의 `web.config` 파일을 빌드 후 `dist/` 폴더에 복사해야 합니다.

**자동 배포 스크립트** (`deploy_iis.bat`):

```bash
deploy_iis.bat
```

이 스크립트는 다음을 수행합니다:

1. `npm run build:iis` 실행
2. `web.config`을 `monigrid-fe/dist/web.config`로 복사

**수동 배포:**

```bash
cd monigrid-fe
npm run build:iis
cd ..
copy /Y web.config monigrid-fe\dist\web.config
```

### 7.5 web.config 구조

프로젝트 루트의 `web.config`에는 다음과 같은 URL Rewrite 규칙이 정의되어 있습니다.

```xml
<rewrite>
  <rules>
    <!-- API 경로별 프록시 -->
    <rule name="API - auth" stopProcessing="true">
      <match url="^auth/(.*)" />
      <action type="Rewrite" url="http://127.0.0.1:5000/auth/{R:1}" />
    </rule>

    <rule name="API - dashboard" stopProcessing="true">
      <match url="^dashboard/(.*)" />
      <action type="Rewrite" url="http://127.0.0.1:5000/dashboard/{R:1}" />
    </rule>

    <rule name="API - health" stopProcessing="true">
      <match url="^health$" />
      <action type="Rewrite" url="http://127.0.0.1:5000/health" />
    </rule>

    <rule name="API - logs" stopProcessing="true">
      <match url="^logs(.*)" />
      <action type="Rewrite" url="http://127.0.0.1:5000/logs{R:1}" />
    </rule>

    <rule name="API - dynamic endpoints" stopProcessing="true">
      <match url="^api/(.*)" />
      <action type="Rewrite" url="http://127.0.0.1:5000/api/{R:1}" />
    </rule>

    <!-- SPA fallback: 실제 파일이 아닌 모든 요청 → index.html -->
    <rule name="SPA fallback" stopProcessing="true">
      <match url=".*" />
      <conditions logicalGrouping="MatchAll">
        <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
        <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
      </conditions>
      <action type="Rewrite" url="/index.html" />
    </rule>
  </rules>
</rewrite>
```

| 규칙 | 매칭 경로 | 프록시 대상 |
|------|----------|------------|
| API - auth | `/auth/*` | `http://127.0.0.1:5000/auth/*` |
| API - dashboard | `/dashboard/*` | `http://127.0.0.1:5000/dashboard/*` |
| API - health | `/health` | `http://127.0.0.1:5000/health` |
| API - logs | `/logs*` | `http://127.0.0.1:5000/logs*` |
| API - dynamic endpoints | `/api/*` | `http://127.0.0.1:5000/api/*` |
| SPA fallback | 그 외 (파일/폴더 아님) | `/index.html` (정적 파일) |

> **백엔드 IP/포트 변경 시:** `web.config`의 `http://127.0.0.1:5000` 5곳을 일괄 수정하면 됩니다.
> 프론트엔드 재빌드가 필요 없습니다.

### 7.6 IIS 사이트 등록

1. **IIS Manager 실행**
2. 좌측 트리에서 **Sites** 우클릭 → **Add Website**
3. 다음 항목 입력:

   | 항목 | 값 |
   |------|----|
   | Site name | `monigrid` |
   | Physical path | `D:\workspace\dev\monigrid\monigrid-fe\dist` |
   | Binding type | `http` |
   | IP address | `All Unassigned` (또는 특정 IP) |
   | Port | `80` (또는 원하는 포트) |
   | Host name | (선택, 도메인 사용 시) |

4. **OK** 클릭 → 사이트 시작

### 7.7 Application Pool 권한 설정

기본 Application Pool 사용자 (`IIS APPPOOL\<사이트명>`)에게 `dist/` 폴더의 **읽기 권한**이 필요합니다.

```powershell
icacls "D:\workspace\dev\monigrid\monigrid-fe\dist" /grant "IIS APPPOOL\monigrid:(OI)(CI)R" /T
```

또는 GUI로:
- `dist/` 폴더 우클릭 → 속성 → 보안 → 편집 → 추가
- `IIS APPPOOL\monigrid` 입력 → 이름 확인 → 읽기 권한 부여

### 7.8 백엔드 실행

백엔드는 IIS와는 별개의 프로세스로 실행해야 합니다. 옵션:

**옵션 A: 콘솔에서 직접 실행 (개발/테스트)**

```bash
cd monigrid-be
python monigrid_be.py
```

**옵션 B: PyInstaller로 EXE 빌드 후 실행 (운영)**

```bash
cd monigrid-be
pyinstaller monigrid_be.spec
dist\monigrid-be\monigrid-be.exe
```

**옵션 C: Windows 서비스 등록 (NSSM 사용, 운영 권장)**

```bash
nssm install monigrid-be "D:\path\to\monigrid-be.exe"
nssm set monigrid-be Start SERVICE_AUTO_START
nssm start monigrid-be
```

### 7.9 동작 검증

1. **백엔드 단독 동작 확인**

   ```bash
   curl http://127.0.0.1:5000/health
   ```

2. **IIS 정적 파일 서빙 확인**

   브라우저에서 `http://localhost/`(또는 설정한 포트) 접속 → 로그인 화면 표시

3. **IIS → 백엔드 프록시 확인**

   ```bash
   curl http://localhost/health
   ```

   → 백엔드의 응답이 IIS를 거쳐서 그대로 반환되어야 합니다.

4. **다른 PC에서 접속 확인**

   같은 네트워크의 다른 PC 브라우저에서 `http://<서버IP>/` 접속 → 로그인 → 대시보드 정상 동작.
   브라우저 개발자 도구 Network 탭에서 모든 API 요청이 **`<서버IP>` 도메인으로 가는지** 확인합니다.

### 7.10 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `500.52` 에러 + "URL Rewrite Module" 메시지 | URL Rewrite 모듈 미설치 | URL Rewrite 모듈 설치 |
| `404.4 - Not Found` (API 호출만) | ARR 프록시 비활성화 | IIS Manager → 서버 노드 → ARR → Server Proxy Settings → Enable proxy 체크 |
| API 응답 502 Bad Gateway | 백엔드 미실행 / 포트 불일치 | `curl http://127.0.0.1:5000/health` 로 백엔드 살아있는지 확인 |
| 다른 PC에서 `127.0.0.1:5000` 으로 요청 가는 문제 | `VITE_API_URL` 값이 박혀있음 | `npm run build:iis`로 다시 빌드 (`.env.iis`의 빈 값 사용) |
| 새로고침 시 404 | SPA fallback 규칙 누락 | `web.config`의 SPA fallback 규칙 확인 |
| IIS 사이트는 뜨는데 정적 파일 403 | Application Pool 권한 부족 | 7.7의 `icacls` 명령으로 권한 부여 |
| 로그인 후 대시보드 흰 화면 | localStorage에 이전 API URL 캐시 | 브라우저 개발자 도구 → Application → Local Storage에서 `dashboard_api_base_url` 삭제 후 재접속 |

### 7.11 HTTPS 사용 시

HTTPS로 운영하려면 IIS 사이트 바인딩에 SSL 인증서를 추가하면 됩니다.
백엔드는 여전히 `http://127.0.0.1:5000` 평문이어도 무방합니다. (서버 내부 통신이므로 외부 노출 X)

```
브라우저 ── HTTPS ──► IIS (443) ── HTTP ──► Flask (127.0.0.1:5000)
       (암호화)              (서버 내부, 평문 OK)
```

---

## 8. Electron 데스크탑 EXE 빌드

### 8.1 사전 준비

Windows 환경에서 빌드합니다. 아래 패키지가 `npm install` 시 함께 설치됩니다.

- `electron`, `electron-builder`
- `concurrently`, `cross-env`, `wait-on`

### 8.2 Windows NSIS 설치 파일 빌드

```bash
npm run build:desktop
```

| 단계 | 내용 |
|------|------|
| 1 | `npm run build:web` — Vite로 웹 번들 빌드 (`dist/` 생성) |
| 2 | `electron-builder --win nsis` — NSIS 설치 파일 패키징 |

빌드 결과물:

```text
release/
└── monigrid-fe Setup 1.0.0.exe    ← Windows 설치 파일
```

### 8.3 포터블 ZIP 빌드 (설치 없이 실행)

```bash
npm run pack:desktop
```

`electron/package-portable.ps1` PowerShell 스크립트를 통해 설치 과정 없이 바로 실행 가능한 ZIP 패키지를 생성합니다.

### 8.4 빌드 관련 주의사항

- **코드 서명 없이 빌드**: `CSC_IDENTITY_AUTO_DISCOVERY=false` 설정으로 인증서 없이 빌드됩니다. Windows SmartScreen 경고가 표시될 수 있으나 실행에는 문제 없습니다.
- **rcedit 비활성화**: `package.json`의 `"signAndEditExecutable": false` 설정으로 winCodeSign 다운로드를 건너뜁니다. 오프라인 또는 제한된 네트워크 환경에서도 빌드됩니다.

### 8.5 EXE 실행 시 백엔드 URL 설정

Electron 앱을 처음 실행하면 로그인 화면에서 백엔드 URL을 입력합니다.
대시보드 설정(`⚙`) → **API 서버 URL** 항목에서 언제든지 변경할 수 있습니다.

---

## 9. 위젯 사용법

### 9.1 위젯 추가

1. 헤더의 **`＋`** 버튼 클릭
2. **제목** 입력
3. **위젯 타입** 선택
4. 타입에 따라 추가 정보 입력:
   - 데이터 테이블 / 웹서버 상태 체크 / 라인차트 / 바차트: **엔드포인트 URL** 입력
   - API 상태 리스트: **엔드포인트 목록** (한 줄에 하나씩, `label | url` 형식)
   - 네트워크 테스트 / 서버 리소스: 엔드포인트 URL이 백엔드 고정 경로(`/dashboard/network-test`, `/dashboard/server-resources`)로 자동 설정되며 수정 불가
5. **추가** 클릭

### 9.2 위젯 배치

| 동작 | 방법 |
|------|------|
| 이동 | 위젯 헤더 영역 드래그 |
| 크기 조절 | 위젯 우측 하단 모서리 드래그 |

변경 사항은 자동 저장됩니다.

### 9.3 위젯 공통 설정 (⚙ 버튼)

각 위젯의 헤더에서 **`⚙`** 버튼을 클릭하면 설정 팝업이 열립니다.

| 설정 항목 | 설명 |
|-----------|------|
| 제목 | 위젯 이름 변경 |
| 위젯 크기 | 가로(W) / 세로(H) 그리드 단위 직접 입력 |
| 갱신 주기 | 초 단위 (1~3600) — 해당 위젯만 독립 적용 |

### 9.4 데이터 테이블 위젯

REST API의 JSON 응답을 테이블로 자동 렌더링합니다.

**설정 방법:**
1. 위젯 추가 시 백엔드 API 엔드포인트 URL 입력 (예: `http://127.0.0.1:5000/api/status`)
2. 자동으로 JSON 응답의 키를 컬럼으로 생성

**추가 설정 (⚙):**
- **표시 컬럼 선택**: 체크박스로 컬럼 표시/숨기기
- **컬럼 폭 조절**: 컬럼 경계선 드래그
- **Criteria**: 컬럼별 임계치 조건 설정 (아래 ALERT 섹션 참조)

**행 조작:**

| 동작 | 결과 |
|------|------|
| 클릭 | 행 선택 강조 |
| 더블클릭 | 행 상세 팝업 (실시간 업데이트) |
| 선택 후 Ctrl+C | 헤더 포함 TSV 클립보드 복사 |

### 9.5 웹서버 상태 체크 위젯

단일 URL에 HTTP GET 요청을 보내 200 응답 여부를 모니터링합니다.

**설정:** 엔드포인트 URL 입력 → 주기적으로 상태 확인

### 9.6 라인차트 / 바차트 위젯

REST API의 JSON 데이터를 차트로 시각화합니다.

**설정 (⚙):**
- **X축 키**: 데이터의 어떤 필드를 X축으로 사용할지 선택
- **Y축 키**: 하나 이상의 필드를 Y축 데이터로 선택
- **시간 범위**: 전체 / 최근 N건 등

### 9.7 API 상태 리스트 위젯

여러 URL의 HTTP 200 상태를 한눈에 확인합니다.

**설정:**
- 위젯 추가 시 엔드포인트 목록을 한 줄에 하나씩 입력:
  ```
  Health | http://127.0.0.1:5000/health
  Endpoints | http://127.0.0.1:5000/dashboard/endpoints
  Log Dates | http://127.0.0.1:5000/logs/available-dates
  ```
- `label | url` 형식 (label 생략 시 URL 경로가 표시됨)
- 위젯 설정(⚙)에서 목록 편집 가능

### 9.8 네트워크 테스트 (Ping/Telnet) 위젯

Ping 또는 TCP 연결(Telnet) 테스트를 수행합니다.

**사용법:**
1. 위젯 추가 후 위젯 내부 폼에서 바로 테스트 가능
2. **드롭다운**에서 `Ping` 또는 `Telnet` 선택
3. **호스트** 입력 (IP 또는 도메인)
4. Telnet인 경우 **포트** 입력
5. **실행** 클릭 → 결과가 아래에 누적 표시

**예시 — SSH 포트 테스트:**
- 타입: `Telnet`
- 호스트: `192.168.0.71`
- 포트: `322`
- → Connection successful / Connection failed 결과와 응답시간 표시

**예시 — Ping 테스트:**
- 타입: `Ping`
- 호스트: `192.168.0.71`
- 횟수: `4`
- → Ping 성공/실패 결과와 상세 출력 표시

> 이 위젯은 별도의 서버 접속 정보 설정이 필요 없습니다. 백엔드가 직접 Ping/TCP 연결을 수행합니다.

**툴팁:** 각 타겟 항목에 마우스를 올리면 설정 정보(이름, 유형, 호스트, 포트, 타임아웃, 상태, 응답 시간, 오류)가 툴팁으로 표시됩니다.

### 9.9 서버 리소스 모니터링 (CPU/Memory/Disk) 위젯

원격 또는 로컬 서버의 CPU, 메모리, 디스크 사용률을 실시간으로 모니터링합니다.

**설정 방법:**
1. 위젯 추가 후 **`설정 열기`** 또는 **`⚙`** 클릭
2. **서버 접속 정보** 섹션에서:

   | 항목 | 설명 | 예시 |
   |------|------|------|
   | OS 타입 | 대상 서버의 운영체제 | `Linux (RHEL 8.x)`, `Windows (WMI)`, `Windows (WinRM)` |
   | 호스트 | 서버 IP 또는 도메인 | `192.168.0.71` |
   | SSH 사용자 | Linux/Windows(PowerShell) 원격 접속 계정 | `sshuser` |
   | SSH 비밀번호 | Linux/Windows(PowerShell) 원격 접속 비밀번호 | `password` |
   | SSH 포트 | SSH 포트 (기본 22) | `322` |
   | WinRM 사용자 | Windows(WinRM) 원격 접속 계정 | `Administrator` |
   | WinRM 비밀번호 | Windows(WinRM) 원격 접속 비밀번호 | `password` |
   | WinRM 포트 | WinRM 포트 (기본 5985=HTTP, 5986=HTTPS) | `5985` |
   | 도메인 | Windows 도메인 (선택) | `MYDOMAIN` |
   | Transport | WinRM 인증 방식 (선택) | `NTLM`, `Basic`, `Kerberos`, `CredSSP` |

3. **`접속 정보 적용`** 클릭
4. 자동으로 주기적 갱신 시작 (기본 30초, 설정에서 변경 가능)

**표시 정보:**
- **CPU**: 사용률 (%) — 게이지 바 + 수치
- **Memory**: 사용 GB / 전체 GB + 사용률 (%)
- **Disk**: 마운트포인트별 사용 GB / 전체 GB + 사용률 (%)
  - 마운트명이 2글자 초과 시 말줄임(`…`) 처리 (전체 이름은 마우스 오버 시 확인)
- 사용률 색상: 초록(70% 미만) → 노랑(70% 이상) — **빨간색은 Criteria 임계값 초과 시에만** 표시

**툴팁:** 각 서버 항목에 마우스를 올리면 설정 정보(이름, OS, 호스트, 포트, Criteria 임계값, 현재 사용률, 알림 상태)가 툴팁으로 표시됩니다.

**상세 팝업 (더블클릭):**
- 서버 항목을 더블클릭하면 상세 모달 팝업이 열립니다
- CPU / Memory / Disk별 사용률을 실시간 Area 차트로 표시 (recharts)
- 멀티 디스크인 경우 각 마운트별로 별도 시리즈가 추가됩니다
- 데이터 포인트는 최대 120개 (약 2분, 갱신 주기에 따라 다름)

**지원 OS:**

| OS 타입 | 수집 방식 |
|---------|-----------|
| Windows (WMI) | 로컬: WMI 명령, 원격: WMI /node 명령 |
| Windows (PowerShell) | SSH + PowerShell (paramiko) |
| Windows (WinRM) | WinRM + PowerShell (pywinrm) |
| Linux (모든 배포판) | SSH + `top`, `/proc/meminfo`, `df` |

> - 백엔드에 `paramiko` 패키지가 설치되어 있어야 Linux SSH 및 Windows PowerShell(SSH) 접속이 가능합니다.
> - 백엔드에 `pywinrm` 패키지가 설치되어 있어야 Windows WinRM 접속이 가능합니다.
> - WinRM 대상 서버에서 `winrm quickconfig` 실행으로 WinRM 서비스가 활성화되어 있어야 합니다.

---

## 10. Criteria & ALERT

### 10.1 설정 방법

1. 데이터 테이블 위젯 헤더의 **`⚙`** 클릭
2. **Criteria** 섹션에서:
   - 컬럼명 선택
   - 체크박스 활성화
   - 연산자 선택
   - 임계값 입력

### 10.2 지원 연산자

| 연산자 | 설명 | 예시 |
|--------|------|------|
| `>` | 초과 | `cpu_usage > 80` |
| `>=` | 이상 | `value >= 100` |
| `<` | 미만 | `latency < 500` |
| `<=` | 이하 | `score <= 0` |
| `==` | 같음 | `status == error` |
| `!=` | 다름 | `state != ok` |
| `contains` | 포함 | `message contains timeout` |
| `not_contains` | 미포함 | `name not_contains test` |

숫자 자동 변환: `"1,234"`, `"98%"` 형식도 수치로 변환하여 비교합니다.

### 10.3 ALERT 동작

- 조건에 해당하는 행이 있으면 위젯 헤더에 **`ALERT n`** (빨간색) 표시
- `ALERT n` 클릭 → 조건 해당 행만 필터링 (토글)
- 조건 해당 행이 없으면 **`ALERT 0`** (초록색)
- ALERT이 발생하면 알람 배너가 화면 상단에 표시되고 선택한 경고음이 재생됩니다

---

## 11. 대시보드 설정

### 11.1 헤더 아이콘 안내

| 아이콘 | 설명 |
|--------|------|
| ▦ (4분할 사각형) | 대시보드 프론트엔드 설정 (위젯 레이아웃, 줌, 알람 등) |
| ⚙ (주황색) | 백엔드 설정 (config.json 에디터, 관리자 전용) |

### 11.2 전역 설정 (▦ 헤더 버튼)

| 설정 | 설명 |
|------|------|
| API 서버 URL | 백엔드 접속 주소 (변경 시 페이지 새로고침) |
| 폰트 크기 | 위젯 내 글꼴 크기 (10~18px) |
| 위젯 영역 확대/축소 | 전체 대시보드 줌 (50~150%) |
| 알람 경고음 | Beep / Siren / Pulse / Mute |

> **주의:** 위젯 영역 확대/축소가 100%가 아닐 경우, 모든 위젯의 버튼(새로고침, 설정, 삭제 등)이 비활성화됩니다. 위젯 버튼을 사용하려면 줌을 100%로 설정하세요. 줌 슬라이더 아래에 경고 메시지가 표시됩니다.

### 11.3 설정 JSON 내보내기/가져오기

**내보내기:**
- 대시보드 설정(⚙) → **JSON 저장** 버튼
- `dashboard-config-YYYY-MM-DDTHH-MM-SS.json` 파일 다운로드

**가져오기:**
- **파일 선택** 버튼으로 JSON 업로드, 또는
- 텍스트 영역에 JSON 붙여넣기 → **JSON 로드** 버튼

### 11.4 설정 JSON 구조

```json
{
    "version": "1.0.0",
    "exportedAt": "2026-04-01T10:00:00.000Z",
    "widgets": [
        {
            "id": "api-1",
            "type": "table",
            "title": "Application Status",
            "endpoint": "http://localhost:5000/api/status",
            "refreshIntervalSec": 10,
            "defaultLayout": { "x": 0, "y": 0, "w": 4, "h": 4, "minW": 2, "minH": 2 },
            "tableSettings": {
                "visibleColumns": ["name", "status", "cpu_usage"],
                "columnWidths": {},
                "criteria": {
                    "cpu_usage": { "enabled": true, "operator": ">", "value": "80" }
                }
            }
        },
        {
            "id": "api-net-1",
            "type": "network-test",
            "title": "Network Test",
            "defaultLayout": { "x": 4, "y": 0, "w": 4, "h": 5 }
        },
        {
            "id": "api-srv-1",
            "type": "server-resource",
            "title": "Linux Server",
            "refreshIntervalSec": 30,
            "defaultLayout": { "x": 8, "y": 0, "w": 4, "h": 5 },
            "serverConfig": {
                "osType": "linux-rhel8",
                "host": "192.168.0.71",
                "username": "sshuser",
                "password": "sshpass",
                "port": "322"
            }
        },
        {
            "id": "api-status-list",
            "type": "status-list",
            "title": "API Status List",
            "endpoints": [
                { "id": "e1", "label": "Health", "url": "http://localhost:5000/health" },
                { "id": "e2", "label": "Endpoints", "url": "http://localhost:5000/dashboard/endpoints" }
            ],
            "refreshIntervalSec": 5,
            "defaultLayout": { "x": 0, "y": 5, "w": 4, "h": 5 }
        }
    ],
    "layouts": {
        "api-1": { "x": 0, "y": 0, "w": 4, "h": 4 }
    },
    "dashboardSettings": {
        "widgetFontSize": 13,
        "contentZoom": 100
    }
}
```

> 설정 JSON을 미리 내보내기로 백업해두면 레이아웃을 언제든 복원할 수 있습니다.

### 11.5 백엔드 설정 에디터 (⚙ 주황색 버튼)

관리자(admin) 전용 기능으로, 대시보드에서 백엔드의 `config.json`을 직접 편집할 수 있습니다.

**탭 구성:**

| 탭 | 설명 |
|----|------|
| 서버 | Host/Port (읽기 전용), Thread Pool Size, Refresh Interval, Query Timeout |
| 인증 | Username, Password |
| DB 연결 | DB 연결 목록 — 접기/펼치기 카드 형식, Connection ID, DB 타입, JDBC URL, 계정 |
| API 엔드포인트 | API 목록 — 접기/펼치기 카드 형식, API ID, REST 경로, Connection, SQL ID, 갱신 주기 |
| 로깅 | Log Directory, File Prefix, Log Level, Retention, Slow Query Threshold |
| 고급 | Global JDBC JARs, SQL Validation (typo patterns) |
| JSON | 전체 config.json을 raw JSON으로 직접 편집 |

**카드 접기/펼치기:**
- DB 연결 및 API 엔드포인트 카드는 헤더를 클릭하면 접거나 펼 수 있습니다
- ▶ 화살표가 접힌 상태를, ▼ 화살표가 펼쳐진 상태를 나타냅니다
- 카드가 접힌 상태에서도 Connection ID/API ID와 DB 타입/REST 경로 뱃지가 표시됩니다

**저장 & 적용:**
- **저장 & 적용** 버튼을 누르면 백엔드에 즉시 반영됩니다 (서버 재시작 불필요)
- **Reload Only** 버튼으로 현재 파일 기반 설정을 다시 로드할 수 있습니다

---

## 12. 백엔드 연동

### 12.1 필수 구성

대시보드는 `monigrid-be`와 연동됩니다. 백엔드 설정 및 실행 방법은 `../monigrid-be/README.md`를 참조하세요.

### 12.2 API 서버 URL 설정

| 방법 | 설명 |
|------|------|
| 로그인 페이지 | 첫 로그인 시 백엔드 URL 입력 |
| 대시보드 설정 | ⚙ → API 서버 URL 변경 → 적용 (페이지 새로고침) |
| 환경변수 | `VITE_API_URL=http://your-backend:5000` |

### 12.3 API 데이터 형식

데이터 테이블/차트 위젯은 다음 JSON 형식을 지원합니다:

**배열 형식 (권장):**

```json
[
    { "app_name": "ServiceA", "status": "healthy", "cpu_usage": 45.2 },
    { "app_name": "ServiceB", "status": "error",   "cpu_usage": 91.5 }
]
```

**객체 형식:**

```json
{
    "key1": { "id": "key1", "name": "Item1", "status": "active" },
    "key2": { "id": "key2", "name": "Item2", "status": "inactive" }
}
```

### 12.4 상태 값 자동 색상

| 색상 | 해당 값 예시 |
|------|------------|
| 초록 | `healthy`, `success`, `active`, `ok`, `online`, `running` |
| 빨강 | `error`, `failed`, `critical`, `inactive`, `offline`, `down` |
| 노랑 | `warning`, `pending`, `busy`, `slow` |

### 12.5 위젯 상태 뱃지

| 뱃지 | 의미 |
|------|------|
| `LIVE` (초록) | 정상 응답, 응답 시간이 갱신 주기 이내 |
| `LIVE` (노랑) | 정상 응답이나 응답 시간이 갱신 주기 초과 |
| `DEAD` (빨강) | 요청 실패 또는 비정상 상태 |

### 12.6 CORS 설정

브라우저 모드에서는 백엔드의 CORS 설정이 필요합니다.
백엔드의 `.env` 파일에 프론트엔드 URL을 추가하세요:

```env
CORS_ORIGINS=http://127.0.0.1:3000,http://localhost:3000
```

Electron 앱에서는 `file://` 프로토콜을 사용하므로 CORS 이슈가 없습니다.

---

## 13. 로컬 스토리지

대시보드는 다음 정보를 자동으로 브라우저 로컬 스토리지에 저장합니다.

| 키 | 내용 |
|----|------|
| `auth_token` | JWT 토큰 (로그인 유지) |
| `user` | 로그인 사용자 정보 |
| `dashboard_widgets` | 위젯 목록 전체 (타입, 설정, 엔드포인트 등) |
| `dashboard_layouts` | 위젯별 위치 및 크기 |
| `dashboard_settings` | 전역 설정 (폰트 크기, 줌) |
| `alarm_sound` | 선택된 알람 경고음 |
| `alarm_sound_enabled` | 경고음 활성화 여부 |
| `api_base_url` | 저장된 API 서버 URL |

### 초기화 방법

```javascript
// 브라우저 개발자 도구 (F12 > Console)에서:

// 레이아웃만 초기화
localStorage.removeItem("dashboard_layouts");

// 위젯만 초기화 (기본 위젯으로 복원됨)
localStorage.removeItem("dashboard_widgets");

// 전체 초기화 (로그아웃 됨)
localStorage.clear();
```

---

## 14. 운영 가이드

### 14.1 일상 운영

| 작업 | 방법 |
|------|------|
| 위젯 추가 | 헤더 `＋` 버튼 |
| 위젯 제거 | 위젯 헤더 `✕` 버튼 |
| 위젯 설정 변경 | 위젯 헤더 `⚙` 버튼 |
| 전체 새로고침 | 헤더 `⟳` 버튼 |
| 수동 새로고침 | 위젯 헤더 `⟳` 버튼 (위젯별) |
| 대시보드 설정 | 헤더 `▦` 버튼 (레이아웃, 줌, 알람) |
| 백엔드 설정 | 헤더 `⚙` (주황색) 버튼 (admin만 표시) |
| 로그 확인 | 헤더 📋 버튼 → 로그 뷰어 |
| SQL 편집 | 헤더 `⌘` 버튼 (admin만 표시) |

### 14.2 대시보드 배포 (웹 서버)

1. `npm run build`로 빌드
2. `dist/` 폴더를 웹 서버에 배포
3. 백엔드 URL이 올바른지 확인
4. CORS 설정 확인

### 14.3 대시보드 배포 (데스크탑 앱)

1. `npm run build:desktop`으로 EXE 빌드
2. `release/` 폴더의 설치 파일 배포
3. 사용자에게 백엔드 URL 안내

### 14.4 설정 백업 & 복원

**백업:**
1. 대시보드 설정(⚙) → **JSON 저장** → 파일 다운로드

**복원:**
1. 대시보드 설정(⚙) → **파일 선택** → 백업 파일 로드 → **JSON 로드**

> 다른 PC나 다른 사용자에게 동일한 대시보드 구성을 배포할 때 유용합니다.

### 14.5 다중 모니터 / 대시보드 운영

- 브라우저 탭 여러 개로 같은 대시보드 접속 가능
- 각 탭의 위젯은 독립적으로 데이터를 폴링
- 설정 JSON을 활용하여 용도별 대시보드 구성을 저장해두면 편리합니다

---

## 15. 트러블슈팅

### 15.1 로그인 실패

| 원인 | 해결 |
|------|------|
| 백엔드 서버 미실행 | `http://localhost:5000/health` 접속 확인 |
| 백엔드 URL 오류 | 로그인 화면에서 URL 확인 및 수정 |
| 잘못된 계정/비밀번호 | 백엔드 `config.json`의 `auth` 설정 확인 (기본: admin/admin) |
| CORS 에러 | 백엔드 `.env`의 `CORS_ORIGINS`에 프론트엔드 URL 추가 |

**진단:** 브라우저 개발자 도구(F12) > Console/Network 탭에서 에러 확인

### 15.2 데이터가 표시되지 않음

| 원인 | 해결 |
|------|------|
| 엔드포인트 URL 오류 | 위젯 설정(⚙) → URL 확인 |
| 백엔드 API 비활성화 | 백엔드 `config.json`의 `apis[].enabled` 확인 |
| JWT 토큰 만료 | 재로그인 (기본 24시간 유효) |
| 백엔드 DB 연결 실패 | 백엔드 로그 확인 (헤더 📋 버튼) |
| 네트워크 차단 | 브라우저 Network 탭에서 응답 코드 확인 |

### 15.3 위젯이 DEAD 상태로 표시됨

| 원인 | 해결 |
|------|------|
| 백엔드 응답 실패 | 위젯 `⟳` 수동 새로고침 시도 |
| 엔드포인트 URL 변경 | 위젯 설정(⚙)에서 URL 수정 |
| 캐시 에러 | 백엔드 캐시 상태 확인 (`/dashboard/cache/status`) |

### 15.4 서버 리소스 위젯이 데이터를 가져오지 못함

| 원인 | 해결 |
|------|------|
| 서버 접속 정보 미설정 | 위젯 ⚙ → 서버 접속 정보 입력 |
| SSH 접속 실패 | 호스트/포트/계정/비밀번호 확인 |
| paramiko 미설치 | 백엔드에서 `pip install paramiko` 실행 |
| WinRM 접속 실패 | 대상 서버에서 `winrm quickconfig` 실행 확인, 방화벽에서 5985/5986 포트 허용 확인 |
| pywinrm 미설치 | 백엔드에서 `pip install pywinrm` 실행 |
| WinRM 인증 실패 | 계정/비밀번호/도메인 확인, Transport 설정 확인 (기본 NTLM) |
| 방화벽 차단 | SSH 포트 또는 WinRM 포트 접근 허용 확인 |
| OS 타입 불일치 | 올바른 OS 타입 선택 (Windows WMI/PowerShell/WinRM, Linux) |

### 15.5 네트워크 테스트 위젯이 작동하지 않음

| 원인 | 해결 |
|------|------|
| 호스트 미입력 | 호스트 필드에 IP 또는 도메인 입력 |
| 텔넷 포트 미입력 | Telnet 모드에서 포트 번호 입력 |
| 백엔드 방화벽 | 백엔드 서버에서 대상 호스트로의 네트워크 접근 확인 |

### 15.6 레이아웃이 초기화됨

| 원인 | 해결 |
|------|------|
| 로컬 스토리지 삭제 | 설정 JSON 백업 파일로 복원 |
| 다른 브라우저 사용 | 각 브라우저는 독립된 로컬 스토리지 사용 |
| 시크릿 모드 | 시크릿 모드에서는 종료 시 데이터 삭제됨 |

### 15.7 EXE 빌드 실패

| 증상 | 해결 |
|------|------|
| `npm run build` 실패 | `npm install` 완료 확인, Node.js 버전 확인 |
| `electron-builder` 에러 | `package.json`에 `"signAndEditExecutable": false` 설정 확인 |
| winCodeSign 다운로드 실패 | `"toolsets": {"winCodeSign": "1.1.0"}` 설정 확인 |
| 오프라인 환경 | `npm install`을 온라인에서 먼저 실행, 이후 오프라인 빌드 |

### 15.8 Electron 앱에서 화면이 빈 페이지

| 원인 | 해결 |
|------|------|
| 빌드 누락 | `npm run build:web` 먼저 실행 확인 |
| 라우팅 문제 | Electron은 HashRouter 사용 — URL에 `#` 포함 정상 |
| 개발자 도구 확인 | Electron 창에서 `Ctrl+Shift+I`로 콘솔 에러 확인 |

---

## 16. 기술 스택

| 항목 | 사용 기술 |
|------|-----------|
| 프레임워크 | React 18 + Vite 5 |
| 상태 관리 | Zustand |
| 레이아웃 | react-grid-layout |
| 차트 | Recharts |
| HTTP 클라이언트 | Axios |
| 라우팅 | React Router v6 |
| 코드 에디터 | react-simple-code-editor + Prism.js |
| 데스크탑 패키징 | Electron + electron-builder |
| 스타일 | CSS + Tailwind CSS |
| 빌드 도구 | Vite |

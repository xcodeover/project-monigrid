# Monitoring Dashboard - 프로젝트 완성 가이드

## 🎉 프로젝트 생성 완료!

React 기반의 모니터링 대시보드 프로젝트가 완성되었습니다.

## 📁 프로젝트 구조

```
monigrid-fe/
│
├── 📄 index.html                      # HTML 진입점
├── 📄 package.json                    # 의존성 관리
├── 📄 vite.config.js                  # Vite 설정
├── 📄 tailwind.config.js              # Tailwind CSS 설정
├── 📄 postcss.config.js               # PostCSS 설정
├── 📄 .gitignore                      # Git 무시 파일
├── 📄 .env.example                    # 환경 변수 예제
├── 📄 README.md                       # 프로젝트 문서
├── 📄 IMPLEMENTATION_GUIDE.md         # 구현 가이드
├── 📄 PROJECT_SUMMARY.md              # 이 파일
│
├── 📁 public/                         # 정적 파일
│   └── (favicon, images 등)
│
└── 📁 src/                            # 소스 코드
    ├── 📄 main.jsx                    # React 진입점
    ├── 📄 App.jsx                     # 라우팅 및 인증
    │
    ├── 📁 pages/                      # 페이지 컴포넌트
    │   ├── LoginPage.jsx              # 로그인 페이지
    │   ├── LoginPage.css
    │   ├── DashboardPage.jsx          # 대시보드 페이지
    │   └── DashboardPage.css
    │
    ├── 📁 components/                 # 재사용 가능한 컴포넌트
    │   ├── DynamicTable.jsx           # 동적 테이블 컴포넌트 ⭐
    │   ├── DynamicTable.css
    │   ├── ApiCard.jsx                # API 카드 컴포넌트
    │   └── ApiCard.css
    │
    ├── 📁 hooks/                      # 커스텀 React 훅
    │   └── useApi.js                  # API 데이터 조회 훅
    │
    ├── 📁 services/                   # API 서비스 레이어
    │   └── api.js                     # Axios 인스턴스 및 API 함수
    │
    ├── 📁 store/                      # 상태 관리 (Zustand)
    │   ├── authStore.js               # 인증 상태
    │   └── dashboardStore.js          # 대시보드 상태 및 레이아웃
    │
    ├── 📁 utils/                      # 유틸리티 함수
    │   └── helpers.js                 # 포맷팅, 정렬, 필터링 등
    │
    └── 📁 styles/                     # 전역 스타일
        └── index.css                  # 글로벌 CSS 및 애니메이션
```

별도 백엔드 폴더:

```
monigrid-be/
├── 📄 monigrid_be.py              # Flask + JayDeBeApi 백엔드
├── 📄 config.json                     # DB 연결 / API / 쿼리 설정
├── 📄 requirements.txt                # Python 의존성
├── 📁 drivers/                        # JDBC jar 파일 위치
└── 📁 logs/                           # 날짜별 백엔드 로그 파일 위치
```

## 🚀 빠르게 시작하기

### 1단계: 프로젝트 설치 및 실행

```bash
cd monigrid-fe

# 의존성 설치 (이미 완료됨)
npm install

# 개발 서버 실행
npm run dev
```

브라우저에서 `http://localhost:3000` 접속

### 2단계: 백엔드 설정

#### 옵션 A: 별도 Python 백엔드 사용

```bash
cd ../monigrid-be
pip install -r requirements.txt
python monigrid_be.py
```

#### 옵션 B: 자체 백엔드 구현

[IMPLEMENTATION_GUIDE.md](./IMPLEMENTATION_GUIDE.md) 참조

### 3단계: 로그인

- **URL:** http://localhost:3000
- **사용자명:** admin
- **비밀번호:** password123 (样本 백엔드의 기본값)

### 4단계: API 추가

1. 대시보드에서 "+ API 추가" 클릭
2. API 정보 입력:
    - **제목:** CoinTrader Status
    - **URL:** http://localhost:5000/api/status
3. 추가 버튼 클릭

## ✨ 주요 기능 상세

### 1. 동적 테이블 컴포넌트 ⭐

**파일:** `src/components/DynamicTable.jsx`

자동으로 JSON 데이터 구조를 감지하고 테이블 생성:

```javascript
// 배열 형식
const data = [
  { id: 1, name: 'Item 1', status: 'active' },
  { id: 2, name: 'Item 2', status: 'inactive' }
]

// 객체 형식
const data = {
  key1: { id: 'key1', name: 'Item 1', status: 'active' },
  key2: { id: 'key2', name: 'Item 2', status: 'inactive' }
}

// 둘 다 자동으로 처리됨!
<DynamicTable data={data} title="My Data" />
```

**기능:**

- ✓ 자동 컬럼 감지
- ✓ 정렬 기능 (헤더 클릭)
- ✓ 상태 값 자동 색상화
- ✓ 반응형 디자인
- ✓ 로딩/에러 상태 표시

### 2. 동적 대시보드 레이아웃

**파일:** `src/pages/DashboardPage.jsx`, `src/store/dashboardStore.js`

**기능:**

- ✓ API별로 동적으로 카드 배치
- ✓ 배치 설정 로컬 스토리지에 자동 저장
- ✓ 앱 재로딩 시 이전 설정 복구
- ✓ 각 카드 너비 커스터마이징 (Full/Half/Third/Quarter)
- ✓ 컬럼 선택/해제

### 3. 인증 및 로그인

**파일:** `src/pages/LoginPage.jsx`, `src/store/authStore.js`

**기능:**

- ✓ JWT 토큰 기반 인증
- ✓ 로그인 상태 유지 (로컬 스토리지)
- ✓ 자동 세션 복구
- ✓ 보호된 라우트 (미로그인 시 자동 리다이렉트)
- ✓ 401 응답 시 자동 로그아웃

### 4. Prometheus 스타일 다크 테마

**파일:** `src/styles/index.css`, `tailwind.config.js`

**특징:**

- 어두운 배경 (#1a1a1a)
- 편안한 색상 조합
- 전문적인 모니터링 UI/UX
- 장시간 작업에 적합한 디자인

### 5. 실시간 데이터 갱신

**파일:** `src/hooks/useApi.js`

```javascript
// 5초마다 자동 갱신
const { data, loading, error, refetch } = useMultipleApiData(endpoints, 5000)

// 수동 갱신
<button onClick={refetch}>새로고침</button>
```

## 🛠️ 활용 예제

### 예제 1: 상태 모니터링

```javascript
// API 응답
[
    { app_id: 1, name: "CoinTrader", status: "healthy", cpu: 45.2 },
    { app_id: 2, name: "FileTransfer", status: "error", cpu: 92.1 },
];

// 자동으로:
// - 'healthy' → 초록색으로 표시
// - 'error' → 빨간색으로 표시
```

### 예제 2: 복잡한 JSON 데이터

```javascript
// 다양한 컬럼과 데이터타입
{
  "tx-1": {
    "id": "tx-1",
    "amount": 1000.50,
    "status": "completed",
    "timestamp": "2026-03-23T10:30:00Z",
    "details": { "nested": "object" }
  }
}

// 모두 자동으로 처리됨!
```

### 예제 3: 레이아웃 커스터마이징

```bash
1. 각 카드의 "⚙️" 버튼 클릭
2. 컬럼 선택 및 너비 설정
3. 자동 저장됨 (로컬 스토리지)
4. 다시 로드해도 유지됨!
```

## 📊 API 통합

### 최소 필수 엔드포인트

```
POST /auth/login                // 로그인
GET  /api/<endpoint-name>       // 데이터 조회 (배열 또는 객체)
```

### 데이터 형식

**배열 형식:**

```json
[
    { "id": 1, "name": "Item 1", "value": 100 },
    { "id": 2, "name": "Item 2", "value": 200 }
]
```

**객체 형식:**

```json
{
    "key-1": { "id": "key-1", "name": "Item 1" },
    "key-2": { "id": "key-2", "name": "Item 2" }
}
```

## 🎨 커스터마이징

### 색상 변경

[tailwind.config.js](tailwind.config.js):

```javascript
colors: {
  prometheus: {
    900: '#000000',  // 기본 검은색
    // ... 다른 색상들
  }
}
```

### 갱신 주기 변경

[src/pages/DashboardPage.jsx](src/pages/DashboardPage.jsx) L35:

```javascript
// 기본값: 5초 (5000ms)
const { data } = useMultipleApiData(endpoints, 5000);

// 10초로 변경
const { data } = useMultipleApiData(endpoints, 10000);
```

### 최대 표시 행 수 변경

[src/components/DynamicTable.jsx](src/components/DynamicTable.jsx) L16:

```javascript
// 기본값: 50행
<DynamicTable data={data} maxRows={50} />

// 100행으로 변경
<DynamicTable data={data} maxRows={100} />
```

## 📱 배포

### 빌드

```bash
npm run build
```

### 프로덕션 다리보기

```bash
npm run preview
```

### 배포할 폴더

`dist/` 폴더의 내용을 웹 서버에 배포

```bash
# 예: AWS S3
aws s3 cp dist/ s3://your-bucket-name --recursive

# 예: GitHub Pages
# dist 폴더를 gh-pages 브랜치에 푸시
```

## 🔐 보안 주의사항

1. **환경 변수 관리**
    - `.env.local` 파일에 API URL 저장
    - `.env.local`은 `.gitignore`에 포함되어야 함 ✓

2. **토큰 관리**
    - JWT 토큰은 로컬 스토리지에 저장 (선택 사항: secure httpOnly cookie 사용 권장)
    - 민감한 정보는 토큰에 포함하지 않기

3. **CORS 설정**
    - 백엔드에서 CORS 활성화
    - 필요시 특정 도메인만 허용

4. **프로덕션**
    - SECRET_KEY 변경 (monigrid-be/config.json)
    - HTTPS 사용
    - 환경 변수 파일 (.env) 보안 관리

## 📚 추가 학습 자료

- [React 공식 문서](https://react.dev)
- [Vite 공식 문서](https://vitejs.dev)
- [Zustand 상태 관리](https://zustand-demo.vercel.app)
- [Axios HTTP 클라이언트](https://axios-http.com)
- [JWT 토큰](https://jwt.io)
- [Tailwind CSS](https://tailwindcss.com)

## 🐛 문제 해결

### npm install 실패

```bash
# npm 캐시 제거 및 재설치
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

### 포트 충돌

```bash
# 다른 포트로 실행
npm run dev -- --port 3001
```

### 백엔드 연결 실패

1. 백엔드 서버 실행 확인
2. API URL 확인 (.env.local)
3. CORS 헤더 확인
4. 브라우저 개발자 도구 > Network 탭 확인

## 📞 지원 및 피드백

문제가 있거나 개선 사항이 있으면:

1. 프로젝트 README 확인
2. IMPLEMENTATION_GUIDE.md 참조
3. 브라우저 콘솔에서 에러 메시지 확인
4. 백엔드 로그 확인

## ✅ 체크리스트

시작하기 전에 다음을 확인하세요:

- [ ] Node.js 설치됨 (v18 이상)
- [ ] npm install 완료
- [ ] 백엔드 서버 준비 (monigrid-be 사용)
- [ ] .env.local 파일 생성 (선택 사항)
- [ ] npm run dev로 개발 서버 실행
- [ ] http://localhost:3000 접속 가능

## 🎉 완성!

모니터링 대시보드 프로젝트가 완성되었습니다!
이제 자신의 어플리케이션과 통합하여 사용할 수 있습니다.

행운을 빕니다! 🚀

---

**마지막 업데이트:** 2026년 3월 23일
**버전:** 1.0.0
**라이선스:** MIT

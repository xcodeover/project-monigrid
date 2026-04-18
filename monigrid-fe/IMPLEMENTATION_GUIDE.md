# 대시보드 구현 가이드

## 📋 개요

이 문서는 Monitoring Dashboard와 백엔드 시스템을 통합하는 방법을 설명합니다.

## 🔧 백엔드 구현

### 필수 엔드포인트

모니터링 대시보드가 작동하려면 다음 엔드포인트들이 필요합니다:

#### 1. 인증 엔드포인트

##### `POST /auth/login`

사용자 로그인

**요청:**

```json
{
    "username": "admin",
    "password": "password123"
}
```

**응답:**

```json
{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
        "id": 1,
        "username": "admin"
    }
}
```

**상태 코드:** 200 (성공), 401 (실패)

---

#### 2. 모니터링 데이터 엔드포인트

모든 데이터 엔드포인트는 `Authorization: Bearer <token>` 헤더가 필요합니다.

##### `GET /api/status`

어플리케이션 상태 조회

**응답 형식 (배열):**

```json
[
    {
        "app_id": 1,
        "name": "CoinTrader",
        "status": "healthy",
        "cpu_usage": 45.2,
        "memory_usage": 67.8,
        "uptime_seconds": 3600,
        "last_update": "2026-03-23T10:30:00Z",
        "version": "1.0.0"
    },
    {
        "app_id": 2,
        "name": "FileTransfer",
        "status": "active",
        "cpu_usage": 32.1,
        "memory_usage": 54.2,
        "uptime_seconds": 7200,
        "last_update": "2026-03-23T10:30:00Z",
        "version": "2.1.3"
    }
]
```

---

##### `GET /api/alerts`

알람/이벤트 조회

**응답 형식 (객체):**

```json
{
    "alert-1": {
        "alert_id": "alert-1",
        "app_name": "CoinTrader",
        "level": "error",
        "message": "High CPU usage detected",
        "timestamp": "2026-03-23T10:25:00Z",
        "acknowledged": false
    },
    "alert-2": {
        "alert_id": "alert-2",
        "app_name": "FileTransfer",
        "level": "warning",
        "message": "Memory threshold approaching",
        "timestamp": "2026-03-23T10:20:00Z",
        "acknowledged": true
    }
}
```

---

##### `GET /api/metrics`

시스템 메트릭 조회

**응답 형식:**

```json
[
    {
        "metric_id": "m-1",
        "name": "API Response Time",
        "unit": "ms",
        "value": 145.5,
        "threshold": 1000,
        "status": "ok"
    },
    {
        "metric_id": "m-2",
        "name": "Database Query Time",
        "unit": "ms",
        "value": 82.3,
        "threshold": 500,
        "status": "ok"
    }
]
```

---

## 🚀 빠른 시작 가이드

### 1. 프론트엔드 실행

```bash
cd monigrid-fe
npm install
npm run dev
```

브라우저에서 `http://localhost:3000` 접속

### 2. 백엔드 실행 (별도 폴더)

```bash
cd ../monigrid-be
pip install -r requirements.txt
python monigrid_be.py
```

백엔드는 `http://localhost:5000`에서 실행됨

### 3. 로그인

- **사용자명:** admin
- **비밀번호:** password123

### 4. API 추가

대시보드에서 "+ API 추가" 버튼 클릭:

- 제목: CoinTrader Status
- URL: http://localhost:5000/api/status

## 🎯 API 데이터 형식

### 지원하는 데이터 형식

#### 배열 형식

```json
[
    { "id": 1, "name": "Item 1", "status": "active" },
    { "id": 2, "name": "Item 2", "status": "inactive" }
]
```

#### 객체 형식

```json
{
    "key1": { "id": "key1", "name": "Item 1", "status": "active" },
    "key2": { "id": "key2", "name": "Item 2", "status": "inactive" }
}
```

### 데이터 타입

| 타입           | 예시            | 표시 방식     |
| -------------- | --------------- | ------------- |
| 문자열         | `"healthy"`     | 일반 텍스트   |
| 숫자           | `45.2`, `1000`  | 숫자 형식     |
| 불린           | `true`, `false` | ✓/✗ 표시      |
| 객체           | `{ ... }`       | [object] 버튼 |
| null/undefined | -               | - (점선)      |

### 상태 값 자동 색상 처리

다음 값들은 자동으로 색상이 처리됩니다:

| 값   | 색상   | 예시                                       |
| ---- | ------ | ------------------------------------------ |
| 성공 | 초록색 | healthy, success, active, ok, online       |
| 에러 | 빨간색 | error, failed, critical, inactive, offline |
| 경고 | 노란색 | warning, pending, busy                     |

```json
{
    "status": "healthy", // 초록색으로 표시
    "level": "error", // 빨간색으로 표시
    "state": "warning" // 노란색으로 표시
}
```

## 🔐 토큰 관리

### JWT 토큰 예제

```javascript
// 노드 환경에서 토큰 생성
const jwt = require("jsonwebtoken");

const token = jwt.sign(
    {
        user_id: "admin",
        exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    },
    "your-secret-key-change-this",
    { algorithm: "HS256" },
);

console.log("Token:", token);
```

### 프론트엔드에서 토큰 사용

대시보드는 자동으로 다음을 처리합니다:

- 로그인 시 토큰 저장
- 모든 API 요청에 토큰 추가
- 401 응답 시 자동 로그아웃

## 📊 대시보드 커스터마이징

### 컬럼 선택

각 API 카드의 "⚙️" 버튼을 클릭하여:

1. 표시할 컬럼 선택/해제
2. 카드 너비 선택
3. 자동 저장

### 레이아웃 설정

**위치 옵션:**

- **Full Width (1/1):** 전체 너비
- **Half Width (1/2):** 50% 너비, 2개 나란히
- **Third Width (1/3):** 33.3% 너비, 3개 나란히
- **Quarter Width (1/4):** 25% 너비, 4개 나란히

### 정렬 기능

테이블 헤더를 클릭하여 정렬:

- 첫 클릭: 오름차순 (▲)
- 두 번째 클릭: 내림차순 (▼)
- 세 번째 클릭: 정렬 해제

## 🔄 데이터 갱신

### 자동 갱신

- 기본 5초마다 자동 갱신
- `useMultipleApiData` 훅에서 설정 가능

### 수동 갱신

- "🔄" 버튼을 클릭하여 즉시 갱신

### 갱신 주기 변경

[DashboardPage.jsx](src/pages/DashboardPage.jsx) 수정:

```javascript
// 기본값: 5000ms (5초)
const { data, loading, error, refetch } = useMultipleApiData(endpoints, 5000);

// 10초로 변경
const { data, loading, error, refetch } = useMultipleApiData(endpoints, 10000);

// 자동 갱신 비활성화
const { data, loading, error, refetch } = useMultipleApiData(endpoints, null);
```

## 💾 로컬 스토리지

대시보드는 다음을 자동으로 저장합니다:

| 항목          | 키                  | 용도           |
| ------------- | ------------------- | -------------- |
| 인증 토큰     | `auth_token`        | 로그인 유지    |
| 사용자 정보   | `user`              | 사용자 표시    |
| 레이아웃 설정 | `dashboard_layouts` | 배치 정보 저장 |

데이터 삭제:

```javascript
// 개선자 콘솔에서
localStorage.removeItem("dashboard_layouts");
localStorage.clear(); // 모든 데이터 삭제
```

## 🐛 문제 해결

### 로그인 실패

- 백엔드 서버가 실행 중인지 확인
- 사용자명/비밀번호 확인
- 브라우저 콘솔에서 에러 메시지 확인

### API 데이터가 안 나옴

- 엔드포인트 URL 확인
- 토큰이 유효한지 확인
- CORS 설정 확인
- 브라우저 개발자 도구 > Network 탭에서 요청 확인

### 느린 로딩

- 데이터 갱신 주기 조정
- 최대 표시 행 수 감소
- 네트워크 연결 확인

## 📝 예제 실행

### 요청 예제

```bash
# JWT 토큰 획득
curl -X POST http://localhost:5000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password123"}'

# 응답에서 token 복사

# API 데이터 조회
curl -X GET http://localhost:5000/api/status \
  -H "Authorization: Bearer eyJhbGc..."
```

### Python 백엔드 예제

```python
from flask import Flask, jsonify
from flask_cors import CORS
from datetime import datetime

app = Flask(__name__)
CORS(app)

@app.route('/api/custom', methods=['GET'])
def get_custom_data():
    return jsonify([
        {
            'id': 1,
            'name': 'Custom App 1',
            'status': 'healthy',
            'cpu': 30.5,
            'memory': 60.2,
            'timestamp': datetime.now().isoformat()
        }
    ]), 200

if __name__ == '__main__':
    app.run(port=5000)
```

## 🎨 색상 커스터마이징

[tailwind.config.js](tailwind.config.js) 수정:

```javascript
theme: {
  extend: {
    colors: {
      prometheus: {
        900: '#000000',    // 가장 어두운 색
        800: '#212529',
        700: '#343a40',
        600: '#495057',
        500: '#6c757d',
        // ... 추가 색상
      }
    }
  }
}
```

## 📱 모바일 최적화

대시보드는 반응형 디자인으로 모든 기기에서 작동합니다:

- 데스크탑: 다중 컬럼
- 태블릿: 2-3 컬럼
- 모바일: 1 컬럼

## 📚 추가 리소스

- [React 문서](https://react.dev)
- [Vite 문서](https://vitejs.dev)
- [Zustand 문서](https://zustand-demo.vercel.app)
- [Axios 문서](https://axios-http.com)
- [JWT 정보](https://jwt.io)

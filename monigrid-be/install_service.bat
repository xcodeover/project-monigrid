@echo off
REM ============================================================
REM  monigrid-be Windows 서비스 등록 (NSSM 사용)
REM
REM  사전 준비:
REM    1) NSSM 설치 — https://nssm.cc/download
REM       (압축 해제 후 nssm.exe 를 PATH에 두거나 같은 폴더에 둠)
REM    2) build_backend_exe.bat 으로 dist\monigrid_be.exe 빌드 완료
REM       (또는 Python 인터프리터로 직접 실행할 수도 있음 — 아래 PYTHON_MODE 참고)
REM    3) 관리자 권한으로 이 배치 실행
REM
REM  서비스 제거: uninstall_service.bat
REM ============================================================

setlocal

set SERVICE_NAME=MoniGridBackend
set SERVICE_DISPLAY=MoniGrid backend
set SERVICE_DESC=MoniGrid monitoring backend (Flask + JDBC) — managed by NSSM

REM ── 실행 파일 경로 ────────────────────────────────────────
REM   기본: PyInstaller로 빌드된 exe 사용 (build_backend_exe.bat 결과물).
REM   Python 모드를 쓰려면 PYTHON_MODE=1 로 호출하고
REM   PYTHON_EXE / SCRIPT_PATH 를 환경에 맞게 수정하세요.
set BASE_DIR=%~dp0
set EXE_PATH=%BASE_DIR%dist\monigrid_be\monigrid_be.exe

if "%PYTHON_MODE%"=="1" (
    set "EXE_PATH=python.exe"
    set "APP_ARGS=%BASE_DIR%monigrid_be.py"
    set "WORK_DIR=%BASE_DIR%"
) else (
    if not exist "%EXE_PATH%" (
        echo [ERROR] %EXE_PATH% not found.
        echo         build_backend_exe.bat 으로 먼저 빌드하거나
        echo         PYTHON_MODE=1 환경변수를 설정해 Python 모드로 등록하세요.
        exit /b 1
    )
    set "APP_ARGS="
    for %%I in ("%EXE_PATH%") do set "WORK_DIR=%%~dpI"
)

where nssm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] nssm.exe 를 PATH에서 찾을 수 없습니다.
    echo         https://nssm.cc/download 에서 받아 PATH에 두거나
    echo         이 폴더에 nssm.exe 를 복사하세요.
    exit /b 1
)

REM ── 기존 서비스가 있으면 정지/제거 후 재설치 ─────────────
sc query "%SERVICE_NAME%" >nul 2>nul
if not errorlevel 1 (
    echo [INFO] 기존 서비스 %SERVICE_NAME% 를 정지하고 제거합니다...
    nssm stop "%SERVICE_NAME%" >nul 2>nul
    nssm remove "%SERVICE_NAME%" confirm >nul 2>nul
)

echo [INFO] 서비스 등록 중...
nssm install "%SERVICE_NAME%" "%EXE_PATH%" %APP_ARGS%
if errorlevel 1 (
    echo [ERROR] 서비스 등록 실패
    exit /b 1
)

REM ── 서비스 메타데이터 ─────────────────────────────────────
nssm set "%SERVICE_NAME%" DisplayName "%SERVICE_DISPLAY%"
nssm set "%SERVICE_NAME%" Description "%SERVICE_DESC%"
nssm set "%SERVICE_NAME%" Start SERVICE_AUTO_START
nssm set "%SERVICE_NAME%" AppDirectory "%WORK_DIR%"

REM ── 환경변수: 운영용 WSGI 서버 사용 강제 ───────────────────
nssm set "%SERVICE_NAME%" AppEnvironmentExtra ^
    USE_WAITRESS=1 ^
    FLASK_ENV=production

REM ── 표준 출력/에러를 파일로 리다이렉트 (서비스 모드에서 콘솔 없음) ─
set LOG_DIR=%BASE_DIR%logs
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
nssm set "%SERVICE_NAME%" AppStdout "%LOG_DIR%\service-stdout.log"
nssm set "%SERVICE_NAME%" AppStderr "%LOG_DIR%\service-stderr.log"
nssm set "%SERVICE_NAME%" AppRotateFiles 1
nssm set "%SERVICE_NAME%" AppRotateBytes 10485760

REM ── 충돌 시 자동 재시작 ──────────────────────────────────
nssm set "%SERVICE_NAME%" AppExit Default Restart
nssm set "%SERVICE_NAME%" AppRestartDelay 5000

echo [INFO] 서비스 시작 중...
nssm start "%SERVICE_NAME%"
if errorlevel 1 (
    echo [WARN] 서비스 시작 실패 — 이벤트뷰어 또는 %LOG_DIR% 확인
    exit /b 1
)

echo.
echo ============================================================
echo  서비스 %SERVICE_NAME% 등록 및 시작 완료
echo  - 상태 확인: sc query %SERVICE_NAME%
echo  - 중지     : nssm stop %SERVICE_NAME%
echo  - 시작     : nssm start %SERVICE_NAME%
echo  - 제거     : uninstall_service.bat
echo  - 로그     : %LOG_DIR%
echo ============================================================

endlocal

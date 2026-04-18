@echo off
REM ============================================================
REM  monigrid-be Windows 서비스 제거 (NSSM)
REM  관리자 권한으로 실행하세요.
REM ============================================================

setlocal
set SERVICE_NAME=MoniGridBackend

where nssm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] nssm.exe 를 PATH에서 찾을 수 없습니다.
    exit /b 1
)

sc query "%SERVICE_NAME%" >nul 2>nul
if errorlevel 1 (
    echo [INFO] 서비스 %SERVICE_NAME% 가 등록되어 있지 않습니다.
    exit /b 0
)

echo [INFO] 서비스 정지 중...
nssm stop "%SERVICE_NAME%" >nul 2>nul

echo [INFO] 서비스 제거 중...
nssm remove "%SERVICE_NAME%" confirm
if errorlevel 1 (
    echo [ERROR] 서비스 제거 실패
    exit /b 1
)

echo [INFO] 서비스 %SERVICE_NAME% 가 제거되었습니다.
endlocal

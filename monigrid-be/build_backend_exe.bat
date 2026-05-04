@echo off
setlocal

cd /d "%~dp0"

echo ============================================================
echo   monigrid-be  Build Script
echo ============================================================
echo.

echo [1/5] Installing Python dependencies...
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: pip install failed.
    exit /b 1
)

echo.
echo [2/5] Cleaning previous build artifacts...
:: Only remove PyInstaller outputs, preserve user-editable files
if exist "dist\_internal" rmdir /S /Q "dist\_internal"
if exist "dist\monigrid-be.exe" del /Q "dist\monigrid-be.exe"
if exist "dist\monigrid-be" rmdir /S /Q "dist\monigrid-be"
if exist "build" rmdir /S /Q "build"

echo.
echo [3/5] Building monigrid-be (onedir) with PyInstaller...
:: spec 의 빌드 후 코드가 dist\monigrid-be\{exe,_internal} → dist\ 로 평탄화한다
pyinstaller --noconfirm --clean monigrid_be.spec
if errorlevel 1 (
    echo ERROR: PyInstaller build failed.
    exit /b 1
)

echo.
echo [4/5] Ensuring editable runtime files in dist\...

:: initsetting.json — seed from example template if neither the real file
:: nor an existing deployment copy is present. Contains DB credentials, so
:: operators MUST edit after first copy.
if not exist "dist\initsetting.json" (
    if exist "initsetting.json" (
        copy /Y "initsetting.json" "dist\initsetting.json"
        echo   initsetting.json copied
    ) else if exist "initsetting.example.json" (
        copy /Y "initsetting.example.json" "dist\initsetting.json"
        echo   initsetting.json seeded from example — EDIT CREDENTIALS before first run
    )
) else (
    echo   initsetting.json already exists, keeping as-is
)

:: config.json — only needed for the one-time bootstrap seed. Copy if
:: missing AND no config.json.bak exists yet (i.e. the settings DB hasn't
:: been seeded on this host).
if not exist "dist\config.json" (
    if not exist "dist\config.json.bak" (
        copy /Y "config.json" "dist\config.json"
        echo   config.json copied (used only for first-run seed)
    )
) else (
    echo   config.json already exists, keeping as-is
)

:: sql\ — only needed for the one-time bootstrap seed. Keep alongside the
:: exe so first-run seeding can import files into the settings DB.
if not exist "dist\sql" (
    xcopy /E /I /Q "sql" "dist\sql"
    echo   sql\ copied (used only for first-run seed)
) else (
    echo   sql\ already exists, keeping as-is
)

:: drivers\ — copy only if not already present
if not exist "dist\drivers" (
    xcopy /E /I /Q "drivers" "dist\drivers"
    echo   drivers\ copied
) else (
    echo   drivers\ already exists, keeping as-is
)

:: .env.example — always overwrite (reference file)
if exist ".env.example" copy /Y ".env.example" "dist\.env.example"

echo.
echo [5/5] Creating logs directory...
if not exist "dist\logs" mkdir "dist\logs"

echo.
echo ============================================================
echo   Build complete!
echo ============================================================
echo.
echo   Output folder : dist\
echo.
echo   monigrid-be.exe        - executable
echo   _internal\             - Python runtime (do not edit)
echo   initsetting.json       - settings DB connection (edit before first run)
echo   config.json            - one-time seed (renamed to .bak after bootstrap)
echo   sql\                   - one-time seed for SQL queries
echo   drivers\               - JDBC driver JARs
echo   logs\                  - log output directory
echo   .env.example           - environment variable reference
echo.
echo   Run:  dist\monigrid-be.exe
echo   Test: python exe_api_smoke_test.py
echo.
endlocal

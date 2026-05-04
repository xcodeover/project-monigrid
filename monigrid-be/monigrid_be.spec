# -*- mode: python ; coding: utf-8 -*-
#
# --onedir build: Python code is bundled into _internal/, while
# config.json, sql/, and drivers/ are placed next to the exe so
# operators can edit them without rebuilding.
#
# 빌드 호스트의 site-packages 에 numpy / PyQt5 / matplotlib / sphinx 등
# 무관한 패키지가 설치되어 있으면 PyInstaller 의 의존성 분석이 이들을
# 끌어들여 _internal 이 수백 MB 비대해진다. 특히 numpy 가 가져오는 MKL
# DLL 만으로 600MB 이상이다. 본 프로젝트는 requirements.txt 에 명시된
# 패키지(Flask·waitress·pydantic·jaydebeapi·paramiko·pywinrm·requests)
# 외에는 사용하지 않으므로, 명시적 excludes 로 차단해 빌드 산출물을
# 최소화한다.

import os
import shutil


# 산출물 이름 — EXE / COLLECT / 빌드 후 평탄화 로직에서 공통으로 사용.
APP_NAME = 'monigrid-be'


# ── 제외 목록 ────────────────────────────────────────────────────────────────
# 코드베이스가 직접 import 하지 않는 대형 패키지. 호스트 환경에 설치되어
# 있더라도 산출물에서 배제된다. 새 패키지를 requirements 에 추가했다면
# 이 목록을 점검하여 충돌이 없는지 확인할 것.
EXCLUDES = [
    # 수치/과학 스택 — 사용하지 않음. MKL DLL ≈ 600MB 제거의 핵심.
    'numpy', 'scipy', 'pandas', 'numba', 'sympy',
    'mkl', 'mkl_fft', 'mkl_random', 'mkl_service',

    # 플롯/이미지/폰트 — 사용하지 않음.
    'matplotlib', 'PIL', 'Pillow', 'contourpy', 'cycler',
    'fonttools', 'kiwisolver', 'pyparsing',

    # GUI 툴킷 — 백엔드 서버에서 절대 불필요.
    'PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'sip', 'shiboken2', 'shiboken6',
    'tkinter', '_tkinter', 'Tkinter', 'tcl', 'tk', 'turtle',

    # 문서 빌더 / 정적 분석 / 개발 도구 — 런타임 불필요.
    'sphinx', 'sphinxcontrib', 'docutils', 'alabaster', 'snowballstemmer',
    'imagesize',
    'jedi', 'parso', 'mypy', 'mypy_extensions',
    'pylint', 'pyflakes', 'pycodestyle', 'astroid',
    'black', 'isort', 'autopep8',

    # Jupyter / IPython 스택 — 런타임 불필요.
    'IPython', 'ipython', 'ipykernel', 'ipywidgets',
    'jupyter', 'jupyter_client', 'jupyter_core', 'jupyter_server',
    'notebook', 'nbformat', 'nbconvert', 'nbclient',
    'qtconsole', 'qtpy', 'traitlets',

    # 비동기 / 메시징 — 사용하지 않음.
    'zmq', 'tornado',

    # 기타 무관한 라이브러리.
    'lxml',
    'babel',          # sphinx / flask-babel 이 끌고 옴, i18n 미사용
    'pytz',           # babel 이 끌고 옴 — 현재 코드 미사용

    # 테스트 / 패키징 도구 — 런타임 불필요.
    'pytest', '_pytest', 'pluggy', 'iniconfig', 'tomlkit',
    'setuptools', 'pip', 'wheel', 'pkg_resources', 'distutils',

    # 빌드 도구 자체.
    'PyInstaller',
]


# ── UPX 호환성 — 압축 시 손상되거나 서명 검증을 깨는 DLL 은 제외 ──────────
# UPX 가 PATH 에 없으면 upx=True 는 무시되지만, 향후 UPX 도입 시 안전하도록
# 명시한다.
UPX_EXCLUDE = [
    'vcruntime140.dll', 'vcruntime140_1.dll',
    'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
    'python311.dll', 'python312.dll', 'python313.dll',
    'libcrypto-3-x64.dll', 'libssl-3-x64.dll',
]


a = Analysis(
    ['monigrid_be.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        # app 패키지 소스를 함께 포함해 traceback 시 소스 라인이 표시되도록 함.
        # (PYZ 의 컴파일된 바이트코드만으로는 traceback 이 [source unavailable] 로 나옴)
        ('app/*.py', 'app'),
        ('app/routes/*.py', 'app/routes'),
    ],
    hiddenimports=[
        # app 패키지 — 정적 분석으로도 잡히지만 명시한다.
        'app',
        'app.auth',
        'app.cache',
        'app.config',
        'app.db',
        'app.db_health_service',
        'app.endpoint_cache_manager',
        'app.exceptions',
        'app.jdbc_executor',
        'app.log_reader',
        'app.sql_editor_service',
        'app.http_health_checker',
        'app.logging_setup',
        'app.network_tester',
        'app.server_resource_collector',
        'app.service',
        'app.settings_store',
        'app.sql_validator',
        'app.utils',
        # app.routes — __init__.py 에서 import 되는 모든 라우트 모듈.
        'app.routes',
        'app.routes.admin_user_routes',
        'app.routes.auth_routes',
        'app.routes.dashboard_routes',
        'app.routes.dynamic_routes',
        'app.routes.health_proxy_routes',
        'app.routes.monitor_routes',
        'app.routes.network_routes',
        'app.routes.server_routes',
        'app.routes.system_routes',
        'app.routes.user_preferences_routes',
        # Flask / Werkzeug 내부 — 가끔 정적 분석이 놓침.
        'flask',
        'flask_cors',
        'flask_limiter',
        'flask_limiter.util',
        'werkzeug',
        'werkzeug.exceptions',
        'pydantic',
        'dotenv',
        # JDBC bridge.
        'jaydebeapi',
        'jpype',
        'jpype._jvmfinder',
        'jpype.imports',
        # SSH 원격 실행.
        'paramiko',
        # WinRM 원격 실행 — _collect_windows_winrm 에서 lazy import 되므로
        # 정적 분석이 놓칠 수 있음. requests_ntlm / pyspnego 도 명시.
        'winrm',
        'requests_ntlm',
        # HTTP 클라이언트.
        'requests',
        # 운영용 WSGI 서버 — _run_server 안에서 lazy import 되므로 명시 필요.
        'waitress',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
    # optimize=1: assert 제거 (-O 와 동일). 2 는 docstring 까지 제거하지만
    # 일부 라이브러리가 docstring 을 디스크립터로 사용하므로 1 을 유지.
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=UPX_EXCLUDE,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=UPX_EXCLUDE,
    name=APP_NAME,
)


# ── 빌드 후 평탄화: dist/<APP_NAME>/{exe,_internal} → dist/{exe,_internal} ──
# PyInstaller onedir 빌드는 기본적으로 한 단계 더 깊은 폴더 (dist/monigrid-be/)
# 안에 산출물을 만든다. 운영 시 dist 바로 아래에 exe 와 _internal 이 있는 편이
# 배포·실행에 편리하므로 빌드가 끝난 직후 한 단계 위로 끌어올린다.
# spec 은 pyinstaller 실행 중 exec() 되므로 COLLECT 가 끝난 시점에 이 코드가
# 동기적으로 동작한다 — pyinstaller 를 bat 없이 직접 호출해도 동일하게 작동.
_collected_dir = os.path.join(DISTPATH, APP_NAME)
if os.path.isdir(_collected_dir):
    for _entry in os.listdir(_collected_dir):
        _src = os.path.join(_collected_dir, _entry)
        _dst = os.path.join(DISTPATH, _entry)
        if os.path.exists(_dst):
            if os.path.isdir(_dst):
                shutil.rmtree(_dst)
            else:
                os.remove(_dst)
        shutil.move(_src, _dst)
    os.rmdir(_collected_dir)

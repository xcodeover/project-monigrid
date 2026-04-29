# -*- mode: python ; coding: utf-8 -*-
#
# --onedir build: Python code is bundled into _internal/, while
# config.json, sql/, and drivers/ are placed next to the exe so
# operators can edit them without rebuilding.

import os

a = Analysis(
    ['monigrid_be.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        # app package (all .py modules)
        ('app/*.py', 'app'),
        # app.routes subpackage
        ('app/routes/*.py', 'app/routes'),
    ],
    hiddenimports=[
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
        'app.routes',
        'app.routes.auth_routes',
        'app.routes.dashboard_routes',
        'app.routes.dynamic_routes',
        'app.routes.health_proxy_routes',
        'app.routes.network_routes',
        'app.routes.server_routes',
        'app.routes.system_routes',
        # Flask / Werkzeug internals sometimes missed
        'flask',
        'flask_cors',
        'flask_limiter',
        'flask_limiter.util',
        'werkzeug',
        'werkzeug.exceptions',
        'pydantic',
        'dotenv',
        'jaydebeapi',
        'jpype',
        'jpype._jvmfinder',
        'jpype.imports',
        # SSH remote execution (server resource monitoring)
        'paramiko',
        # HTTP client (health-check proxy)
        'requests',
        # Production WSGI server (lazy-imported in _run_server, so PyInstaller
        # cannot detect it via static analysis — must be listed explicitly)
        'waitress',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    name='monigrid-be',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
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
    upx_exclude=[],
    name='monigrid-be',
)

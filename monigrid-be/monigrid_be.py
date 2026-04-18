"""
Monitoring Backend — entry point.

Initializes the Flask application, configures middleware, registers
routes via the `app.routes` package, and starts the HTTP server. All
business logic lives in the `app/` package (SRP-compliant modules).
"""
from __future__ import annotations

import logging
import os
import sys
from time import perf_counter as _request_perf_counter

from dotenv import load_dotenv
from flask import Flask, g as _flask_g, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from werkzeug.exceptions import HTTPException

load_dotenv()

from app.auth import get_env
from app.config import build_app_config
from app.logging_setup import configure_logging, install_global_exception_hooks
from app.routes import register_all_routes
from app.service import MonitoringBackend
from app.settings_store import SettingsStore, load_init_settings
from app.utils import get_client_ip


# ── Resolve paths ─────────────────────────────────────────────────────────────

def _resolve_base_dir() -> str:
    """Return the directory that holds initsetting.json, drivers/, and the
    one-time config.json seed (renamed to config.json.bak after bootstrap).

    - Dev mode  : directory of this .py file
    - onefile   : sys._MEIPASS  (temp extraction dir, all data bundled inside)
    - onedir    : directory of the exe  (operator-editable files live beside
                  the exe, not inside _internal/)
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _resolve_base_dir()
INIT_SETTINGS_PATH = os.environ.get(
    "MONITORING_INIT_SETTINGS_PATH",
    os.path.join(BASE_DIR, "initsetting.json"),
)
SEED_CONFIG_PATH = os.environ.get(
    "MONITORING_CONFIG_PATH",
    os.path.join(BASE_DIR, "config.json"),
)
SEED_SQL_DIR = os.path.join(BASE_DIR, "sql")


# ── Bootstrap: load settings DB, run first-time seed if needed ───────────────

def _read_seed_config() -> dict:
    import json
    with open(SEED_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _bootstrap_settings_store() -> SettingsStore:
    init_cfg = load_init_settings(INIT_SETTINGS_PATH)
    store = SettingsStore(settings_db=init_cfg, logger=logging.getLogger("monitoring_backend"))
    store.connect()

    if store.is_bootstrapped():
        return store

    # First-run: create schema, seed from config.json + sql/*.sql, rename
    # config.json to .bak so no one edits the stale file.
    if not os.path.isfile(SEED_CONFIG_PATH):
        raise RuntimeError(
            "Settings DB is not bootstrapped yet and seed config.json is missing at "
            f"{SEED_CONFIG_PATH}. Provide a config.json for first-time seeding or "
            "restore the settings DB from another node."
        )
    seed = _read_seed_config()
    store.create_schema()
    store.seed_from_config(seed, SEED_SQL_DIR)
    try:
        backup_path = SEED_CONFIG_PATH + ".bak"
        if os.path.exists(backup_path):
            os.remove(backup_path)
        os.rename(SEED_CONFIG_PATH, backup_path)
    except OSError as exc:
        # Non-fatal: seeding succeeded. Operators can rename manually.
        logging.getLogger("monitoring_backend").warning(
            "Seed succeeded but failed to rename %s to .bak: %s", SEED_CONFIG_PATH, exc,
        )
    return store


def _load_config_from_store(store: SettingsStore):
    return build_app_config(store.load_config_dict(), BASE_DIR)


settings_store = _bootstrap_settings_store()
initial_config = _load_config_from_store(settings_store)
configure_logging(initial_config.logging)

backend = MonitoringBackend(
    settings_store=settings_store,
    config_reloader=lambda: _load_config_from_store(settings_store),
    logger=logging.getLogger("monitoring_backend"),
    initial_config=initial_config,
)
install_global_exception_hooks(backend.logger)


# ── Flask app factory ─────────────────────────────────────────────────────────

app = Flask(__name__)

CORS(
    app,
    resources={r"/*": {"origins": "*"}},
    supports_credentials=False,
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

limiter = Limiter(
    app=app,
    key_func=get_client_ip,
    default_limits=[initial_config.rate_limits.global_default],
)


# ── Middleware ────────────────────────────────────────────────────────────────

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response


@app.before_request
def handle_preflight_and_log_entry():
    if request.method == "OPTIONS":
        return "", 204
    if backend.logger.isEnabledFor(logging.DEBUG):
        _flask_g._req_started = _request_perf_counter()
        backend.logger.debug(
            "HTTP request method=%s path=%s query=%s clientIp=%s",
            request.method, request.path, request.query_string.decode("utf-8", "replace"),
            get_client_ip(),
        )
    return None


@app.after_request
def log_request_completion(response):
    if backend.logger.isEnabledFor(logging.DEBUG):
        started = getattr(_flask_g, "_req_started", None)
        duration_ms = (
            int((_request_perf_counter() - started) * 1000) if started is not None else -1
        )
        backend.logger.debug(
            "HTTP response method=%s path=%s status=%s durationMs=%s clientIp=%s",
            request.method, request.path, response.status_code, duration_ms, get_client_ip(),
        )
    return response


# ── Route registration ────────────────────────────────────────────────────────

register_all_routes(app, backend, limiter)


# ── Error handler ─────────────────────────────────────────────────────────────

@app.errorhandler(Exception)
def handle_unexpected_server_error(error):
    if isinstance(error, HTTPException):
        return error
    backend.logger.exception(
        "Unhandled Flask exception method=%s path=%s clientIp=%s",
        request.method, request.path, get_client_ip(),
    )
    return jsonify({"message": "internal server error"}), 500


# ── Entry point ───────────────────────────────────────────────────────────────

def _run_server() -> None:
    """Start the HTTP server.

    서버 선택 규칙:
      - 환경변수 USE_WAITRESS=1  또는 USE_WAITRESS 미설정 + 프로덕션 모드(기본)
        → waitress (운영용 WSGI, Windows 서비스 권장)
      - 환경변수 USE_WAITRESS=0 또는 FLASK_ENV=development
        → werkzeug (개발 서버; 자동 리로드는 사용 안 함)

    Windows 서비스로 등록해 사용하는 경우 NSSM 등에서 이 진입점을 그대로 호출하면 된다.
    """
    use_waitress_env = (get_env("USE_WAITRESS", "1") or "1").strip().lower()
    flask_env = (get_env("FLASK_ENV", "production") or "production").strip().lower()
    use_waitress = use_waitress_env in ("1", "true", "yes") and flask_env != "development"

    host = backend.config.host
    port = backend.config.port

    if use_waitress:
        try:
            from waitress import serve as _waitress_serve
        except ImportError:
            backend.logger.warning(
                "waitress not installed — falling back to werkzeug development server. "
                "Install with: pip install waitress",
            )
            use_waitress = False

    backend.logger.info(
        "Starting MonitoringBackend host=%s port=%s server=%s",
        host, port, "waitress" if use_waitress else "werkzeug",
    )

    if use_waitress:
        threads = int(get_env("WAITRESS_THREADS", "16"))
        _waitress_serve(app, host=host, port=port, threads=threads, ident="monigrid-be")
    else:
        app.run(
            debug=False,
            host=host,
            port=port,
            threaded=True,
            use_reloader=False,
        )


if __name__ == "__main__":
    try:
        _run_server()
    except Exception:
        backend.logger.exception("FATAL: MonitoringBackend terminated unexpectedly")
        raise
    finally:
        backend._stop_background_refreshers()
        backend._close_all_pools()
        try:
            settings_store.close()
        except Exception:
            backend.logger.exception("Failed to close settings store")
        backend.logger.info("MonitoringBackend process stopped")

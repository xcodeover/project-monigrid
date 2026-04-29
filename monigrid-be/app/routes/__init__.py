"""HTTP route registration package.

Each submodule exposes a `register(app, backend, limiter)` function that
attaches its handlers via `app.add_url_rule(...)`. This preserves endpoint
names exactly (no Blueprint name prefix) so the URL map stays identical
to the legacy monolithic registration in monigrid_be.py.

SRP rationale: each module groups handlers by domain responsibility:
    auth_routes      — login / logout
    dashboard_routes — endpoint listing, cache, sql-editor, db-health, config
    server_routes    — remote/local server resource collection
    network_routes   — ping / telnet diagnostics
    health_proxy_routes — outbound HTTP health-check proxy
    system_routes    — /health, /logs
    dynamic_routes   — generic catch-all that maps URL → cached endpoint
"""
from __future__ import annotations

from . import (
    admin_user_routes,
    auth_routes,
    dashboard_routes,
    dynamic_routes,
    health_proxy_routes,
    monitor_routes,
    network_routes,
    server_routes,
    system_routes,
    user_preferences_routes,
)


def register_all_routes(app, backend, limiter) -> None:
    """Register every route group on the given Flask app."""
    auth_routes.register(app, backend, limiter)
    dashboard_routes.register(app, backend, limiter)
    server_routes.register(app, backend, limiter)
    network_routes.register(app, backend, limiter)
    monitor_routes.register(app, backend, limiter)
    user_preferences_routes.register(app, backend, limiter)
    admin_user_routes.register(app, backend, limiter)
    health_proxy_routes.register(app, backend, limiter)
    system_routes.register(app, backend, limiter)
    dynamic_routes.register(app, backend, limiter)

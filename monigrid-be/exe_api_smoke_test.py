import json
import urllib.request
import urllib.error


def build_headers(token: str | None = None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def get_json(url: str, token: str | None = None):
    request = urllib.request.Request(url, headers=build_headers(token), method="GET")
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def post_json(url: str, payload: dict, token: str | None = None):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers=build_headers(token),
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def main():
    health = get_json("http://127.0.0.1:5000/health")
    login = post_json(
        "http://127.0.0.1:5000/auth/login",
        {"username": "admin", "password": "admin"},
    )
    token = str(login.get("token", ""))
    endpoints = get_json("http://127.0.0.1:5000/dashboard/endpoints", token)
    logs = get_json(
        "http://127.0.0.1:5000/logs?max_lines=20&follow_latest=true",
        token,
    )
    cache_refresh = post_json(
        "http://127.0.0.1:5000/dashboard/cache/refresh",
        {"api_id": "status", "reset_connection": True},
        token,
    )

    print(f"HEALTH_STATUS={health.get('status')}")
    print(f"LOGIN_TOKEN_PREFIX={token[:6]}")
    print(f"ENDPOINT_COUNT={len(endpoints)}")
    print(f"LOG_COUNT={logs.get('count')}")
    print(f"CACHE_REFRESH_OK={cache_refresh.get('ok')}")

    try:
        status_data = get_json("http://127.0.0.1:5000/api/status", token)
        if isinstance(status_data, list):
            print(f"STATUS_API=SUCCESS ARRAY_COUNT={len(status_data)}")
        else:
            print("STATUS_API=SUCCESS OBJECT")
    except urllib.error.HTTPError as error:
        print(f"STATUS_API=HTTP_ERROR {error.code}")
    except Exception as error:  # noqa: BLE001
        print(f"STATUS_API=ERROR {error}")


if __name__ == "__main__":
    main()

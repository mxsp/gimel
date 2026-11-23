"""Tests for /api/system/info and /api/system/settings."""

from __future__ import annotations

from gimel.version import APP_NAME, APP_VERSION, ENGINE_VERSION, VERSION_LABEL


def _create_staff_headers(client, username: str, password: str) -> dict[str, str]:
    r_create = client.post(
        "/api/accounts",
        json={"username": username, "password": password, "role": "staff"},
    )
    assert r_create.status_code in (201, 409), r_create.text
    r_login = client.post(
        "/api/auth/login",
        data={"username": username, "password": password},
    )
    assert r_login.status_code == 200, r_login.text
    return {"Authorization": f"Bearer {r_login.json()['access_token']}"}


def test_system_info_requires_auth(client):
    r = client.get("/api/system/info", headers={"Authorization": ""})
    assert r.status_code == 401


def test_system_info_admin_and_staff(client):
    r_admin = client.get("/api/system/info")
    assert r_admin.status_code == 200, r_admin.text
    data = r_admin.json()

    assert data["app_name"] == APP_NAME
    assert data["version"] == APP_VERSION
    assert data["engine_version"] == ENGINE_VERSION
    assert data["version_label"] == VERSION_LABEL
    assert data["mode"] in ("playground", "production")
    assert isinstance(data["demo"], bool)
    assert data["install_kind"] in ("binary", "docker", "git", "package")
    assert isinstance(data["git_commit"], str)
    assert isinstance(data["git_branch"], str)
    assert isinstance(data["python_version"], str) and len(data["python_version"]) > 0
    assert isinstance(data["platform"], str) and len(data["platform"]) > 0
    assert isinstance(data["hostname"], str) and len(data["hostname"]) > 0
    assert set(data["docker"].keys()) == {"installed", "version", "running"}
    assert isinstance(data["localnet_only"], bool)
    assert isinstance(data["lan_ips"], list)
    assert isinstance(data["uptime_seconds"], int) and data["uptime_seconds"] >= 0
    assert isinstance(data["started_at"], str) and len(data["started_at"]) > 0
    assert data["license"] == "Gimel Non-Commercial Source License (v1.0)"
    assert data["repo_url"] == "https://github.com/mxsp/gimel"
    assert data["releases_url"] == "https://github.com/mxsp/gimel/releases"
    assert data["website_url"] == "https://fyreflysystems.de/scientific/gimel/"
    assert isinstance(data["data_dir"], str) and len(data["data_dir"]) > 0
    assert data["database_backend"] in ("sqlite", "postgresql")
    assert set(data["update"].keys()) == {
        "latest_version",
        "latest_tag",
        "update_available",
        "release_url",
    }

    staff_headers = _create_staff_headers(client, "sysinfo-staff", "Werkbank-99!")
    r_staff = client.get("/api/system/info", headers=staff_headers)
    assert r_staff.status_code == 200, r_staff.text
    staff_data = r_staff.json()
    assert staff_data["version"] == APP_VERSION
    assert staff_data["data_dir"] == ""


def test_system_settings_read_and_admin_patch(client):
    r_get = client.get("/api/system/settings")
    assert r_get.status_code == 200, r_get.text
    initial = r_get.json()
    assert initial["instance_name"] == "Gimel"
    assert initial["update_channel"] == "stable"
    assert initial["auto_check_updates"] is True
    assert initial["default_language"] == "de"
    assert initial["telemetry_enabled"] is False
    assert "100% lokal" in initial["telemetry_notice"]

    # Non-admin cannot patch
    staff_headers = _create_staff_headers(client, "sysset-staff", "Werkbank-99!")
    r_staff_get = client.get("/api/system/settings", headers=staff_headers)
    assert r_staff_get.status_code == 200
    r_staff_patch = client.patch(
        "/api/system/settings",
        headers=staff_headers,
        json={"instance_name": "Hacked"},
    )
    assert r_staff_patch.status_code == 403

    # Admin can patch and values persist
    r_patch = client.patch(
        "/api/system/settings",
        json={
            "instance_name": "Musterwerk Halle 1",
            "update_channel": "beta",
            "auto_check_updates": False,
            "default_language": "en",
        },
    )
    assert r_patch.status_code == 200, r_patch.text
    updated = r_patch.json()
    assert updated["instance_name"] == "Musterwerk Halle 1"
    assert updated["update_channel"] == "beta"
    assert updated["auto_check_updates"] is False
    assert updated["default_language"] == "en"
    assert updated["telemetry_enabled"] is False

    r_verify = client.get("/api/system/settings")
    assert r_verify.status_code == 200
    assert r_verify.json() == updated

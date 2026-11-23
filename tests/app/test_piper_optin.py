"""Tests for explicit GPL-3.0 opt-in Piper TTS status and installation endpoints."""

from __future__ import annotations


def test_piper_status_and_explicit_optin(client, monkeypatch):
    from agentlab import speech as speech_service

    r_st = client.get("/api/agent/speech/piper-status")
    assert r_st.status_code == 200, r_st.text
    st = r_st.json()
    assert "GPL-3.0" in st["license"]
    assert isinstance(st["catalog"], list) and len(st["catalog"]) >= 1

    # Must reject install without explicit accept_gpl=True
    r_no = client.post(
        "/api/agent/speech/piper-install",
        json={"accept_gpl": False, "voice": "de_DE-thorsten-medium"},
    )
    assert r_no.status_code == 400

    # With accept_gpl=True, calls install_piper and returns ready status
    called = []

    def fake_install(voice: str = speech_service.PIPER_DEFAULT):
        called.append(voice)
        return {
            "installed": True,
            "ready": True,
            "frozen": False,
            "voice_dir": "/tmp/fake-piper",
            "default_voice": voice,
            "voices": [{"id": voice, "name": "Thorsten (lokal)"}],
            "catalog": [{"id": voice, "name": "Thorsten (Deutsch, mittel — empfohlen)"}],
            "license": "GPL-3.0 (optional opt-in)",
        }

    monkeypatch.setattr(speech_service, "install_piper", fake_install)
    r_ok = client.post(
        "/api/agent/speech/piper-install",
        json={"accept_gpl": True, "voice": "de_DE-thorsten-medium"},
    )
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.json()["ready"] is True
    assert called == ["de_DE-thorsten-medium"]

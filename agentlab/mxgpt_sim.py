"""Simulierter mx-GPT-Anbieter für das Agent Lab (OpenAI-kompatibel).

mx-GPT selbst ist eine Node-Oberfläche (Port 8088) und spricht kein
OpenAI-Protokoll. Damit sich der mx-GPT-Rechner (kali2) im Agent Lab wie ein
normaler Anbieter testen lässt, stellt dieses Modul einen kleinen, nur von der
Standardbibliothek abhängigen Server bereit:

    python -m agentlab.mxgpt_sim --host 0.0.0.0 --port 8090

Er beantwortet ``GET /v1/models``, ``POST /v1/chat/completions`` (auch als
SSE-Stream) und ``GET /health``. Die Antworten sind bewusst deterministisch
und als Simulation gekennzeichnet; sie ersetzen kein echtes Modell, sondern
prüfen die Leitung, das Streaming und den Werkzeug-Loop des Agent Lab.

Werkzeug-Aufrufe lassen sich erzwingen, indem die letzte Nutzernachricht
``[tool:werkzeug_name {"arg": 1}]`` enthält. Das ist praktisch, um den
Tool-Calling-Pfad ohne echten Modellserver durchzuspielen.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

DEFAULT_HOST = os.environ.get("MXGPT_SIM_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.environ.get("MXGPT_SIM_PORT", "8090"))
DEFAULT_MODELS = [
    m.strip()
    for m in os.environ.get("MXGPT_SIM_MODELS", "mx-gpt,mx-gpt-mini,maternion/sage-a1.5:35b").split(",")
    if m.strip()
]

_TOOL_RE = re.compile(r"\[tool:\s*([A-Za-z0-9_.-]+)\s*(\{.*?\})?\s*\]", re.S)


def _text_of(content: Any) -> str:
    """OpenAI-Inhalt kann ein String oder eine Liste von Textteilen sein."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif item.get("type") == "text" and isinstance(item.get("content"), str):
                    parts.append(item["content"])
        return "\n".join(parts)
    return "" if content is None else str(content)


def _last_user_message(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages or []):
        if isinstance(message, dict) and message.get("role") == "user":
            return _text_of(message.get("content")).strip()
    return ""


def _tokens(text: str) -> int:
    # Grobe, aber stabile Schätzung — reicht für Usage-Zahlen im Test.
    return max(1, len(text) // 4)


def build_reply(messages: list[dict[str, Any]], model: str) -> tuple[str, dict[str, Any] | None]:
    """Baut die Antwort und optional einen simulierten Werkzeugaufruf."""
    prompt = _last_user_message(messages)
    match = _TOOL_RE.search(prompt)
    if match:
        name = match.group(1)
        raw_args = match.group(2) or "{}"
        try:
            args = json.loads(raw_args)
        except json.JSONDecodeError:
            args = {}
        call = {
            "id": f"call_{uuid.uuid4().hex[:12]}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
        }
        text = (
            f"mx-GPT-Simulation ({model}) ruft das Werkzeug „{name}“ auf.\n\n"
            f"Argumente: `{json.dumps(args, ensure_ascii=False)}`"
        )
        return text, call

    if not prompt:
        prompt = "(keine Nachricht)"
    short = prompt if len(prompt) <= 240 else prompt[:237] + "…"
    text = (
        f"mx-GPT-Simulation auf kali2 · Modell {model}\n\n"
        f"Ich habe deine Anfrage erhalten:\n„{short}“\n\n"
        "Dies ist ein lokaler Testendpunkt. Er prüft Verbindung, Streaming und "
        "Werkzeug-Aufrufe im Agent Lab — keine echte Modellinferenz."
    )
    return text, None


def _completion_body(model: str, text: str, call: dict[str, Any] | None,
                     prompt_tokens: int) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": text}
    finish = "stop"
    if call is not None:
        message["tool_calls"] = [call]
        finish = "tool_calls"
    return {
        "id": f"chatcmpl-mxgpt-{uuid.uuid4().hex[:16]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": _tokens(text),
            "total_tokens": prompt_tokens + _tokens(text),
        },
    }


def _chunks(model: str, text: str, call: dict[str, Any] | None,
            prompt_tokens: int, *, include_usage: bool = False) -> list[dict[str, Any]]:
    """Zerlegt die Antwort in OpenAI-kompatible Streaming-Deltas."""
    base = {
        "id": f"chatcmpl-mxgpt-{uuid.uuid4().hex[:16]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
    }
    out: list[dict[str, Any]] = []
    out.append({**base, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
    if call is not None:
        out.append({
            **base,
            "choices": [{
                "index": 0,
                "delta": {"tool_calls": [{"index": 0, **call}]},
                "finish_reason": None,
            }],
        })
    else:
        for start in range(0, len(text), 48):
            out.append({
                **base,
                "choices": [{"index": 0, "delta": {"content": text[start:start + 48]}, "finish_reason": None}],
            })
    out.append({
        **base,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if call else "stop"}],
    })
    if include_usage:
        out.append({
            **base,
            "choices": [],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": _tokens(text),
                "total_tokens": prompt_tokens + _tokens(text),
            },
        })
    return out


class MxGptSimHandler(BaseHTTPRequestHandler):
    server_version = "mxgpt-sim/1.0"
    protocol_version = "HTTP/1.1"

    # -- Hilfen ---------------------------------------------------------
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}
        return payload if isinstance(payload, dict) else {}

    def log_message(self, fmt: str, *args: Any) -> None:  # leiser als der Standard
        sys.stderr.write("[mxgpt-sim] " + (fmt % args) + "\n")

    # -- HTTP -----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server-Namensschema)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/")
        if path in ("/health", "/healthz"):
            self._send_json(200, {"status": "ok", "service": "mxgpt-sim"})
            return
        if path in ("/v1/models", "/models"):
            self._send_json(200, {
                "object": "list",
                "data": [
                    {
                        "id": model,
                        "object": "model",
                        "created": 0,
                        "owned_by": "mxgpt-sim",
                    }
                    for model in self.server.models  # type: ignore[attr-defined]
                ],
            })
            return
        self._send_json(404, {"error": {"message": f"Unbekannter Pfad: {path}", "type": "not_found"}})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/")
        if path not in ("/v1/chat/completions", "/chat/completions"):
            self._send_json(404, {"error": {"message": f"Unbekannter Pfad: {path}", "type": "not_found"}})
            return

        payload = self._read_body()
        model = str(payload.get("model") or (self.server.models[0] if self.server.models else "mx-gpt"))
        messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
        text, call = build_reply(messages, model)
        prompt_tokens = _tokens(" ".join(_text_of(m.get("content")) for m in messages if isinstance(m, dict)))

        if not payload.get("stream"):
            self._send_json(200, _completion_body(model, text, call, prompt_tokens))
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        # Ohne Content-Length beendet erst das Schließen der Verbindung den Stream.
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.close_connection = True
        stream_options = payload.get("stream_options")
        include_usage = bool(isinstance(stream_options, dict) and stream_options.get("include_usage"))
        for chunk in _chunks(model, text, call, prompt_tokens, include_usage=include_usage):
            self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


class MxGptSimServer(ThreadingHTTPServer):
    """ThreadingHTTPServer mit der Modellliste, damit Handler sie lesen kann."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], models: list[str] | None = None):
        self.models = list(models or DEFAULT_MODELS)
        super().__init__(address, MxGptSimHandler)


def serve_in_thread(host: str = "127.0.0.1", port: int = 0,
                    models: list[str] | None = None) -> tuple[MxGptSimServer, threading.Thread]:
    """Startet den Server im Hintergrund (port=0 wählt einen freien Port)."""
    server = MxGptSimServer((host, port), models)
    thread = threading.Thread(target=server.serve_forever, name="mxgpt-sim", daemon=True)
    thread.start()
    return server, thread


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Simulierter mx-GPT-Anbieter (OpenAI-kompatibel)")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--models", default=",".join(DEFAULT_MODELS))
    args = parser.parse_args(argv)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    server = MxGptSimServer((args.host, args.port), models)
    host, port = server.server_address[:2]
    print(f"mx-GPT-Simulation läuft auf http://{host}:{port}/v1", flush=True)
    print(f"Modelle: {', '.join(models)}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

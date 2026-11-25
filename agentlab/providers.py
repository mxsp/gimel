"""Anbieter, Endpunkte, Schlüssel und Modelllisten.

Unterstützt OpenAI-kompatible Endpunkte (OpenAI, Google Gemini, OpenRouter,
DeepSeek, Mistral, Groq, xAI, Perplexity, Together, OpenCode Go, Azure OpenAI,
LM Studio, vLLM), natives Ollama (inkl. FyreFly Models mit 32k-Kontext) sowie
native Schnittstellen für Anthropic Claude und Google Gemini.
"""

from __future__ import annotations

import ipaddress
import json
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy.orm import Session

from gimel.config import ENV_PREFIX
from gimel.services import secretbox

from .models import AgentProvider

USER_AGENT = "gimel-agentlab/0.2"
MODEL_CACHE_MINUTES = 10
MAX_MODELS_BYTES = 2 * 1024 * 1024

OPENCODE_BASE = "https://opencode.ai/inference/go/openai/v1"
OPENCODE_MODELS = "https://opencode.ai/inference/go/v1/models"
OLLAMA_DEFAULT_CTX = 32768
FYREFLY_OLLAMA_BASE = (
    os.environ.get("GIMEL_OLLAMA_URL")
    or os.environ.get("OLLAMA_URL")
    or "http://192.168.178.54:11434"
).rstrip("/")
FYREFLY_MODELS_NAME = "FyreFly Models"
FYREFLY_DEFAULT_MODEL = "gpt-oss:20b"
#: Simulierter mx-GPT-Anbieter (siehe ``agentlab.mxgpt_sim``). Läuft standardmäßig
#: auf dem mx-GPT-Rechner kali2; per Umgebungsvariable auf jeden anderen Host zeigbar.
MXGPT_SIM_BASE = (
    os.environ.get("GIMEL_MXGPT_SIM_URL")
    or os.environ.get("MXGPT_SIM_URL")
    or "http://192.168.178.54:8090/v1"
).rstrip("/")

OPENCODE_MODELS_FALLBACK = [
    "deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3-flash", "glm-5.3",
    "glm-5.2", "kimi-k3.1-pro", "kimi-k3", "kimi-k2.7-code", "longcat-2.0",
    "step-5-preview", "minimax-m3.1-flash", "mimo-v2.6-flash", "mimo-v2.6-pro",
    "mimo-v2.5", "mimo-v2.5-pro", "qwen3.8-max", "qwen3.8-flash",
    "qwen3.7-plus", "hy4", "hy3", "grok-4.7", "gpt-6-luna", "gpt-5.6-luna",
    "claude-haiku-5-5", "gemini-4-argon", "muse-spark-1.3-contributor",
]

FALLBACK_MODELS: dict[str, list[str]] = {
    "opencode-go": OPENCODE_MODELS_FALLBACK,
    "google-gemini": [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
    ],
    "google-gemini-native": [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
    ],
    "anthropic": [
        "claude-sonnet-4-5-20250929",
        "claude-opus-4-1-20250805",
        "claude-haiku-4-5-20251001",
        "claude-3-7-sonnet-latest",
    ],
    "openai": [
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "gpt-4o",
        "gpt-4o-mini",
        "o4-mini",
        "o3",
    ],
    "openrouter": [
        "google/gemini-2.5-flash",
        "google/gemini-2.5-pro",
        "anthropic/claude-sonnet-4.5",
        "openai/gpt-4.1-mini",
        "deepseek/deepseek-chat-v3-0324",
    ],
    "deepseek": [
        "deepseek-chat",
        "deepseek-reasoner",
    ],
    "mistral": [
        "mistral-large-latest",
        "mistral-medium-latest",
        "mistral-small-latest",
        "codestral-latest",
        "magistral-medium-latest",
    ],
    "groq": [
        "llama-3.3-70b-versatile",
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "qwen-qwq-32b",
        "deepseek-r1-distill-llama-70b",
    ],
    "xai": [
        "grok-3",
        "grok-3-mini",
        "grok-3-fast",
        "grok-2-latest",
    ],
    "perplexity": [
        "sonar-pro",
        "sonar",
        "sonar-reasoning-pro",
        "sonar-reasoning",
    ],
    "together": [
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "Qwen/Qwen2.5-72B-Instruct-Turbo",
        "deepseek-ai/DeepSeek-R1",
    ],
}

PROVIDER_ENV_VARS: dict[str, tuple[str, ...]] = {
    "google-gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "google-gemini-native": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "groq": ("GROQ_API_KEY",),
    "xai": ("XAI_API_KEY",),
    "perplexity": ("PERPLEXITY_API_KEY",),
    "together": ("TOGETHER_API_KEY",),
    "azure-openai": ("AZURE_OPENAI_API_KEY",),
}

KEYLESS_KINDS: frozenset[str] = frozenset({"ollama", "fyrefly-models", "lmstudio", "local-openai"})

PRESETS: dict[str, dict[str, str]] = {
    "google-gemini": {
        "name": "Google Gemini",
        "kind": "google-gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "models_url": "https://generativelanguage.googleapis.com/v1beta/openai/models",
        "default_model": "gemini-2.5-flash",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Schlüssel aus Google AI Studio (aistudio.google.com). Unterstützt Gemini 2.5 Pro/Flash, Tool-Calling und Streaming.",
    },
    "google-gemini-native": {
        "name": "Google Gemini (Native API)",
        "kind": "google-gemini-native",
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "models_url": "https://generativelanguage.googleapis.com/v1beta/models",
        "default_model": "gemini-2.5-flash",
        "protocol": "gemini",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Direkte Gemini-REST-Schnittstelle mit nativem Thought-/Reasoning-Streaming und Tool-Calling.",
    },
    "anthropic": {
        "name": "Anthropic Claude",
        "kind": "anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "models_url": "https://api.anthropic.com/v1/models",
        "default_model": "claude-sonnet-4-5-20250929",
        "protocol": "anthropic",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Native Anthropic Messages API (x-api-key) mit Tool-Calling und Streaming.",
    },
    "openai": {
        "name": "OpenAI",
        "kind": "openai",
        "base_url": "https://api.openai.com/v1",
        "models_url": "",
        "default_model": "gpt-4.1-mini",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "GPT-4.1, GPT-4o, o3 und o4-mini über die offizielle OpenAI-API.",
    },
    "openrouter": {
        "name": "OpenRouter",
        "kind": "openrouter",
        "base_url": "https://openrouter.ai/api/v1",
        "models_url": "https://openrouter.ai/api/v1/models",
        "default_model": "google/gemini-2.5-flash",
        "protocol": "openai",
        "category": "aggregator",
        "requires_key": "true",
        "hint": "Ein Schlüssel für hunderte Modelle (Gemini, Claude, GPT, DeepSeek, Llama, Qwen).",
    },
    "opencode-go": {
        "name": "OpenCode Go",
        "kind": "opencode-go",
        "base_url": OPENCODE_BASE,
        "models_url": OPENCODE_MODELS,
        "default_model": "deepseek-v4.1-flash",
        "protocol": "openai",
        "category": "aggregator",
        "requires_key": "true",
        "hint": "Vorkonfigurierter OpenCode-Go-Endpunkt mit Kontingent.",
    },
    "deepseek": {
        "name": "DeepSeek",
        "kind": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "models_url": "https://api.deepseek.com/v1/models",
        "default_model": "deepseek-chat",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "DeepSeek V3 (deepseek-chat) und R1 (deepseek-reasoner).",
    },
    "mistral": {
        "name": "Mistral AI",
        "kind": "mistral",
        "base_url": "https://api.mistral.ai/v1",
        "models_url": "https://api.mistral.ai/v1/models",
        "default_model": "mistral-large-latest",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Europäischer Anbieter (Paris): Mistral Large/Medium/Small, Codestral, Magistral.",
    },
    "groq": {
        "name": "Groq",
        "kind": "groq",
        "base_url": "https://api.groq.com/openai/v1",
        "models_url": "https://api.groq.com/openai/v1/models",
        "default_model": "llama-3.3-70b-versatile",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Extrem schnelle Inferenz für Llama 4, Llama 3.3, Qwen und DeepSeek.",
    },
    "xai": {
        "name": "xAI Grok",
        "kind": "xai",
        "base_url": "https://api.x.ai/v1",
        "models_url": "https://api.x.ai/v1/models",
        "default_model": "grok-3-mini",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Grok 3 und Grok 3 Mini über die OpenAI-kompatible xAI-API.",
    },
    "perplexity": {
        "name": "Perplexity",
        "kind": "perplexity",
        "base_url": "https://api.perplexity.ai",
        "models_url": "",
        "default_model": "sonar-pro",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Sonar-Modelle mit integrierter Live-Websuche.",
    },
    "together": {
        "name": "Together AI",
        "kind": "together",
        "base_url": "https://api.together.xyz/v1",
        "models_url": "https://api.together.xyz/v1/models",
        "default_model": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Gehostete Open-Weights-Modelle (Llama, Qwen, DeepSeek).",
    },
    "azure-openai": {
        "name": "Azure OpenAI",
        "kind": "azure-openai",
        "base_url": "https://DEINE-RESSOURCE.openai.azure.com/openai/deployments/DEIN-DEPLOYMENT/chat/completions?api-version=2024-10-21",
        "models_url": "",
        "default_model": "gpt-4o",
        "protocol": "openai",
        "category": "cloud",
        "requires_key": "true",
        "hint": "Vollständige Deployment-URL inklusive ?api-version=... eintragen; sendet api-key Header.",
    },
    "ollama": {
        "name": "Ollama (lokal)",
        "kind": "ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "models_url": "http://127.0.0.1:11434/api/tags",
        "default_model": "",
        "protocol": "ollama",
        "category": "local",
        "requires_key": "false",
        "hint": "Lokale Modelle auf diesem Rechner oder im LAN — kein API-Schlüssel nötig.",
    },
    "lmstudio": {
        "name": "LM Studio (lokal)",
        "kind": "lmstudio",
        "base_url": "http://127.0.0.1:1234/v1",
        "models_url": "http://127.0.0.1:1234/v1/models",
        "default_model": "",
        "protocol": "openai",
        "category": "local",
        "requires_key": "false",
        "hint": "Lokaler LM-Studio-Server auf Port 1234 — kein API-Schlüssel nötig.",
    },
    "local-openai": {
        "name": "vLLM / llama.cpp (lokal)",
        "kind": "local-openai",
        "base_url": "http://127.0.0.1:8000/v1",
        "models_url": "http://127.0.0.1:8000/v1/models",
        "default_model": "",
        "protocol": "openai",
        "category": "local",
        "requires_key": "false",
        "hint": "Eigener OpenAI-kompatibler Inferenzserver (vLLM, llama-server, LiteLLM) — Schlüssel optional.",
    },
    "mx-gpt": {
        "name": "mx-GPT (Simulation kali2)",
        "kind": "local-openai",
        "base_url": MXGPT_SIM_BASE,
        "models_url": f"{MXGPT_SIM_BASE}/models",
        "default_model": "mx-gpt",
        "protocol": "openai",
        "category": "local",
        "requires_key": "false",
        "hint": "Simulierter mx-GPT-Endpunkt auf kali2 (Port 8090, OpenAI-kompatibel). "
                "Starten mit „python -m agentlab.mxgpt_sim“; Ziel per GIMEL_MXGPT_SIM_URL änderbar.",
    },
}

FORBIDDEN_HEADERS = {"authorization", "host", "cookie", "content-length"}


class ProviderError(Exception):
    """Fachlicher Fehler; der Router macht daraus 4xx/5xx."""

    def __init__(self, detail: str, status: int = 400) -> None:
        super().__init__(detail)
        self.detail, self.status = detail, status


def is_ollama(provider: AgentProvider | None) -> bool:
    if provider is None:
        return False
    kind = (provider.kind or "").strip().lower()
    if kind in ("ollama", "fyrefly-models"):
        return True
    base = (provider.base_url or "").lower()
    murl = (provider.models_url or "").lower()
    return ":11434" in base or "/api/tags" in murl or base.endswith("/api/chat")


def requires_key(provider: AgentProvider | None) -> bool:
    if provider is None:
        return True
    if is_ollama(provider):
        return False
    kind = (provider.kind or "").strip().lower()
    if kind in KEYLESS_KINDS:
        return False
    base = (provider.base_url or "").strip().lower()
    if kind == "custom" and any(host in base for host in ("127.0.0.1", "localhost", "[::1]")):
        return False
    return True


def requires_api_key(provider: AgentProvider | None) -> bool:
    return requires_key(provider)


def provider_protocol(provider: AgentProvider | None) -> str:
    """Bestimmt das Drahtprotokoll: ``openai``, ``anthropic``, ``gemini`` oder ``ollama``."""
    if provider is None:
        return "openai"
    if is_ollama(provider):
        return "ollama"
    kind = (provider.kind or "").strip().lower()
    base = (provider.base_url or "").strip().lower().rstrip("/")
    if kind == "anthropic" or "api.anthropic.com" in base:
        return "anthropic"
    if kind == "google-gemini-native":
        return "gemini"
    if kind == "google-gemini" and "generativelanguage.googleapis.com" in base and "/openai" not in base:
        return "gemini"
    return "openai"


def env_api_key() -> str:
    return (
        os.environ.get(f"{ENV_PREFIX}AGENT_API_KEY")
        or os.environ.get("AGENT_API_KEY")
        or ""
    )


def provider_env_key(provider: AgentProvider | None) -> str:
    if provider is None:
        return ""
    kind = (provider.kind or "").strip().lower()
    for var in PROVIDER_ENV_VARS.get(kind, ()):
        val = os.environ.get(f"{ENV_PREFIX}{var}") or os.environ.get(var) or ""
        if val.strip():
            return val.strip()
    return ""


def api_key(provider: AgentProvider | None) -> str:
    if provider and provider.is_default:
        env = env_api_key()
        if env:
            return env
    specific = provider_env_key(provider)
    if specific:
        return specific
    if provider and provider.api_key_enc:
        return secretbox.open_(provider.api_key_enc)
    if provider and not requires_key(provider):
        return ""
    return env_api_key()


def key_source(provider: AgentProvider | None) -> str:
    if provider and provider.is_default and env_api_key():
        return "env"
    if provider_env_key(provider):
        return "env"
    if provider and provider.api_key_enc:
        return "database"
    if provider and not requires_key(provider):
        return "none"
    return "env" if env_api_key() else "none"


def set_key(provider: AgentProvider, plain: str) -> None:
    provider.api_key_enc = secretbox.seal(plain.strip()) if plain.strip() else ""


def clear_key(provider: AgentProvider) -> None:
    provider.api_key_enc = ""


def clean_headers(raw: dict | None) -> dict:
    out: dict[str, str] = {}
    for key, value in (raw or {}).items():
        name = str(key).strip()
        if not name or name.lower() in FORBIDDEN_HEADERS:
            continue
        out[name[:80]] = str(value)[:500]
    return out


def _check_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise ProviderError("Die Basis-URL fehlt.")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ProviderError("Nur http:// und https:// sind erlaubt.")
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    normalized = urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))
    return normalized[:400]


def _append_path(base: str, suffix: str) -> str:
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    if not path.endswith(suffix):
        path = path + suffix
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def ollama_root(provider: AgentProvider) -> str:
    base = _check_url(provider.base_url)
    for suffix in ("/v1/chat/completions", "/api/chat", "/api/tags", "/v1"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def ollama_chat_url(provider: AgentProvider) -> str:
    return ollama_root(provider) + "/api/chat"


def provider_context_length(provider: AgentProvider | None) -> int | None:
    if provider is None:
        return None
    headers = provider.headers or {}
    for k, v in headers.items():
        if str(k).lower() in ("x-ollama-num-ctx", "x-context-length"):
            try:
                val = int(v)
                if 2048 <= val <= 1_048_576:
                    return val
            except (TypeError, ValueError):
                pass
    if is_ollama(provider):
        return OLLAMA_DEFAULT_CTX
    return None


def chat_url(provider: AgentProvider, model: str = "") -> str:
    base = _check_url(provider.base_url)
    proto = provider_protocol(provider)
    if proto == "anthropic":
        return _append_path(base, "/messages")
    if proto == "gemini":
        clean_model = (model or provider.default_model or "gemini-2.5-flash").strip()
        if clean_model.startswith("models/"):
            clean_model = clean_model[len("models/"):]
        parts = urlsplit(base)
        path = parts.path.rstrip("/") + f"/models/{clean_model}:streamGenerateContent"
        query = f"{parts.query}&alt=sse" if parts.query else "alt=sse"
        return urlunsplit((parts.scheme, parts.netloc, path, query, ""))
    return _append_path(base, "/chat/completions")


def models_url(provider: AgentProvider) -> str:
    if provider.models_url.strip():
        return _check_url(provider.models_url)
    if is_ollama(provider):
        return ollama_root(provider) + "/api/tags"
    base = _check_url(provider.base_url)
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    for tail in ("/chat/completions", "/messages"):
        if path.endswith(tail):
            path = path[: -len(tail)]
    if not path.endswith("/models"):
        path = path + "/models"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def _request_headers(provider: AgentProvider, *, session_id: str = "") -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT, "Content-Type": "application/json"}
    headers.update(clean_headers(provider.headers))
    key = api_key(provider)
    proto = provider_protocol(provider)
    kind = (provider.kind or "").strip().lower()
    if proto == "anthropic":
        headers.setdefault("anthropic-version", "2023-06-01")
        if key:
            headers["x-api-key"] = key
    elif proto == "gemini":
        if key:
            headers["x-goog-api-key"] = key
    elif kind == "azure-openai":
        if key:
            headers["api-key"] = key
    else:
        if key:
            headers["Authorization"] = f"Bearer {key}"
    if kind == "opencode-go":
        headers["x-opencode-session"] = session_id or f"gimel-agentlab-{provider.id}"
    elif kind == "openrouter":
        headers.setdefault("X-Title", "Gimel Agent Lab")
    return headers


def _parse_models(payload, *, kind: str = "") -> list[dict]:
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if isinstance(payload, dict) and not rows:
        rows = payload.get("models") or payload.get("items") or []
    is_google = kind in ("google-gemini", "google-gemini-native")
    out: list[dict] = []
    for row in rows or []:
        if isinstance(row, str):
            ident = row[7:] if is_google and row.startswith("models/") else row
            out.append({"id": ident})
            continue
        if not isinstance(row, dict):
            continue
        methods = row.get("supportedGenerationMethods")
        if isinstance(methods, list) and methods and "generateContent" not in methods:
            continue
        ident = row.get("id") or row.get("name") or row.get("model")
        if not ident:
            continue
        ident_str = str(ident)[:160]
        if ident_str.startswith("models/") and (is_google or "gemini" in ident_str.lower()):
            ident_str = ident_str[len("models/"):]
        item: dict = {"id": ident_str}
        display = row.get("display_name") or row.get("displayName") or row.get("name")
        if display and str(display) != ident and str(display) != ident_str and not str(display).startswith("models/"):
            item["name"] = str(display)[:160]
        details = row.get("details") if isinstance(row.get("details"), dict) else {}
        for src_dict in (row, details):
            for src, dst in (("context_length", "context_length"),
                             ("context_window", "context_length"),
                             ("max_context_length", "context_length"),
                             ("inputTokenLimit", "context_length")):
                if src_dict.get(src) is not None and dst not in item:
                    try:
                        item[dst] = int(src_dict[src])
                    except (TypeError, ValueError):
                        pass
                    break
        if details.get("parameter_size"):
            item["parameter_size"] = str(details["parameter_size"])[:40]
        out.append(item)
    seen: set[str] = set()
    unique = []
    for item in out:
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        unique.append(item)
    return sorted(unique, key=lambda x: x["id"].lower())


def cache_is_fresh(provider: AgentProvider) -> bool:
    if not provider.models_cache or not provider.models_fetched_at:
        return False
    fetched = provider.models_fetched_at
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    return fetched > datetime.now(timezone.utc) - timedelta(minutes=MODEL_CACHE_MINUTES)


def _is_local_or_lan_url(url: str) -> bool:
    host = (urlsplit(url).hostname or "").strip().lower().strip("[]")
    if not host:
        return False
    if host in ("localhost", "localhost.localdomain") or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return False


async def fetch_models(
    db: Session, provider: AgentProvider, *, force: bool = False
) -> tuple[list[dict], str]:
    """Modellliste holen; gibt (Liste, Warnung) zurück."""
    if not force and cache_is_fresh(provider):
        return list(provider.models_cache or []), ""
    url = models_url(provider)
    kind = (provider.kind or "").strip().lower()
    fallback = FALLBACK_MODELS.get(kind)

    def _use_fallback(reason: str) -> tuple[list[dict], str] | None:
        if provider.models_cache:
            return list(provider.models_cache), reason
        if fallback:
            models = [{"id": m} for m in fallback]
            provider.models_cache = models
            provider.models_fetched_at = datetime.now(timezone.utc)
            provider.default_model = provider.default_model or models[0]["id"]
            db.commit()
            return models, reason
        default_id = (provider.default_model or "").strip()
        if default_id:
            return [{"id": default_id}], reason
        return None

    if kind in ("perplexity", "azure-openai") and not provider.models_url.strip():
        if fallback:
            models = [{"id": m} for m in fallback]
            provider.models_cache = models
            provider.models_fetched_at = datetime.now(timezone.utc)
            provider.default_model = provider.default_model or models[0]["id"]
            db.commit()
            return models, ""
        if provider.default_model:
            return [{"id": provider.default_model}], ""

    local_lan = _is_local_or_lan_url(url) or is_ollama(provider)
    timeout = httpx.Timeout(6.0, connect=2.5) if local_lan else httpx.Timeout(12.0, connect=5.0)
    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            headers=_request_headers(provider),
        ) as client:
            resp = await client.get(url)
            body = resp.content[:MAX_MODELS_BYTES]
        if resp.status_code >= 400:
            raise ProviderError(
                f"Der Endpunkt antwortet mit {resp.status_code}.", 502
            )
        payload = json.loads(body.decode("utf-8", "replace"))
        models = _parse_models(payload, kind=kind)
        if not models:
            raise ProviderError("Der Endpunkt lieferte keine Modelle.", 502)
    except Exception as exc:  # noqa: BLE001
        reason = exc.detail if isinstance(exc, ProviderError) else f"Modellliste nicht erreichbar: {exc}"
        fb = _use_fallback(reason)
        if fb is not None:
            return fb
        if isinstance(exc, ProviderError):
            raise
        raise ProviderError(reason, 502) from exc
    provider.models_cache = models
    provider.models_fetched_at = datetime.now(timezone.utc)
    if not provider.default_model:
        provider.default_model = models[0]["id"]
    db.commit()
    return models, ""


async def test_provider(db: Session, provider: AgentProvider) -> dict:
    if requires_key(provider) and not api_key(provider):
        raise ProviderError("Kein API-Schlüssel gesetzt.", 422)
    models, warning = await fetch_models(db, provider, force=True)
    return {
        "ok": True,
        "models": len(models),
        "sample": [m["id"] for m in models[:8]],
        "warning": warning,
    }

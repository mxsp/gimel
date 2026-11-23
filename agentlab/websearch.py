"""Websuche und Seitenabruf für den Assistenten.

Die Suche ist ein Werkzeug, keine zweite Wissensquelle: Treffer werden als
Daten mit Quelle an das Modell gegeben. Der Abruf einer Seite prüft die
Adresse vor jedem Schritt — auch nach einer Weiterleitung. Damit kann das
Modell nicht versehentlich ``http://127.0.0.1:8000`` oder einen internen
Datenbankdienst abfragen. Für eine SearXNG-Instanz im LAN lässt sich die
Prüfung in den Einstellungen bewusst lockern.
"""

from __future__ import annotations

import html
import ipaddress
import json
import re
import socket
from html.parser import HTMLParser
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import httpx
from sqlalchemy.orm import Session

from . import settings

USER_AGENT = "Mozilla/5.0 (compatible; gimel-agentlab/0.1; +https://gimel.local)"
MAX_PAGE_BYTES = 10 * 1024 * 1024
MAX_REDIRECTS = 3


class WebSearchError(Exception):
    """Ein fachlicher Fehler; der Werkzeugaufruf gibt ihn lesbar zurück."""


# --------------------------------------------------------------------------
# Adressprüfung
# --------------------------------------------------------------------------
def _is_public_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified
        or (ip.version == 6 and ip.is_site_local)
    )


def _is_metadata_or_link_local(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return True
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_link_local or str(ip) in {"169.254.169.254", "169.254.170.2", "fd00:ec2::254"}


def check_url(url: str, *, allow_private: bool = False) -> str:
    """Nur http(s), ohne Zugangsdaten, ohne lokale Ziele (außer ausdrücklich)."""
    url = (url or "").strip()
    if not url:
        raise WebSearchError("Die Adresse fehlt.")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise WebSearchError("Nur http:// und https:// sind erlaubt.")
    if parsed.username or parsed.password:
        raise WebSearchError("Adressen mit Zugangsdaten werden nicht abgerufen.")
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise WebSearchError("Die Adresse enthält keinen Host.")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise WebSearchError("Die Adresse enthält einen ungültigen Port.") from exc
    if host in {"metadata.google.internal", "metadata.goog"}:
        raise WebSearchError("Metadaten-Adressen sind gesperrt.")
    if not allow_private and port not in (80, 443):
        raise WebSearchError("Nur die Ports 80 und 443 werden abgerufen.")
    if not allow_private and host in {"localhost", "localhost.localdomain", "metadata.google.internal"}:
        raise WebSearchError("Lokale Adressen sind für den Seitenabruf gesperrt.")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise WebSearchError(f"Der Host „{host}“ ist nicht auflösbar.") from exc
        addresses = {info[4][0] for info in infos}
        if not addresses:
            raise WebSearchError(f"Der Host „{host}“ ist nicht auflösbar.")
    else:
        addresses = {str(ip)}
    for address in addresses:
        if _is_metadata_or_link_local(address):
            raise WebSearchError("Link-lokale und Cloud-Metadaten-Adressen sind gesperrt.")
        if not allow_private and not _is_public_ip(address):
            raise WebSearchError(
                "Die Adresse zeigt auf ein lokales oder internes Netz. "
                "Der Abruf ist gesperrt."
            )
    return url


# --------------------------------------------------------------------------
# HTML lesen
# --------------------------------------------------------------------------
class _TextParser(HTMLParser):
    """Fließtext aus HTML, ohne Skripte, Stile und Navigation."""

    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
             "section", "article", "header", "footer", "table", "ul", "ol", "pre"}
    SKIP = {"script", "style", "noscript", "svg", "canvas", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        if self._in_title:
            self.title += data
        self.parts.append(data)


def html_to_text(raw: str) -> tuple[str, str]:
    parser = _TextParser()
    try:
        parser.feed(raw)
        parser.close()
    except Exception:  # noqa: BLE001 - kaputtes HTML ist noch kein Fehler
        pass
    text = "".join(parser.parts)
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip(), " ".join(parser.title.split())


class _ResultParser(HTMLParser):
    """Treffer aus DuckDuckGo HTML/Lite und SearXNG-HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict] = []
        self.snippets: list[str] = []
        self._capture: tuple[str, str, int, list[str]] | None = None
        self._depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        attrs_dict = {key.lower(): (value or "") for key, value in attrs}
        classes = attrs_dict.get("class", "").lower().split()
        href = attrs_dict.get("href", "")
        if self._capture is not None:
            if tag == self._capture[0]:
                self._depth += 1
            return
        if tag == "a" and href and any(
            c.startswith("result__a") or c.startswith("result-link")
            or c == "result-title" for c in classes
        ):
            self._capture = ("a", href, 0, [])
            self._depth = 0
        elif tag in ("a", "td", "div") and any(
            c.startswith("result__snippet") or c.startswith("result-snippet")
            or c == "content" for c in classes
        ):
            self._capture = (tag, "", 0, [])
            self._depth = 0

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._capture is None:
            return
        if tag == self._capture[0]:
            if self._depth:
                self._depth -= 1
                return
            kind, href, _, parts = self._capture
            text = " ".join("".join(parts).split())
            if kind == "a" and href:
                self.links.append({"href": href, "title": text})
            elif text:
                self.snippets.append(text)
            self._capture = None

    def handle_data(self, data: str) -> None:
        if self._capture is not None:
            self._capture[3].append(data)


def _clean_result_url(href: str) -> str:
    href = html.unescape(href or "").strip()
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if "duckduckgo.com" in (parsed.hostname or "") and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg")
        if target:
            return unquote(target[0])
    return href


def _dedupe(results: list[dict], limit: int) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for item in results:
        url = (item.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        out.append({
            "title": (item.get("title") or url)[:240],
            "url": url[:1000],
            "snippet": (item.get("snippet") or "")[:600],
            "source": item.get("source") or "web",
        })
        if len(out) >= limit:
            break
    return out


def _parse_html_results(raw: str) -> list[dict]:
    parser = _ResultParser()
    try:
        parser.feed(raw)
        parser.close()
    except Exception:  # noqa: BLE001
        pass
    results = []
    for index, link in enumerate(parser.links):
        snippet = parser.snippets[index] if index < len(parser.snippets) else ""
        results.append({
            "title": link["title"], "url": _clean_result_url(link["href"]),
            "snippet": snippet, "source": "web",
        })
    return results


# --------------------------------------------------------------------------
# Suchdienste
# --------------------------------------------------------------------------
def _client(timeout: int) -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(timeout, connect=min(8, timeout)),
        follow_redirects=False,
        trust_env=False,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "de-DE,de;q=0.9,en;q=0.6"},
    )


def _safe_setting(db: Session, key: str, fallback: str) -> str:
    try:
        return settings.raw(db, key)
    except Exception:  # noqa: BLE001 - Einstellungen dürfen die Suche nicht sprengen
        return fallback


def _duckduckgo(db: Session, query: str, limit: int) -> list[dict]:
    safe = _safe_setting(db, "agent_web_safesearch", "moderate")
    region = _safe_setting(db, "agent_web_region", "de-de")
    timeout = max(3, settings.get_int(db, "agent_web_timeout_s"))
    kp = {"off": "-2", "moderate": "-1", "strict": "1"}.get(safe, "-1")
    data = {"q": query, "kl": region, "kp": kp}
    with _client(timeout) as client:
        resp = client.post("https://html.duckduckgo.com/html/", data=data)
        if resp.status_code >= 400:
            raise WebSearchError(f"DuckDuckGo antwortet mit {resp.status_code}.")
        results = _parse_html_results(resp.text)
        if results:
            return results
        # Lite ist robuster gegen Sperren und liefert eine einfache Tabelle.
        resp = client.get("https://lite.duckduckgo.com/lite/", params={"q": query})
        if resp.status_code >= 400:
            raise WebSearchError(f"DuckDuckGo antwortet mit {resp.status_code}.")
        return _parse_html_results(resp.text)


def _searxng(db: Session, query: str, limit: int) -> list[dict]:
    base = settings.get(db, "agent_web_base_url").strip()
    if not base:
        raise WebSearchError("Für SearXNG fehlt die Adresse in den Einstellungen.")
    base = check_url(base, allow_private=settings.get_bool(db, "agent_web_allow_private")).rstrip("/")
    safe = _safe_setting(db, "agent_web_safesearch", "moderate")
    region = _safe_setting(db, "agent_web_region", "de-de")
    timeout = max(3, settings.get_int(db, "agent_web_timeout_s"))
    params = {"q": query, "format": "json", "language": region.split("-")[0],
              "safesearch": {"off": "0", "moderate": "1", "strict": "2"}.get(safe, "1")}
    with _client(timeout) as client:
        resp = client.get(f"{base}/search", params=params)
        if resp.status_code >= 400:
            raise WebSearchError(f"SearXNG antwortet mit {resp.status_code}.")
        ctype = resp.headers.get("content-type", "")
        if "json" in ctype:
            try:
                payload = resp.json()
            except ValueError as exc:
                raise WebSearchError(
                    "SearXNG liefert kein gültiges JSON. Ist die JSON-Schnittstelle "
                    "in der Instanz freigeschaltet?"
                ) from exc
            results = [
                {"title": item.get("title") or "", "url": item.get("url") or "",
                 "snippet": item.get("content") or "", "source": "searxng"}
                for item in payload.get("results") or [] if isinstance(item, dict)
            ]
            return results
        return _parse_html_results(resp.text)


def _tavily(db: Session, query: str, limit: int) -> list[dict]:
    key = settings.web_api_key(db)
    if not key:
        raise WebSearchError("Für Tavily fehlt der API-Schlüssel.")
    timeout = max(3, settings.get_int(db, "agent_web_timeout_s"))
    payload = {
        "api_key": key, "query": query, "max_results": limit,
        "search_depth": "basic", "include_answer": False,
        "include_raw_content": False,
    }
    with _client(timeout) as client:
        resp = client.post("https://api.tavily.com/search", json=payload)
        if resp.status_code >= 400:
            detail = resp.text[:300]
            raise WebSearchError(f"Tavily antwortet mit {resp.status_code}: {detail}")
        data = resp.json()
    return [
        {"title": item.get("title") or "", "url": item.get("url") or "",
         "snippet": item.get("content") or "", "source": "tavily"}
        for item in data.get("results") or [] if isinstance(item, dict)
    ]


def _brave(db: Session, query: str, limit: int) -> list[dict]:
    key = settings.web_api_key(db)
    if not key:
        raise WebSearchError("Für Brave fehlt der API-Schlüssel.")
    timeout = max(3, settings.get_int(db, "agent_web_timeout_s"))
    safe = _safe_setting(db, "agent_web_safesearch", "moderate")
    region = _safe_setting(db, "agent_web_region", "de-de")
    headers = {"X-Subscription-Token": key, "Accept": "application/json"}
    params = {
        "q": query, "count": limit, "country": region.split("-")[-1].upper(),
        "safesearch": {"off": "off", "moderate": "moderate", "strict": "strict"}.get(safe, "moderate"),
    }
    with _client(timeout) as client:
        resp = client.get("https://api.search.brave.com/res/v1/web/search",
                          params=params, headers=headers)
        if resp.status_code >= 400:
            raise WebSearchError(f"Brave antwortet mit {resp.status_code}.")
        data = resp.json()
    return [
        {"title": item.get("title") or "", "url": item.get("url") or "",
         "snippet": item.get("description") or "", "source": "brave"}
        for item in (data.get("web") or {}).get("results") or [] if isinstance(item, dict)
    ]


PROVIDERS = {
    "duckduckgo": _duckduckgo,
    "searxng": _searxng,
    "tavily": _tavily,
    "brave": _brave,
}


def search(db: Session, query: str, *, limit: int | None = None) -> dict:
    """Eine Websuche. Gibt Quellen zurück, keine fertige Wahrheit."""
    query = " ".join((query or "").split())
    if not query:
        raise WebSearchError("Die Suchanfrage ist leer.")
    if len(query) > 500:
        query = query[:500]
    provider = _safe_setting(db, "agent_web_provider", "duckduckgo")
    handler = PROVIDERS.get(provider)
    if handler is None:
        raise WebSearchError(f"Unbekannter Suchdienst „{provider}“.")
    ceiling = max(1, min(settings.get_int(db, "agent_web_max_results"), 10))
    count = max(1, min(int(limit or ceiling), ceiling))
    results = _dedupe(handler(db, query, count), count)
    return {
        "provider": provider, "query": query, "results": results,
        "warning": "" if results else "Die Suche lieferte keine auswertbaren Treffer.",
    }


# --------------------------------------------------------------------------
# Seite abrufen
# --------------------------------------------------------------------------
def _read_limited(resp: httpx.Response, limit: int) -> tuple[bytes, bool]:
    chunks: list[bytes] = []
    total = 0
    for chunk in resp.iter_bytes():
        if not chunk:
            continue
        total += len(chunk)
        if total > limit:
            chunks.append(chunk[: max(0, limit - (total - len(chunk)))])
            return b"".join(chunks), True
        chunks.append(chunk)
    return b"".join(chunks), False


def fetch(db: Session, url: str) -> dict:
    """Eine öffentliche Seite lesen; PDF wird wie ein Anhang extrahiert."""
    allow_private = settings.get_bool(db, "agent_web_allow_private")
    timeout = max(3, settings.get_int(db, "agent_web_timeout_s"))
    max_chars = max(1000, settings.get_int(db, "agent_web_fetch_chars"))
    current = url
    with _client(timeout) as client:
        for _ in range(MAX_REDIRECTS + 1):
            check_url(current, allow_private=allow_private)
            with client.stream("GET", current) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location", "")
                    if not location:
                        raise WebSearchError("Die Seite leitet ohne Ziel weiter.")
                    current = urljoin(current, location)
                    continue
                if resp.status_code >= 400:
                    raise WebSearchError(f"Die Seite antwortet mit {resp.status_code}.")
                data, truncated = _read_limited(resp, MAX_PAGE_BYTES)
                ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                final_url = str(resp.url)
                break
        else:
            raise WebSearchError("Zu viele Weiterleitungen.")

    if ctype == "application/pdf" or current.lower().endswith(".pdf"):
        from . import files as file_service

        try:
            text, pages, _ = file_service.extract_bytes(
                current.rsplit("/", 1)[-1] or "seite.pdf", ctype or "application/pdf",
                data, db=db,
            )
        except file_service.AttachmentError as exc:
            raise WebSearchError(exc.detail) from exc
        return {
            "url": final_url, "content_type": ctype or "application/pdf",
            "title": current.rsplit("/", 1)[-1], "text": text[:max_chars],
            "pages": pages, "truncated": truncated or len(text) > max_chars,
        }

    charset = "utf-8"
    match = re.search(r"charset=([\w\-]+)", resp.headers.get("content-type", ""), re.I)
    if match:
        charset = match.group(1)
    try:
        raw = data.decode(charset, "replace")
    except LookupError:
        raw = data.decode("utf-8", "replace")
    if "html" in ctype or raw.lstrip().startswith("<"):
        text, title = html_to_text(raw)
    elif "json" in ctype:
        try:
            text = json.dumps(json.loads(raw), ensure_ascii=False, indent=2)
        except (ValueError, TypeError):
            text = raw
        title = ""
    else:
        text, title = raw.strip(), ""
    text = re.sub(r"\x00", "", text).strip()
    return {
        "url": final_url, "content_type": ctype or "text/plain", "title": title,
        "text": text[:max_chars], "pages": 0,
        "truncated": truncated or len(text) > max_chars,
    }


def fetch_preview(db: Session, url: str) -> dict:
    """Öffentliche Webseite sicher für die Seiten-Vorschau abrufen (mit Base-Tag).

    Nutzt dieselbe Adressprüfung wie ``fetch`` (kein SSRF). Gibt sowohl das
    aufbereitete HTML (für sandboxed srcDoc) als auch den Fließtext (Lesemodus)
    zurück.
    """
    allow_private = settings.get_bool(db, "agent_web_allow_private")
    timeout = max(3, settings.get_int(db, "agent_web_timeout_s"))
    current = url
    with _client(timeout) as client:
        for _ in range(MAX_REDIRECTS + 1):
            check_url(current, allow_private=allow_private)
            with client.stream("GET", current) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location", "")
                    if not location:
                        raise WebSearchError("Die Seite leitet ohne Ziel weiter.")
                    current = urljoin(current, location)
                    continue
                if resp.status_code >= 400:
                    raise WebSearchError(f"Die Seite antwortet mit {resp.status_code}.")
                data, truncated = _read_limited(resp, min(MAX_PAGE_BYTES, 3 * 1024 * 1024))
                ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                final_url = str(resp.url)
                break
        else:
            raise WebSearchError("Zu viele Weiterleitungen.")

    charset = "utf-8"
    match = re.search(r"charset=([\w\-]+)", resp.headers.get("content-type", ""), re.I)
    if match:
        charset = match.group(1)
    try:
        raw = data.decode(charset, "replace")
    except LookupError:
        raw = data.decode("utf-8", "replace")
    raw = re.sub(r"\x00", "", raw)

    if "html" in ctype or raw.lstrip().startswith("<"):
        text, title = html_to_text(raw)
        # Meta-CSP entfernen und <base href> einfügen, damit relative Assets/Links funktionieren.
        cleaned = re.sub(
            r'<meta[^>]+http-equiv=["\']?content-security-policy["\']?[^>]*>',
            "", raw, flags=re.I,
        )
        base_tag = f'<base href="{html.escape(final_url, quote=True)}" target="_blank" />'
        if re.search(r"<head\b[^>]*>", cleaned, re.I):
            cleaned = re.sub(r"(<head\b[^>]*>)", rf"\1{base_tag}", cleaned, count=1, flags=re.I)
        else:
            cleaned = base_tag + cleaned
        return {
            "url": final_url, "content_type": ctype or "text/html",
            "title": title or final_url, "html": cleaned, "text": text[:60_000],
            "truncated": truncated,
        }
    return {
        "url": final_url, "content_type": ctype or "text/plain",
        "title": final_url, "html": "", "text": raw[:60_000],
        "truncated": truncated,
    }

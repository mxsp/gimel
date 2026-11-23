"""Anhänge lesen: PDF-Text, OCR und Klartext, ohne die Datei zu speichern.

Ein PDF wird nicht verworfen, nur weil die erste Bibliothek nichts findet:
``pypdf`` liest die Textebene, ``pdftotext`` (poppler) ist der zweite Weg, und
für Scans folgt — wenn freigeschaltet und installiert — ``tesseract``. Die
Seitenauswahl beim Hochladen hat Vorrang vor der Seitengrenze; eine zu große
Datei wird gekürzt und sagt das im Ergebnis, statt den Upload abzulehnen.
"""

from __future__ import annotations

import hashlib
import io
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from sqlalchemy.orm import Session

from gimel.models import User

from . import settings
from .models import AgentAttachment, AgentChat

MAX_BYTES = 15 * 1024 * 1024
MAX_CHARS = 300_000
MAX_PDF_PAGES = 250
OCR_TIMEOUT_S = 90

ALLOWED: dict[str, str] = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".log": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
    ".svg": "image/svg+xml",
    ".xml": "application/xml",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".jsx": "text/javascript",
    ".py": "text/x-python",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".sql": "text/x-sql",
}


class AttachmentError(ValueError):
    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.detail, self.status = detail, status


def _int(db: Session | None, key: str, fallback: int) -> int:
    if db is None:
        return fallback
    try:
        return settings.get_int(db, key)
    except Exception:  # noqa: BLE001 - ein kaputter Wert darf den Upload nicht sperren
        return fallback


def _bool(db: Session | None, key: str, fallback: bool) -> bool:
    if db is None:
        return fallback
    try:
        return settings.get_bool(db, key)
    except Exception:  # noqa: BLE001
        return fallback


def _text(db: Session | None, key: str, fallback: str) -> str:
    if db is None:
        return fallback
    try:
        return settings.get(db, key)
    except Exception:  # noqa: BLE001
        return fallback


def parse_pages(spec: str, total: int) -> list[int]:
    """``1-5,8,12-`` → [1,2,3,4,5,8,12,…]. Leer heißt alle Seiten."""
    spec = (spec or "").strip()
    if not spec:
        # Auch ein absichtlich riesiges PDF soll den Prozess nicht mit einer
        # Liste von Millionen Seiten belasten.
        return list(range(1, min(total, 10_000) + 1))
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start, _, end = part.partition("-")
            try:
                first = int(start) if start.strip() else 1
                last = int(end) if end.strip() else total
            except ValueError as exc:
                raise AttachmentError(
                    f"Die Seitenauswahl „{spec}“ ist unlesbar. Beispiel: 1-5,8."
                ) from exc
        else:
            try:
                first = last = int(part)
            except ValueError as exc:
                raise AttachmentError(
                    f"Die Seitenauswahl „{spec}“ ist unlesbar. Beispiel: 1-5,8."
                ) from exc
        for number in range(max(1, first), min(total, last) + 1):
            if number not in pages:
                pages.append(number)
    if not pages:
        raise AttachmentError("Die Seitenauswahl enthält keine Seite dieser PDF.")
    return sorted(pages)


def _clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f]", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# --------------------------------------------------------------------------
# pypdf
# --------------------------------------------------------------------------
def _reader(data: bytes, password: str):
    """Ein entsperrtes pypdf-Objekt oder ``None``, wenn pypdf fehlt."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return None
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        raise AttachmentError("Die PDF-Datei konnte nicht gelesen werden.") from exc
    if reader.is_encrypted:
        opened = False
        for candidate in ([password] if password else []) + [""]:
            try:
                if reader.decrypt(candidate):
                    opened = True
                    break
            except Exception:  # noqa: BLE001
                continue
        if not opened:
            raise AttachmentError(
                "Die PDF-Datei ist passwortgeschützt. Bitte das Passwort beim "
                "Hochladen angeben."
            )
    return reader


def _pypdf_pages(data: bytes, password: str, selected: list[int], reader=None):
    if reader is None:
        reader = _reader(data, password)
    if reader is None:
        return None, None
    meta: dict = {}
    raw_meta = getattr(reader, "metadata", None) or {}
    for source, target in (
        ("/Title", "title"), ("/Author", "author"), ("/Subject", "subject"),
        ("/Creator", "creator"), ("/Producer", "producer"),
    ):
        try:
            value = raw_meta.get(source)
        except Exception:  # noqa: BLE001
            value = None
        if value:
            meta[target] = str(value)[:500]
    parts: list[str] = []
    for number in selected:
        try:
            parts.append(reader.pages[number - 1].extract_text() or "")
        except Exception:  # noqa: BLE001 - eine defekte Seite ist kein kaputtes PDF
            parts.append("")
    return parts, meta


# --------------------------------------------------------------------------
# poppler: pdftotext und pdftoppm
# --------------------------------------------------------------------------
def _pdftotext(data: bytes, first: int, last: int) -> list[str]:
    binary = shutil.which("pdftotext")
    if not binary:
        return []
    with tempfile.TemporaryDirectory(prefix="gimel-pdf-") as folder:
        path = Path(folder) / "datei.pdf"
        path.write_bytes(data)
        try:
            result = subprocess.run(
                [binary, "-layout", "-enc", "UTF-8", "-f", str(first), "-l", str(last),
                 str(path), "-"],
                capture_output=True, timeout=60, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
    if result.returncode != 0:
        return []
    text = result.stdout.decode("utf-8", "replace")
    return text.split("\f")


def _ocr_page(binary_ppm: str, binary_ocr: str, pdf_path: Path, number: int,
              lang: str, dpi: int) -> str:
    with tempfile.TemporaryDirectory(prefix="gimel-ocr-") as folder:
        prefix = Path(folder) / "seite"
        try:
            render = subprocess.run(
                [binary_ppm, "-f", str(number), "-l", str(number), "-r", str(dpi),
                 "-png", "-singlefile", str(pdf_path), str(prefix)],
                capture_output=True, timeout=60, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return ""
        if render.returncode != 0 or not prefix.with_suffix(".png").exists():
            return ""
        try:
            result = subprocess.run(
                [binary_ocr, str(prefix.with_suffix(".png")), "stdout", "-l", lang,
                 "--psm", "3"],
                capture_output=True, timeout=OCR_TIMEOUT_S, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return ""
    if result.returncode != 0:
        return ""
    return result.stdout.decode("utf-8", "replace")


def _ocr(data: bytes, numbers: list[int], db: Session | None) -> tuple[dict[int, str], str]:
    ppm = shutil.which("pdftoppm")
    ocr = shutil.which("tesseract")
    if not ppm or not ocr:
        return {}, "tesseract oder pdftoppm fehlt"
    lang = _text(db, "agent_pdf_ocr_lang", "deu+eng") or "deu+eng"
    dpi = max(100, min(_int(db, "agent_pdf_ocr_dpi", 200), 400))
    out: dict[int, str] = {}
    with tempfile.TemporaryDirectory(prefix="gimel-pdf-ocr-") as folder:
        path = Path(folder) / "datei.pdf"
        path.write_bytes(data)
        for number in numbers:
            text = _ocr_page(ppm, ocr, path, number, lang, dpi)
            if text.strip():
                out[number] = text
    return out, ""


def _pdf_text(
    data: bytes, *, db: Session | None = None, password: str = "", pages: str = ""
) -> tuple[str, int, dict]:
    max_pages = max(1, _int(db, "agent_pdf_max_pages", MAX_PDF_PAGES))
    probe = _reader(data, password)
    total = len(probe.pages) if probe is not None else 0
    if total <= 0:
        if b"/Encrypt" in data:
            raise AttachmentError(
                "Die PDF-Datei ist passwortgeschützt. Bitte das Passwort beim "
                "Hochladen angeben."
            )
        # Ohne pypdf bleibt pdftotext: Seitenzahl aus dem Seitenumbruch.
        fallback = _pdftotext(data, 1, 10_000)
        total = len([part for part in fallback if part.strip()]) or 1
    selected = parse_pages(pages, total)
    explicit = bool((pages or "").strip())
    meta: dict = {"pages_total": total, "pages_extracted": selected, "truncated": False,
                  "source": "pypdf" if probe is not None else "pdftotext"}
    if not explicit and len(selected) > max_pages:
        selected = selected[:max_pages]
        meta["pages_extracted"] = selected
        meta["truncated"] = True

    parts: list[str] = []
    pdf_meta: dict = {}
    if probe is not None:
        parts, pdf_meta = _pypdf_pages(data, password, selected, reader=probe)
    if not any(part.strip() for part in parts):
        # Ein zweiter Leser sieht manche Textebenen, die pypdf nicht erkennt.
        fallback = _pdftotext(data, selected[0], selected[-1])
        if fallback:
            mapped = {
                selected[0] + index: text
                for index, text in enumerate(fallback)
                if selected[0] + index in selected
            }
            if any(text.strip() for text in mapped.values()):
                parts = [mapped.get(number, "") for number in selected]
                meta["source"] = "pdftotext"
    if pdf_meta:
        meta["pdf"] = pdf_meta

    ocr_mode = _text(db, "agent_pdf_ocr", "auto") if db is not None else "off"
    ocr_pages: list[int] = []
    if ocr_mode in ("auto", "always"):
        wanted = [
            number for number, text in zip(selected, parts)
            if ocr_mode == "always" or len(text.strip()) < 20
        ]
        ceiling = max(0, _int(db, "agent_pdf_ocr_max_pages", 40))
        wanted = wanted[:ceiling]
        if wanted:
            recognised, warning = _ocr(data, wanted, db)
            if recognised:
                for number, text in recognised.items():
                    index = selected.index(number)
                    parts[index] = text
                    ocr_pages.append(number)
                meta["ocr_pages"] = ocr_pages
                meta["source"] = "ocr"
            if warning:
                meta["ocr_warning"] = warning

    if len(selected) > 1:
        body = "\n\n".join(
            f"[Seite {number}]\n{_clean(part)}"
            for number, part in zip(selected, parts) if part.strip()
        )
    else:
        body = _clean("".join(parts))
    body = _clean(body)
    if len(body) < 3:
        if ocr_mode == "off":
            detail = ("Die PDF-Datei enthält keinen extrahierbaren Text. "
                      "Die Texterkennung (OCR) ist in den Einstellungen ausgeschaltet.")
        elif meta.get("ocr_warning"):
            detail = ("Die PDF-Datei enthält keinen extrahierbaren Text. "
                      f"OCR nicht möglich: {meta['ocr_warning']}.")
        else:
            detail = ("Die PDF-Datei enthält keinen extrahierbaren Text. "
                      "Ein Scan braucht eine Texterkennung; bitte OCR in den "
                      "Einstellungen prüfen.")
        raise AttachmentError(detail)
    meta["chars_extracted"] = len(body)
    return body, total, meta


# --------------------------------------------------------------------------
# Textdateien und gemeinsamer Einstieg
# --------------------------------------------------------------------------
def _decode(data: bytes) -> tuple[str, str]:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16"), "utf-16"
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace"), "utf-8"


def _text_file(data: bytes) -> tuple[str, dict]:
    text, encoding = _decode(data)
    return text, {"source": "text", "encoding": encoding, "pages_total": 0,
                  "pages_extracted": [], "truncated": False}


def extract(
    filename: str, content_type: str, data: bytes, *, db: Session | None = None,
    password: str = "", pages: str = "",
) -> tuple[str, int, str, dict]:
    max_bytes = max(1, _int(db, "agent_attach_max_mb", MAX_BYTES // (1024 * 1024))) * 1024 * 1024
    max_chars = max(1000, _int(db, "agent_attach_max_chars", MAX_CHARS))
    if not data:
        raise AttachmentError("Die Datei ist leer.")
    if len(data) > max_bytes:
        raise AttachmentError(
            f"Die Datei ist größer als {max_bytes // (1024 * 1024)} MB."
        )
    name = Path(filename or "anhang").name
    suffix = Path(name).suffix.lower()
    ctype = (content_type or "").split(";")[0].strip().lower()
    if suffix == ".pdf" or ctype == "application/pdf":
        text, pages_total, meta = _pdf_text(
            data, db=db, password=password, pages=pages
        )
        ctype = "application/pdf"
    elif suffix in ALLOWED or ctype in ALLOWED.values() or ctype.startswith("text/"):
        text, meta = _text_file(data)
        pages_total = 0
        ctype = (
            ctype
            if (ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml", "application/xml"))
            else (ALLOWED.get(suffix) or "text/plain")
        )
        if len(text.strip()) < 2:
            raise AttachmentError("Die Datei enthält keinen Text.")
    else:
        raise AttachmentError(
            "Nur PDF, HTML, SVG, Markdown, CSV, JSON, TXT, LOG und Code-Dateien werden unterstützt."
        )
    text = _clean(text)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n\n… (Text gekürzt)"
        meta["truncated"] = True
    return text, pages_total, ctype, meta


def extract_bytes(
    filename: str, content_type: str, data: bytes, *, db: Session | None = None,
    password: str = "", pages: str = "",
) -> tuple[str, int, dict]:
    text, pages_total, _ctype, meta = extract(
        filename, content_type, data, db=db, password=password, pages=pages
    )
    return text, pages_total, meta


def store(
    db: Session, chat: AgentChat, user: User, filename: str,
    content_type: str, data: bytes, *, password: str = "", pages: str = "",
) -> AgentAttachment:
    text, pages, ctype, meta = extract(
        filename, content_type, data, db=db, password=password, pages=pages
    )
    row = AgentAttachment(
        chat_id=chat.id, user_id=user.id, filename=Path(filename or "anhang").name[:240],
        content_type=ctype, size=len(data), pages=pages, chars=len(text),
        sha256=hashlib.sha256(data).hexdigest(), meta=meta, text=text,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def out(row: AgentAttachment) -> dict:
    meta = row.meta or {}
    return {
        "id": row.id,
        "filename": row.filename,
        "content_type": row.content_type,
        "size": row.size,
        "pages": row.pages,
        "chars": row.chars,
        "created_at": row.created_at,
        "meta": meta,
        "truncated": bool(meta.get("truncated")),
        "ocr": bool(meta.get("ocr_pages")),
    }


def preview_out(row: AgentAttachment) -> dict:
    """Metadaten plus extrahierter Text für die Seiten-Vorschau."""
    data = out(row)
    data["text"] = row.text or ""
    return data


def model_text(rows: list[AgentAttachment], db: Session | None = None) -> str:
    """Der Text, den das Modell sieht — mit Herkunft und Grenzen."""
    per_file = max(1000, _int(db, "agent_attach_per_file_chars", 60_000))
    budget = max(1000, _int(db, "agent_attach_budget_chars", 120_000))
    chunks: list[str] = []
    for row in rows:
        label = f"Anhang: {row.filename}"
        if row.pages:
            label += f" ({row.pages} Seiten)"
        meta = row.meta or {}
        if meta.get("ocr_pages"):
            label += f", OCR auf Seite(n) {', '.join(str(n) for n in meta['ocr_pages'][:20])}"
        body = row.text or ""
        if len(body) > per_file:
            body = body[:per_file] + "\n… (Anhang gekürzt)"
        block = f"[{label}]\n{body}\n[/Anhang]"
        if len(block) > budget:
            block = block[:budget] + "\n… (weitere Anhänge gekürzt)"
        budget = max(0, budget - len(block))
        chunks.append(block)
        if budget <= 0:
            break
    return "\n\n".join(chunks)

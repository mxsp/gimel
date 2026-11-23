from __future__ import annotations

from io import BytesIO

from pypdf import PdfReader


def make_pdf(text: str = "Hallo Gimel PDF") -> bytes:
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs.append(b"<< /Length " + str(len(stream)).encode()
                + b" >>\nstream\n" + stream + b"\nendstream")
    out = BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = [0]
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode())
        out.write(body)
        out.write(b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def test_pdf_and_text_upload_and_link(client):
    pdf = make_pdf()
    assert "Hallo Gimel PDF" in PdfReader(BytesIO(pdf)).pages[0].extract_text()
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        pdf_up = client.post(
            f"/api/agent/chats/{chat['id']}/attachments",
            files={"file": ("zeichnung.pdf", pdf, "application/pdf")},
        )
        assert pdf_up.status_code == 201, pdf_up.text
        pdf_out = pdf_up.json()
        assert pdf_out["pages"] == 1
        assert pdf_out["chars"] > 10
        txt_up = client.post(
            f"/api/agent/chats/{chat['id']}/attachments",
            files={"file": ("notiz.txt", b"Wichtiger Text fuer den Assistenten", "text/plain")},
        )
        assert txt_up.status_code == 201, txt_up.text
        txt_out = txt_up.json()

        detail = client.get(f"/api/agent/chats/{chat['id']}").json()
        assert len(detail["attachments"]) == 2

        # Senden ohne Schlüssel: Der Lauf endet mit einer Erklärung, aber die
        # Anhänge werden vorher der Nutzernachricht zugeordnet.
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Bitte lies die Zeichnung.",
                                 "attachment_ids": [pdf_out["id"], txt_out["id"]]}) as r:
            assert r.status_code == 200
            "".join(r.iter_text())

        detail = client.get(f"/api/agent/chats/{chat['id']}").json()
        user = next(m for m in detail["messages"] if m["role"] == "user")
        assert {a["id"] for a in user["attachments"]} == {pdf_out["id"], txt_out["id"]}
        assert detail["attachments"] == []

        # Angehängte Dateien nicht mehr einzeln löschen
        r = client.delete(f"/api/agent/chats/{chat['id']}/attachments/{pdf_out['id']}")
        assert r.status_code == 409
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def make_pdf_pages(texts: list[str]) -> bytes:
    """Ein kleines PDF mit mehreren Textseiten, ohne externe Bibliothek."""
    count = len(texts)
    font_id = 3
    first_page = 4
    page_ids = [first_page + 2 * i for i in range(count)]
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [" + b" ".join(f"{i} 0 R".encode() for i in page_ids)
        + b"] /Count " + str(count).encode() + b" >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, text in enumerate(texts):
        page_id = page_ids[index]
        content_id = page_id + 1
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
            f"/Contents {content_id} 0 R >>".encode()
        )
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
        objs.append(b"<< /Length " + str(len(stream)).encode()
                    + b" >>\nstream\n" + stream + b"\nendstream")
    out = BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = [0]
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode())
        out.write(body)
        out.write(b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def test_pdf_page_selection_and_page_markers(client):
    pdf = make_pdf_pages(["Seite eins", "Seite zwei", "Seite drei"])
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        up = client.post(
            f"/api/agent/chats/{chat['id']}/attachments",
            files={"file": ("bericht.pdf", pdf, "application/pdf")},
            data={"pages": "2"},
        )
        assert up.status_code == 201, up.text
        out = up.json()
        assert out["pages"] == 3
        assert out["meta"]["pages_extracted"] == [2]
        detail = client.get(f"/api/agent/chats/{chat['id']}").json()
        attached = detail["attachments"][0]
        assert attached["meta"]["pages_extracted"] == [2]
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_pdf_page_limit_truncates_instead_of_refusing(client):
    pdf = make_pdf_pages(["eins", "zwei", "drei"])
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        client.put("/api/agent/settings", json={"values": {"agent_pdf_max_pages": "1"}})
        up = client.post(
            f"/api/agent/chats/{chat['id']}/attachments",
            files={"file": ("gross.pdf", pdf, "application/pdf")},
        )
        assert up.status_code == 201, up.text
        out = up.json()
        assert out["pages"] == 3
        assert out["truncated"] is True
        assert out["meta"]["pages_extracted"] == [1]
    finally:
        client.post("/api/agent/settings/reset", json={"keys": ["agent_pdf_max_pages"]})
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_password_protected_pdf_needs_the_password(client):
    from pypdf import PdfReader, PdfWriter

    plain = make_pdf("Geheimer Text")
    reader = PdfReader(BytesIO(plain))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt("geheim")
    out = BytesIO()
    writer.write(out)
    locked = out.getvalue()
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        refused = client.post(
            f"/api/agent/chats/{chat['id']}/attachments",
            files={"file": ("gesperrt.pdf", locked, "application/pdf")},
        )
        assert refused.status_code == 422
        assert "passwortgeschützt" in refused.text

        opened = client.post(
            f"/api/agent/chats/{chat['id']}/attachments",
            files={"file": ("gesperrt.pdf", locked, "application/pdf")},
            data={"password": "geheim"},
        )
        assert opened.status_code == 201, opened.text
        assert opened.json()["chars"] > 0
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")


def test_unsupported_and_empty_uploads_are_refused(client):
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        r = client.post(
            f"/api/agent/chats/{chat['id']}/attachments",
            files={"file": ("schaedlich.exe", b"MZ...", "application/octet-stream")},
        )
        assert r.status_code == 422
        r = client.post(
            f"/api/agent/chats/{chat['id']}/attachments",
            files={"file": ("leer.txt", b"", "text/plain")},
        )
        assert r.status_code == 422
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")

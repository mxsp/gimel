# Gimel Agent Lab

Der Assistent als **eigenständige Anwendung auf Port 8008**. Er läuft als
Gimel-Plugin (`gimel.extensions.Plugin`) in einem eigenen Prozess, nutzt aber
dieselben Konten, Rollen, Dienste und – auf ausdrücklichen Wunsch – dieselbe
Datenbank wie das laufende Gimel.

Das Labor bleibt die eigenständige Oberfläche für Einstellungen und
Werkzeugtests. Das Hauptportal `/app` bringt den Assistenten inzwischen selbst
mit: Es bindet `/api/agent` und die `agent_*`-Tabellen ein und öffnet den Chat
als rechte Seitenleiste (Kopfzeile oder **Strg+Shift+A**). Voraussetzung ist,
dass `agentlab/` neben `gimel/` liegt; sonst fehlen Routen und Knopf.

## Starten

Voraussetzung: Gimel läuft bereits mit dem Datenordner, der die Datenbank
enthält (im Repository normalerweise `.data/gimel.db`).

```powershell
# Oberfläche bauen (einmalig nach Änderungen)
cd agentlab/web
npm install
npm run build

# Labor starten
cd ../..
python -m agentlab serve --port 8008 --data .data
```

Dann im Browser öffnen:

```text
http://127.0.0.1:8008/lab
```

Im Hauptportal steht der Weg dorthin in der Seitenleiste unter **Assistenz →
Agent Lab** (öffnet einen neuen Tab). Anmeldung mit einem Gimel-Konto. Das
gemeinsame PIN-Konto funktioniert ebenfalls; Anbieter und Schlüssel darf nur
ein Admin pflegen.

### Warum `--data` Pflicht ist

Das Labor liest aus dem Datenordner:

- `gimel.db` (dieselbe Datenbank wie Gimel)
- `secret.key` (derselbe Betriebsschlüssel für Sitzungen und `secretbox`)
- optional `.env` (dieselben `GIMEL_*`-Einstellungen)

Fehlt die Datenbank oder der Schlüssel, bricht der Start mit einer Erklärung
ab. Das Labor legt **keine** neue Datenbank an und führt **kein** Demo-Seed
aus.

### Was das Labor in der gemeinsamen Datenbank anlegt

Nur additive Tabellen:

- `agent_providers`
- `agent_chats`
- `agent_messages`
- `agent_settings`
- `agent_attachments`
- `agent_changes`
- `agent_prompts` (Vorlagen, seit 2026-11-07)

Keine bestehende Tabelle und keine bestehende Spalte wird umbenannt oder
gelöscht. Gimel selbst ignoriert die Tabellen. Trotzdem vor dem ersten Start
eine Sicherungskopie von `.data/gimel.db` (und `-wal`/`-shm`, falls
vorhanden) anlegen.

### Taktgeber

Der Gimel-Taktgeber (Sammellauf im Hintergrund) läuft **nur** im
Hauptprozess. `agentlab/app.py` ersetzt `gimel.services.scheduler.loop` vor
dem Bau der Anwendung durch eine wartende Funktion. Zwei Prozesse dürfen
nicht zwei Sammelläufe planen.

## Anbieter, Endpunkte und Modelle

Unter **Einstellungen → Anbieter** (nur Admins schreibend):

- mehrere OpenAI-kompatible Endpunkte als Profile
- Presets: OpenCode Go, OpenAI, Ollama (lokal), benutzerdefiniert
- Basis-URL und eigener Modelle-Endpunkt
- API-Schlüssel (versiegelt gespeichert, nie zurückgegeben)
- Zusatz-Header als JSON; `Authorization`, `Cookie`, `Host` und
  `Content-Length` sind gesperrt
- Verbindung testen
- Modelle laden und im Chat auswählen
- Standardanbieter und Standardmodell
- Schlüssel entfernen, Anbieter deaktivieren

OpenCode Go ist vorkonfiguriert:

```text
Basis-URL:     https://opencode.ai/inference/go/openai/v1
Modelle:       https://opencode.ai/inference/go/v1/models
Standardmodell: deepseek-v4.1-flash
```

### mx-GPT simulieren (kali2)

mx-GPT ist eine Node-Oberfläche auf Port 8088 und spricht selbst kein
OpenAI-Protokoll. Für Tests im Agent Lab gibt es deshalb einen kleinen
OpenAI-kompatiblen Simulator (nur Standardbibliothek):

```bash
# auf kali2 (oder lokal) starten
python -m agentlab.mxgpt_sim --host 0.0.0.0 --port 8090
```

Danach in **Einstellungen → Anbieter** das Preset **mx-GPT (Simulation kali2)**
wählen. Es zeigt standardmäßig auf `http://192.168.178.54:8090/v1`; ein anderer
Host lässt sich über `GIMEL_MXGPT_SIM_URL` setzen. Der Simulator beantwortet
`/v1/models`, `/v1/chat/completions` (auch als SSE-Stream) und `/health`.
Werkzeugaufrufe lassen sich mit `[tool:werkzeug_name {"arg": 1}]` in der
letzten Nutzernachricht erzwingen.

Der Modelle-Endpunkt wird zehn Minuten zwischengespeichert. „Modelle laden“
erzwingt eine Aktualisierung. Ist der Endpunkt nicht erreichbar und liegt
noch eine alte Liste vor, bleibt diese benutzbar; die Oberfläche zeigt eine
Warnung. Für OpenCode Go gibt es zusätzlich eine eingebaute Ersatzliste.

### Schlüssel aus der Umgebung

Der Schlüssel des Standardanbieters kann statt in der Datenbank in der
Umgebung liegen:

```text
GIMEL_AGENT_API_KEY=...
# oder, ohne Präfix:
AGENT_API_KEY=...
```

Umgebung gewinnt. Die Oberfläche zeigt dann „Schlüssel aus Umgebung“.

### Sicherheit der Endpunkte

- nur `http://` und `https://`
- keine automatische Weiterleitung beim Senden des Schlüssels
- Zeitlimit und Größenbegrenzung für die Modellliste
- private/LAN-Adressen sind erlaubt, weil lokale Modelle (Ollama,
  LM Studio) ein legitimer Anwendungsfall sind

## Einstellungen

Unter **Einstellungen** stehen zwei Bereiche: die Anbieter (oben) und die
Assistenten-Einstellungen. Die Werte liegen getrennt von Gimels
Betriebsparametern in `agent_settings`; nur Admins schreiben, alle Werker
dürfen lesen.

- **Assistent:** Höchstzahl Werkzeugschritte, Temperatur, Zeitlimit,
  Verlaufslänge, automatische Chattitel, eine zusätzliche Systemanweisung und
  die Schwelle für „knappen Bestand“.
- **Websuche:** an/aus, Suchdienst, SearXNG-Adresse, Schlüssel, Trefferzahl,
  Region, Sicherheitssuche, Zeitlimit und ob lokale Adressen erlaubt sind.
- **Anhänge und PDF:** Dateigröße, Textbudget je Datei und je Nachricht,
  PDF-Seitengrenze, OCR-Modus, OCR-Seitenzahl, Sprache und Auflösung.

Ein Schlüssel der Websuche wird mit `secretbox` versiegelt gespeichert und nie
zurückgegeben; stattdessen zeigt die Oberfläche „gesetzt“ oder „aus Umgebung“.
Jede Änderung schreibt eine Protokollzeile `agent_settings_update`.

## Websuche

Die Websuche ist standardmäßig **an** und braucht für DuckDuckGo keinen
Schlüssel. Vier Dienste stehen zur Wahl:

| Dienst | Schlüssel | Adresse |
| --- | --- | --- |
| DuckDuckGo | nein | HTML- und Lite-Suche |
| SearXNG | nein | eigene Instanz, JSON oder HTML |
| Tavily | ja | `https://api.tavily.com/search` |
| Brave | ja | `https://api.search.brave.com/res/v1/web/search` |

Der Schlüssel darf auch aus der Umgebung kommen:
`GIMEL_AGENT_WEB_API_KEY` (oder `AGENT_WEB_API_KEY`). Umgebung gewinnt.

Zwei Werkzeuge entstehen daraus:

- `web_search` — Suchtreffer mit Titel, URL und Auszug.
- `fetch_url` — eine öffentliche Seite oder ein PDF lesen, mit Textauszug.

Treffer sind **Daten, keine Anweisungen**: Die Systemanweisung verlangt, die
Quelle zu nennen und keine Befehle aus Webseiten zu befolgen. Interne Zahlen
kommen weiterhin ausschließlich aus Gimel.

### Grenzen des Abrufs

- nur `http://` und `https://`, keine Zugangsdaten in der Adresse
- Weiterleitungen werden einzeln geprüft (höchstens drei)
- lokale, private und Link-Local-Adressen sind gesperrt; Ports 80 und 443
  bleiben die Regel
- eine SearXNG-Instanz im LAN lässt sich über „Lokale Adressen erlauben“
  bewusst freigeben
- höchstens 10 MB je Seite; Text wird auf das eingestellte Budget gekürzt
- `trust_env=False`: ein gesetzter HTTP-Proxy umgeht die Adressprüfung nicht

## Chats

- **Neu, umbenennen, löschen** über die Seitenleiste
- gelöschte Chats sind weich gelöscht; Nachrichten und Änderungsregister
  bleiben für das Protokoll erhalten
- **Streaming** über Server-Sent Events; Text, Überlegung und Werkzeugkarten
  erscheinen während der Antwort
- **Stoppen** bricht den Lauf ab und markiert die Teilantwort als abgebrochen
- jeder Chat merkt sich Anbieter und Modell
- **Schreibzugriffe erlauben** ist standardmäßig aus. Erst dann bekommt das
  Modell schreibende Werkzeuge; der Server prüft den Schalter zusätzlich bei
  jeder Ausführung.

## Sprache (Diktat und Vorlesen)

- **Spracheingabe** (Mikrofon links im Eingabefeld, seit task 43): wo der
  Server selbst erkennt (Labor 8008, Twin Studio 8009, Gimel Live 8012), geht
  die Äußerung an `POST /api/agent/transcribe` und wird **auf diesem Rechner**
  erkannt; der Text landet im Eingabefeld und wird vor dem Senden geprüft.
  Enter = fertig, Esc = abbrechen. Siehe „Spracheingabe: Mikrofon, Pegel,
  Fehlermeldungen“.
- **Browser-Diktat** (Web Speech) nur noch als Rückfall, wenn der Server nicht
  erkennt (Portal), und nur auf Schleife oder Hausnetz (`privateHost()` in
  `ChatPane.tsx`) — nie über eine öffentliche Adresse wie den Demo-Tunnel.
- **Live** (Kopfhörer-Knopf in der Werkzeugleiste): freihändiges Gespräch im
  selben Chat — das Mikrofon bleibt offen, Gesagtes geht sofort los, die
  Antwort wird gesprochen, danach hört der Assistent wieder zu; hineinsprechen
  unterbricht Stimme und Lauf. Drei stille Runden pausieren. Mit Schreibzugriff
  aus. Live hört auch Gespräche in der Nähe mit und sendet sie ohne Vorschau an
  das Sprachmodell.
- **Vorlesen je Antwort** („Vorlesen“ unter jeder Antwort) unabhängig vom
  Schalter; **Tempo** 0,9–1,3× (Piper `length_scale`, edge `rate`; Feld `rate`
  0,8–1,4 an `POST /api/agent/speech`).
- **Vorlesen** (Lautsprecher in der Werkzeugleiste): die Antwort wird
  satzweise gesprochen, während sie eintrifft. Der jeweils nächste Satz wird
  schon geholt, während der laufende noch klingt. Stoppen oder eine neue Frage
  bricht die Ausgabe ab. Die Einstellung merkt sich der Browser.
- **Stimme:** Einstellungen → Sprache (`agent_tts_backend`). Vorgabe `lokal`:
  Piper auf diesem Rechner, WAV über `POST /api/agent/speech`, kein Text
  verlässt den Rechner. `edge` (nur Testdaten): `edge-tts`, Microsoft-Cloud,
  MP3. Fehlt der Server-Weg, spricht eine lokale Browserstimme; eine
  Netzstimme (Google, Microsoft Online) wird nie benutzt.
- Die eigene Spracheingabe geht in Firefox, Chrome, Edge und Safari; das
  Browser-Diktat nur in Chromium und Safari. Vorlesen in allen gängigen Browsern.
- Das Mikrofon braucht einen sicheren Kontext: `127.0.0.1`/`localhost` oder
  HTTPS. Über `http://` im Netz verweigert der Browser den Zugriff.
- Das Browser-Diktat schickt das Audio an den Dienst des Browser-Herstellers
  (Chrome: Google, Edge: Microsoft); beim
  Vorlesen geht nur der Antworttext an den TTS-Dienst. Für vertrauliche
  Inhalte ist beides deshalb nicht geeignet.
- **Wiedergabe über Web Audio** (seit 2026-11-08): bis dahin spielte das Labor
  das MP3 über `<audio src="blob:…">`, das die Inhaltsrichtlinie (`media-src`
  fällt auf `default-src 'self'`) blockiert — es sprach praktisch immer die
  Browserstimme.

## Gimel Voice (Sprechen mit dem Assistenten, seit 2026-11-08)

Eine eigene Seite mit einem großen Mikrofonknopf: sprechen, die Antwort hören.
Dasselbe Modell, dieselben Werkzeuge, Rechte und Rücknahmen wie im Labor —
jedes Gespräch ist ein normaler Agent-Lab-Chat („Gimel Voice“) und dort
nachzulesen.

```text
http://127.0.0.1:8008/voice        im laufenden Agent Lab (mit PIN-Anmeldung)
python -m agentlab voice --data .data   eigener Prozess auf 127.0.0.1:8012, ohne PIN
```

Einmalig: `pip install -e ".[voice]"` (faster-whisper, PyAV < 15, piper-tts) und eine
Piper-Stimme:

```text
python -m piper.download_voices --download-dir ~/.local/share/gimel/piper-voices de_DE-thorsten-medium
```

(anderer Ordner über `GIMEL_VOICE_PIPER_DIR`; jede `<name>.onnx` mit `.onnx.json` darin
erscheint in der Stimmauswahl).
Das Erkennungsmodell (Vorgabe `small`, ≈ 480 MB) lädt beim ersten Sprechen
nach `~/.cache/huggingface`; der eigene Prozess lädt es beim Start vorab.
`GIMEL_VOICE_STT_MODEL=base` ist schneller und etwas ungenauer,
`GIMEL_VOICE_STT_THREADS` setzt die CPU-Threads (Vorgabe 4).

Auch das Test-Portal (Demo auf 127.0.0.1:8040) kann die Erkennung einbinden:
`gimel serve --voice` bzw. `GIMEL_VOICE=1` (so startet `fyrefly gimel demo` sie).
Der Schalter „Live“ im Chat (Labor, Seitenleiste, Studio) wird dann dort frei.
Nie einschalten, solange ein Tunnel auf das Portal zeigt (`fyrefly gimel public`) —
die Erkennung kostet Rechenzeit je Anfrage.

**Ablauf.** Antippen (oder Leertaste) → der Browser nimmt über das gewählte Mikrofon auf
und zeigt Pegel und Schwelle; nach 1,2 s Stille endet die Äußerung von selbst
(nach 8 s ohne Signal kommt eine Meldung mit dem Gerätenamen). Der erkannte Text
steht 2,2 s zur Prüfung da (Jetzt senden · Bearbeiten · Verwerfen), dann geht er los. Die Aufnahme geht als roher Körper an
`POST /api/agent/transcribe` und wird **auf diesem Rechner** erkannt. Der Text
geht mit `route = "/voice"` in den Chat; der Systemtext bekommt dann die Regel
„Sprachmodus“ (kurze ganze Sätze, keine Tabellen, Markdown oder Links,
nachfragen bei unsicheren Nummern). Jeder fertige Satz geht sofort an
`POST /api/agent/speech` (höchstens zwei zugleich; lokal Piper als WAV, ≈ 0,5 s
je Satz) und wird der Reihe nach über Web Audio gespielt, während der Rest der Antwort noch geschrieben wird.
Antippen während der Antwort unterbricht: Ton aus, Lauf abgebrochen
(`/cancel`), Mikrofon an. **Live-Gespräch** (früher „Freihändig“) hört nach
jeder Antwort ohne Vorschau wieder zu, hält das Mikrofon offen und lässt sich
durch Hineinsprechen unterbrechen. Als eigene App: `fyrefly gimel voice`
(Unit `fyrefly-gimel-voice.service`, nur auf Abruf, 127.0.0.1:8012). Tippen geht auch („… oder tippen und vorlesen lassen“).

**Gemessen 2026-11-08** (6 Kerne, CPU): 6 s Sprache → `small` 3,1–4,0 s,
`base` 1,5 s, beide wortgenau; Modell laden `small` ≈ 19 s beim allerersten
Mal (Download), danach ≈ 2 s.

**Grenzen.** Aufnahme ≤ 10 MB und ≤ 120 s, eine Erkennung zur Zeit (eine
zweite bekommt sofort 409, sie wartet nicht). Das Format wird aus den ersten
Bytes erkannt (WebM/Matroska, OGG, MP4, WAV, MP3), nur Opus, Vorbis, AAC,
MP3 und PCM, genau eine Tonspur. Der Decoder hört nach 120 s Audio auf — eine
kleine Datei mit stundenlanger Stille (1,5 MB Opus = 6000 s) kostet so keinen
Speicher. Die Aufnahme wird nie auf
die Platte geschrieben und nicht protokolliert; gespeichert wird nur der
erkannte Text als Chat-Nachricht. Das Mikrofon wird nach jeder Äußerung
freigegeben, im Live-Gespräch erst an dessen Ende. `Permissions-Policy: microphone=(self)` auf `/voice`.

**Eigener Prozess ohne PIN.** Wie im Twin Studio: die PIN-Sperre zählt
Fehlversuche je Prozess im Speicher, ein zweiter Prozess verdoppelte die
Versuche. `python -m agentlab voice` beantwortet `/api/auth/pin` deshalb mit
404 und lauscht nur auf Schleifen-Adressen. Mit PIN: `/voice` im Agent Lab.

**Nur im Labor und im Studio.** `/api/agent/voice` und `/transcribe` stehen in
`voice_router.py` und werden von `create_lab_app` und (seit task 43) von
`gimel.studio.create_studio_app` über `agent_bridge.load_voice()` eingebunden —
`gimel studio` lauscht nur auf der Schleife; abschalten mit
`GIMEL_STUDIO_VOICE=0`, Modell nicht vorladen mit `GIMEL_VOICE_WARMUP=0`.
`gimel.agent_bridge.load()` bringt in ein eigenständiges Portal (auch die
getunnelte Demo) nur `router` — dort gibt es keine Spracherkennung.

**Datenschutz.** Die Aufnahme bleibt im Arbeitsspeicher des Gimel-Servers,
wird erkannt und verworfen; sie wird weder auf die Platte geschrieben noch
protokolliert. Der erkannte Text ist eine normale Chat-Nachricht
(Aufbewahrung wie Agent-Lab-Chats). Frage, Werkzeugergebnisse und Antwort
gehen an den eingestellten Modellanbieter. Vorlesen: Vorgabe ist `lokal`
(Piper, sonst eine lokale Browserstimme, nie eine Netzstimme). `edge`
(Einstellungen → Sprache, nur Admin) schickt den Antworttext an Microsofts
Edge-Vorlesedienst (inoffizieller Client, kein Vertrag, keine AVV, Dienst kann
jederzeit wegfallen) und ist nur für fiktive Demodaten zulässig; das Paket
steckt deshalb nur im Extra `[tts]`. Die alte Diktierfunktion im Labor schickt
in Chrome das Audio an Google; Gimel Voice nutzt sie nicht. Mit
Schreibzugriff im Chat ist „Freihändig“ aus.

**API.** `GET /api/agent/voice` (was installiert ist, Stimmen, Grenzen),
`POST /api/agent/transcribe?language=de|en|auto` mit `Content-Type: audio/…`
und der Aufnahme als Körper → `{text, language, audio_seconds, speech_seconds,
peak_dbfs, rms_dbfs, gain_db, processing_seconds, model}`; 415 kein Audio, 413 zu groß/zu lang, 409
belegt (`Retry-After: 3`), 422 unlesbar/fremdes Format/zu kurz/leer, 503 ohne `[voice]`. Andere Programme sprechen so mit
dem Assistenten: transkribieren → `POST /api/agent/chats/{id}/messages` mit
`route: "/voice"` (SSE) → Sätze an `POST /api/agent/speech`.

## Spracheingabe: Mikrofon, Pegel, Fehlermeldungen (task 43, 2026-11-08)

**Warum.** „Ich habe nichts gehört“ kam, obwohl gesprochen wurde. Ursache auf
diesem Rechner: die Systemvorgabe für den Eingang ist „USB Audio Analog Stereo“
(ASUS), ein Eingang ohne Mikrofon — er liefert exakt 0; das Webcam-Mikrofon
stand auf 10 %. Die Seite bot keine Gerätewahl, und ihr Tor verwarf alles unter
≈ −42 dBFS, obwohl Whisper −50 dBFS fast wortgenau erkennt. Die Aufnahme kam nie
beim Server an.

**Ein Modul für alle vier Stellen** (`web/src/voiceInput/`): `gate.ts` (rein,
`web/voice-input.test.mjs`), `mic.ts` (Mikrofon, Gerät, Äußerung, Upload),
`useVoiceInput.ts` (Eingabefeld), `MicPanel.tsx` (Anzeige).

- **Gerät wählen**, gemerkt in `gimel-mic-device`; ein verschwundenes Gerät
  fällt still auf die Systemvorgabe zurück. Namen zeigt der Browser erst nach
  der ersten Freigabe. Gimel Live hat „Mikrofon testen“ (5 s Pegel, ohne
  Aufnahme).
- **Tor:** Schwelle = Grundrauschen + 8 dB, nie unter −55 dBFS; das Rauschen
  folgt laufend (fällt schnell, steigt langsam), wer beim Drücken schon spricht,
  verschiebt es nicht dauerhaft. Sprache ab 120 ms über der Schwelle, Ende nach
  1,2 s Stille, Silbenpausen bauen nur halb ab.
- **Kein stilles Veto:** kam Signal über dem Rauschen, aber keine klare Sprache,
  geht die Aufnahme trotzdem an den Server („maybe“); dessen VAD entscheidet.
- **Server** hebt leise Aufnahmen an (Spitze auf −6 dBFS, höchstens +40 dB) und
  meldet `peak_dbfs`, `rms_dbfs`, `speech_seconds`, `gain_db`.
- **Meldungen** (`problemText`), je mit Ausweg (anderes Mikrofon, erneut):
  digitale Stille 1,5 s → „„<Gerät>“ liefert kein Signal …“; Spur stumm/getrennt;
  nur Rauschen; sehr leise (mit dB) und nichts verstanden; nicht verstanden;
  Browser blockiert (wo man es erlaubt); belegt; kein https; kein Server.
- **Live und Hineinsprechen:** beim Vorlesen hebt der Pegel der eigenen Ausgabe
  (× 1,6) die Schwelle an, und es braucht 250 ms Sprache — Echo aus dem
  Lautsprecher unterbricht nicht, lautes Hineinsprechen schon.
- **Firefox:** eigener AudioContext für die Messung, bei abweichender
  Abtastrate neu mit der des Mikrofons.

**Prüfen.** `node web/voice-input.test.mjs`; `pytest agentlab/tests/test_voice_levels.py`
(enthält einen echten Whisper-Lauf auf −50 dBFS, braucht espeak);
`tests/app/test_twin_studio.py` (Studio hat die Erkennung, das Portal nicht).
Ende-zu-Ende mit falschem Mikrofon: Chromium mit
`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`.

## Anhänge (PDF und Text)

Dateien lassen sich über die Büroklammer oder per Drag-and-drop an eine
Nachricht hängen:

- PDF, TXT, Markdown, CSV, JSON und LOG; Grenzen und Budgets stehen in den
  Einstellungen (Vorgabe: 15 MB, 250 Seiten, 300.000 Zeichen je Datei)
- **Seitenauswahl** beim Hochladen (`pages`, z. B. `1-5,8,12-`); ohne Auswahl
  wird eine zu große PDF auf die eingestellte Seitengrenze gekürzt und als
  `truncated` markiert, statt den Upload abzulehnen
- **passwortgeschützte PDFs** fragen im Chat nach dem Passwort. Es wird nur
  zum Entsperren benutzt und nie gespeichert
- **mehrere Extraktionswege:** `pypdf` liest die Textebene, `pdftotext`
  (poppler) ist der zweite Weg und oft bei alten Scans besser. Fehlt eine
  Textebene, folgt auf Wunsch OCR über `pdftoppm` + `tesseract`
  (Modus `auto`/`immer`/`aus`, Seiten- und Sprachnotbremse)
- Seiten werden mit `[Seite n]` markiert; das Modell kann daraus zitieren.
  PDF-Titel und -Autor landen in `meta`, nie das Passwort
- **die Originaldatei wird nicht gespeichert.** Gespeichert werden Name, Typ,
  Größe, Prüfsumme, Seitenzahl, Extraktions-Metadaten und der Text
  (verschlüsselt über `EncryptedText`)
- der Text geht als klar abgegrenzter Block an das Modell; pro Lauf gilt das
  eingestellte Gesamtbudget (Vorgabe 120.000 Zeichen)

OCR braucht die Programme `pdftoppm` und `tesseract` samt Sprachpaket. Fehlen
sie, sagt die Fehlermeldung das; der Rest des Labors läuft weiter.

## Werkzeuge

Rollen: Werker sehen Halle und Fertigung; Personal zusätzlich Kunden, Preise,
Rechnungen und Einstellungen; Admins zusätzlich Betriebsparameter und
Stationen.

Der Katalog umfasst derzeit **141 Werkzeuge** (67 lesend, 74 schreibend).

**Lesen** — Aufträge, Kunden, Werkstoffe, Lager, Innenaufträge, Stationen,
Versände, Sammelläufe, Rechnungen, Protokoll, Einstellungen, Zeichnungen,
Warteschlange, Arbeitsvorrat, Bereitstellung, Kommissionierung,
Stationsschlangen, Topologie, Fertigungsorte, Plattenbelegung,
Freigaberegeln, Kalkulationssätze, Versandbereitschaft, Compliance und das
eigene Konto. Neu dazu:

- `global_search` — Aufträge, Kunden, Werkstoffe, Innenaufträge, Versände und
  Zeichnungen in einem Zug durchsuchen
- `get_customer_orders`, `get_order_timeline`
- `get_low_stock`, `get_stock_history`, `get_price_history`
- `get_station_load`, `get_due_orders`, `get_shipment_board`, `get_activity`
- `list_robots`, `list_robot_gateways`, `list_robot_programs`,
  `list_robot_jobs`
- `web_search`, `fetch_url` (nur bei eingeschalteter Websuche)

**Analyse und Planung** (task 36, `agentlab/analysis_tools.py`) — rechnen nur,
schreiben nie: `_readonly` nimmt nach jedem Aufruf die Sitzung zurück, die
Tests vergleichen die Zeilenzahl jeder Tabelle vorher und nachher.

- `get_order_trace` — Auftrag → Innenaufträge → Platten → Stationen → Sendungen
- `get_run_trace` — ein Sammellauf (ohne Nummer: der letzte) mit Ausnutzung,
  Verschnitt und Ersparnis gegenüber Einzelschachtelung
- `analyse_twin` — Befunde der Zwillingsanalyse samt Stationslast
- `get_factory_plan` (Büro) — was die Disposition zuordnen würde, nichts angewendet
- `get_material_flow` — Transporte zwischen Stationen, Meter, genau/geschätzt
- `get_kpis` — Durchsatz, Durchlaufzeit, Termintreue, Überfällige,
  Materialausnutzung über N Tage; Unbekanntes ist `null`, Ausschuss und
  Stillstand werden nicht erfasst und so benannt; Beträge nur fürs Büro
- `get_material_demand` — Plattenbedarf wartender Positionen je Werkstoff und
  Dicke gegen den Bestand (Preis-Rechenkern, also eine obere Schätzung)
- `get_shape_usage` (Büro) — wo eine Bibliotheksform verwendet wird
- `quote_price` (Büro) — Preis ohne Auftrag, dieselbe Rechnung wie `/api/quote`
- `check_part_fit` — Maßgrenzen, Mindeststeg, Eckabstand, passende Plattenformate
- `plan_robot_way` — Roboterweg und Fahrzeit zwischen zwei Stationen einer Ebene
- `simulate_fleet` (Büro) — geplante Transportroboter durchrechnen, nichts gespeichert
- `calculate` — exakte Arithmetik über einen AST-Auswerter (kein `eval`):
  Zahlen, + − × ÷ // % **, Klammern, Variablen, `pi`, `e`, `sqrt`, `round`,
  `min`, `max`, `sum`, `mean`, `log`, Winkel, `hypot`, `circle_area`,
  `ring_area`, `circumference`; Grenzen 600 Zeichen, 300 Knoten, Potenz ≤ 100,
  Ergebnis ≤ 10¹⁵

**Kamera, Standpunkt und Platzierung** — die Seite meldet Standpunkt und Blick
erst beim Senden (`usePageProbe`, `standpunkt_x/y`, `blick_richtung` in Metern
bzw. Grad, 0 = +y; `vor_mir_id` ist die Station im Blick). Darauf setzen auf:

- `where_am_i` — wo der Nutzer steht, wohin er schaut und welche Station direkt
  davor ist
- `select_station` — Station auswählen; `in_front` nimmt die Station vor dem
  Nutzer, `edit` öffnet den Grundriss-Editor mit ihr (dort ziehbar); speichert
  nichts
- `prepare_station_placement` — neue Station zur Platzierung vorbereiten, ohne
  sie anzulegen; der Editor öffnet mit Typ, Maschinenart und Position
- `create_station` und `update_station` — mit `placement="in_front"` landet die
  Station `distance_m` Meter entlang der Blickrichtung; ohne x/y und ohne
  Standpunkt wird nichts geraten, sondern ein Fehler erklärt
- `get_station_view` — eine Station samt gemeldetem Standpunkt und Einstellung

**Schreiben** — u. a. Auftrag freigeben/bezahlen/ändern/anlegen/kopieren/
nachbestellen/sperren/löschen, Position ändern und löschen, Bearbeiter setzen,
Fertigungsort setzen, Werkstoff und Preis ändern, Bestand buchen, Kunden und
Anschriften pflegen, Innenauftragsstatus/Zuordnung/Bereitstellung/
Plattenstatus, Versand anlegen/ändern/löschen, Stationen samt Maschinenwerten,
Standorte, Hallen und Ebenen, Zeichnungen, Kalkulationssätze, Freigaberegeln,
Benutzerkonten (anlegen, ändern, Kennwort, Sperre, MFA), Rechnungen
(ausstellen, senden, stornieren, Zahlungseingang), Compliance-Hinweise und
Supportzeiträume sowie den Sammellauf.

**Nicht rückholbar** — u. a. `delete_order`, `delete_order_position`,
`delete_shipment`, `delete_customer`, `delete_user`, `delete_station`,
`delete_site`, `delete_hall`, `delete_drawing`, `delete_advisory`,
`delete_support_period`, `start_batch_run`, `delete_customer_address`,
`set_task_state`, `delete_floor` und `delete_batch_policy`. Die Oberfläche
kennzeichnet sie. `block_order`, `set_order_handler`, `update_order_position`
und die meisten Stammdatenänderungen sind rückholbar.

Die vollständige, rollenabhängige Liste liefert `GET /api/agent/tools`, je
Werkzeug mit Bereich (`category`) und Argumentschema (`parameters`).
Das ist auch die Quelle für die Ansicht **Werkzeuge** in der Oberfläche:
Bereiche zum Auf- und Zuklappen (Zustand je Browser), Filter Alle / Lesen /
Schreiben / Nicht rückholbar, je Werkzeug die Argumenttabelle. Im Testdialog
setzt „Beispiel einsetzen“ die Pflichtfelder typrichtig ein („mit allen
Feldern“ auch die freiwilligen), Strg+Enter führt aus, und der letzte Lauf je
Werkzeug bleibt für die Sitzung des Browsers stehen. Schreibende Werkzeuge
laufen nur bei eingeschaltetem Schreibmodus. Der Aufruf läuft über
`POST /api/agent/chats/{id}/tools/{name}` und landet bei Änderungen im
Änderungsregister.

## Chat: neu erzeugen, bearbeiten, exportieren, Vorlagen

- **Neu erzeugen** (letzte Antwort) und **Bearbeiten** (jede eigene Frage)
  laufen über `POST /chats/{id}/rewind`: die Frage und alles danach bekommen
  `hidden_at` und verschwinden aus Verlauf, Modellkontext und Vorschau — gelöscht
  wird nichts. Die Anhänge der Frage werden wieder frei und gehen mit der neuen
  Frage mit. Hat der ausgeblendete Teil Änderungen gemacht, fragt die Oberfläche
  vorher; die Änderungen bleiben bestehen und im Register rückholbar.
  Protokoll `agent_chat_rewind`. Während einer laufenden Antwort: 409.
- **Token** je Antwort (Eingabe/Ausgabe, Listenpreis und abgerechnet im Tooltip)
  und für den ganzen Chat in der Hinweiszeile, aus der vom Anbieter gemeldeten
  `usage`; ohne Meldung keine Zahl. Die vollständige Auswertung steht unter
  **Statistik**.
- **Exportieren** als Markdown (Fragen, Antworten, Werkzeugaufrufe mit
  Argumenten und gekürztem Ergebnis, Änderungen) oder JSON (die ganze
  Chat-Antwort). Läuft nur im Browser; der Server sieht keinen Export.
- **Vorlagen:** `/` am Anfang der Eingabe oder der Knopf „Vorlagen“ öffnet die
  Liste (↑↓, Enter, Esc). Eigene Vorlagen je Konto in `agent_prompts`
  (Titel ≤ 120, Text ≤ 4000, höchstens 100, Text verschlüsselt wie
  Chatinhalte); teilen darf nur, wer Admin-Arbeit hat, und fremde geteilte
  Vorlagen ändert nur ein Admin. Dazu feste Schnellstarts je Rolle
  (`BUILTIN_PROMPTS` in `router.py`), die auch die leere Chatansicht füllen.
  Ein Platzhalter wie `{Auftragsnummer}` wird nach dem Einsetzen markiert.
  Protokoll `agent_prompt_create|update|delete` ohne Inhalt.

## Statistik: Modelle, Token, Kosten

Die Ansicht **Statistik** (Tab neben „Änderungen“) zeigt, was der Assistent
wirklich verbraucht hat. Grundlage ist ausschließlich `agent_messages.usage`,
also die Meldung des Anbieters je Modellrunde:

- **Zeitraum** 7 Tage, 30 Tage, 90 Tage, 1 Jahr oder alles
- **Token** gesamt, Eingabe, Ausgabe, Cache-Treffer und Denken (die letzten
  beiden sind Teilmengen und werden nicht doppelt gezählt)
- **Kosten** getrennt nach `cost` (abgerechnet), `opencode.list_cost`
  (Listenpreis) und `opencode.allowance` (Go-Kontingent). Fehlt eine Meldung,
  bleibt der Wert leer; es wird nichts aus einer Preisliste geschätzt.
- **Je Modell** Runden, Token, Anteil und Kosten; das Modell steht seit
  2026-11-07 an der Nachricht, ältere Zeilen fallen auf den Chat zurück.
- **Verlauf** als Tagesreihe (Token oder Kosten) und die zwölf stärksten Chats.

Ausgeblendete und gelöschte Chats zählen mit, weil ihre Aufrufe bezahlt
wurden. Jedes Konto sieht nur seine eigenen Zahlen. Der Endpunkt ist
`GET /api/agent/stats?days=30` (`days=0` heißt alles).

## Rücknahme

Jede schreibende Ausführung legt eine Zeile in `agent_changes` an:

- `before` und `after` der geänderten Felder
- Objekt, Werkzeug, Chat, Nachricht, Benutzer
- rückholbar ja/nein
- Status `applied` oder `reverted`

Rücknahme ist **Vergleich-und-Setzen**: Sie schreibt nur zurück, wenn der
aktuelle Wert noch dem gespeicherten Nachher entspricht. Wurde inzwischen
jemand anders tätig, antwortet der Server mit `409` und einer Erklärung,
statt fremde Arbeit zu überschreiben.

Rücknahme löscht keine Geschichte:

- Bestand: Gegenbuchung als neue `stock_movements`-Zeile
- Preis: neue `price_history`-Zeile „Rücknahme durch Assistent“
- alles: neue `audit_log`-Zeile `agent_revert`

Rückholbar sind auch ganze Schritte: `POST …/messages/{id}/revert` nimmt
alle offenen Änderungen dieser Assistenten-Nachricht in umgekehrter
Reihenfolge zurück.

Nicht rückholbar: Sammellauf. Rechnungen sind bewusst nicht im
Werkzeugkatalog; sie werden fachlich nur per Storno korrigiert.

## API

Alles unter `/api/agent`, Bearer-Token wie im Hauptportal.

```text
GET    /providers
POST   /providers
PUT    /providers/{id}
DELETE /providers/{id}                 (deaktiviert)
POST   /providers/{id}/default
POST   /providers/{id}/test
GET    /providers/{id}/models
POST   /providers/{id}/models/refresh
DELETE /providers/{id}/key

GET    /config
GET    /settings
PUT    /settings
POST   /settings/reset
POST   /settings/websearch/test

GET    /chats
POST   /chats
GET    /stats                         (Modelle, Token, gemeldete Kosten)
GET    /chats/{id}
PATCH  /chats/{id}
DELETE /chats/{id}

POST   /chats/{id}/attachments         (multipart: file)
DELETE /chats/{id}/attachments/{aid}
POST   /chats/{id}/messages            (text/event-stream, attachment_ids)
POST   /chats/{id}/cancel
POST   /chats/{id}/changes/{change_id}/revert
POST   /chats/{id}/messages/{message_id}/revert
POST   /chats/{id}/tools/{name}        (Werkzeug von Hand testen)
POST   /chats/{id}/rewind              (Frage und Folgendes ausblenden)

GET    /prompts                        (eigene, geteilte, Schnellstarts)
POST   /prompts
PUT    /prompts/{id}
DELETE /prompts/{id}
GET    /changes
GET    /tools
GET    /health
```

### SSE-Ereignisse

```text
start         Chat, Nachrichten-ID, Titel, Modell
delta         Textstück
reasoning     Überlegung (nicht gespeichert)
assistant     fertige Assistenten-Nachricht
tool_call     Name, Argumente, schreibt ja/nein
tool_result   ok, Zusammenfassung, Vorschau, Änderungs-ID
error         lesbarer Fehler
done          Schritte, gestoppt ja/nein
```

## Datenmodell

- `agent_providers`: Endpunkt, Modelle, Standardmodell, versiegelter
  Schlüssel, Header, Cache
- `agent_chats`: Eigentümer, Titel, Anbieter, Modell, Schreibmodus,
  Zeitstempel, weiches Löschen
- `agent_settings`: Schlüssel/Wert der Labor-Einstellungen, Urheber und
  Zeitpunkt; Geheimnisse versiegelt
- `agent_messages`: Rolle (`user`, `assistant`, `tool`), Inhalt, Werkzeuge,
  Modell und Anbieter der Runde, Nutzung, Abbruch
- `agent_attachments`: extrahierter Dateitext, Name, Typ, Größe, Seiten,
  Prüfsumme, `meta` (Seitenauswahl, OCR, PDF-Titel); verweist auf Chat und
  Nachricht
- `agent_changes`: Vorher/Nachher, Rücknahmestatus, Audit
- `agent_prompts`: Vorlagen je Konto, Titel, Text (verschlüsselt), geteilt ja/nein

`agent_messages.hidden_at`, `agent_messages.model` und
`agent_messages.provider_id` kamen 2026-11-07 dazu; `seed.ensure_columns`
zieht die Spalten in bestehenden Datenbanken nach.

Chat-Inhalte und Änderungsdaten nutzen die vorhandenen
`EncryptedText`/`EncryptedJSON`-Typen; mit gesetzten `GIMEL_DATA_KEYS` liegen
sie verschlüsselt, ohne Schlüssel wie bisher im Klartext.

## Container-Sandbox (temporäre Arbeitsumgebung)

Der Assistent kann pro Chat eine **isolierte, temporäre Container-Umgebung**
(`/workspace`) anlegen, um Python-Skripte, Datenanalysen, CSV/JSON-Auswertungen,
Simulationen oder HTML/SVG-Ausgaben sicher auszuführen — getrennt vom Host und
von Gimels Produktivdatenbank:

- **Laufzeiten (`agent_sandbox_backend`):** `auto` (Vorgabe: Docker, Rückfall
  auf Bubblewrap/`bwrap`), `docker` oder `bwrap`. Ohne isolierte Laufzeit wird
  nie ungeschützt auf dem Host ausgeführt.
- **Leistungsprofile (`agent_sandbox_profile`):** `standard` (leicht), `heavy`
  (Intensiv: 2 GB RAM, 2 CPUs, 512 MB Workspace, 3 Min. Befehlslimit),
  `extensive` (**Extensiv / Hard Work**: 8 GB RAM, 4 CPUs, 2 GB Workspace,
  1 GB `/tmp` ausführbar, 1024 PIDs, 10 Min. Befehlslimit, Swap-Puffer) oder
  `custom` (RAM bis 32 GB, bis 32 CPUs, bis 16 GB Workspace, bis 1 Std.
  Befehlszeit, optionale NVIDIA-GPU-Durchreichung `--gpus all`).
- **Härtung:** `--cap-drop ALL`, `--security-opt no-new-privileges:true`,
  `--read-only` Root-Dateisystem (Pakete via `PYTHONUSERBASE=/workspace/.local`),
  `--tmpfs /tmp`, konfigurierbares PID-/RAM-/CPU-/Zeitlimit und standardmäßig
  `--network none` (Netzwerk im Container aus).
- **Werkzeuge (`Container & Sandbox`):** `sandbox_create`, `sandbox_exec`,
  `sandbox_run_python`, `sandbox_write_file`, `sandbox_read_file`,
  `sandbox_list_files`, `sandbox_export_artifact` und `sandbox_destroy`.
- **UI-Zugang:** Agent Lab → **Einstellungen → Container-Sandbox**, Portal →
  **Assistent → Einstellungen** sowie Portal → **Admin → Assistent & Sandbox**.

## Grenzen des Labors

- getippte Werkzeuge; beliebige Skripte laufen ausschließlich in der
  isolierten Container-Sandbox (abschaltbar über `agent_sandbox_enabled`,
  im Live-Sprachmodus immer gesperrt)
- keine Freigabe pro Aufruf; Sicherheit kommt aus Schreibschalter,
  Rollenprüfung, Protokoll und Rücknahme
- Netzwerk nur über `web_search`/`fetch_url`; Adressprüfung, private Netze
  gesperrt, kein Proxy-Umweg
- OCR und `pdftotext` sind optionale Systemprogramme; ohne sie bleibt die
  Textebene von `pypdf`
- echte Schreibzugriffe betreffen die **Live-Datenbank**
- SQLite bleibt ein Schreiber; lange Sammelläufe können kurz blockieren
- kein eigener Taktgeber, keine Hintergrundplanung
- Ein Chat gehört genau einem Konto; Admin sieht keine fremden Chats

## Tests

```powershell
python -m pytest agentlab/tests -q
cd agentlab/web; npm run build
```

Die Tests laufen in einem temporären Datenordner und berühren die
Live-Datenbank nicht.

## Übernahme in Gimel

Nach der Abnahme:

1. Tabellen nach `gimel/models.py`
2. Router nach `gimel/routers/agent.py`, Dienste nach
   `gimel/services/agent_*`
3. UI-Komponenten nach `web/src/components/agent`, Seite nach
   `web/src/pages/Agent.tsx`
4. Navigation „Assistenz“, Popup, `Ctrl+Shift+A`
5. „Roboter“ aus der Navigation nehmen
6. Tests nach `tests/app/test_agent.py` und `web/agent.test.mjs`
7. Router in Alefs `app/_moved.py` aufnehmen

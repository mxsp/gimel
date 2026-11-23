import { useEffect, useState } from "react";
import { Button, Classes, FormGroup, InputGroup } from "@blueprintjs/core";
import { api, SessionUser, setSession } from "../api";
import GimelMark from "./GimelMark";

/* Anmeldung für das Team: E-Mail und Passwort, zweiter Faktor, Gimel-PIN.
   Portal und Twin Studio benutzen dieselbe Maske. */

export default function Login({ onLogin, subtitle = "Internes Portal — Anmeldung für das Team" }: {
  onLogin: (u: SessionUser) => void;
  /** Zweite Zeile unter dem Titel; Twin Studio nennt sich dort selbst. */
  subtitle?: string;
}) {
  const [testPinEnabled, setTestPinEnabled] = useState(false);
  const [gimelPinEnabled, setGimelPinEnabled] = useState(false);
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState("");
  useEffect(() => {
    let cancelled = false;
    api<{ test_pin_enabled: boolean; gimel_pin_enabled?: boolean }>("/api/auth/login-options")
      .then(data => {
        if (cancelled) return;
        setTestPinEnabled(data.test_pin_enabled === true);
        setGimelPinEnabled(data.gimel_pin_enabled === true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ticket, setTicket] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ access_token: string; role: string; email: string; name: string; admin_work?: boolean;
        mfa_required?: boolean; mfa_token?: string }>(
        pinMode ? "/api/auth/pin" : ticket ? "/api/auth/2fa" : "/api/auth/login", pinMode
          ? { method: "POST", body: JSON.stringify({ pin }) } : ticket
          ? { method: "POST", body: JSON.stringify({ mfa_token: ticket, code }) }
          : { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ username: email.trim(), password }) });
      if (data.mfa_required) {
        setTicket(data.mfa_token || ""); setPassword(""); return;
      }
      // Nur Personal kommt hier hinein — Kunden bedienen das Bestellportal.
      if (data.role === "customer") {
        setError("Dieses Portal ist für Ihr Team. Kunden bestellen über das Bestellportal.");
        return;
      }
      const user = { email: data.email, name: data.name, role: data.role, adminWork: data.admin_work === true };
      setSession(data.access_token, user);
      onLogin(user);
    } catch (err: any) {
      // api() uebersetzt jede 401 in "Sitzung abgelaufen" — an der Anmeldung
      // heisst 401 aber schlicht: die PIN stimmt nicht.
      setError(err.message ?? "Anmeldung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-stage">
      <form onSubmit={submit} className={Classes.CARD} style={{ width: 360 }}>
        <h1 className="login-title"><GimelMark size={32} /> Gimel</h1>
        <p style={{ color: "var(--g-muted)" }}>{subtitle}</p>
        {pinMode ? <FormGroup label={gimelPinEnabled ? "Gimel-PIN" : "Test-PIN (nur Entwicklung)"} labelFor="test-pin">
          <InputGroup id="test-pin" type="password" inputMode="numeric" autoComplete="off"
            value={pin} required autoFocus onChange={e => setPin(e.target.value)} />
          <p className="sub">{gimelPinEnabled
            ? "Betriebszugang für Aufträge, Fertigung und Versand. Benutzer und Einstellungen nur mit persönlicher Anmeldung."
            : "Testzugang als Administrator ohne Passwort und zweiten Faktor."}</p>
        </FormGroup> : ticket ? <FormGroup label="App-Code oder Wiederherstellungscode" labelFor="code">
          <InputGroup id="code" value={code} required autoFocus autoComplete="one-time-code"
            onChange={e => setCode(e.target.value)} />
          <Button minimal disabled={busy} onClick={() => { setTicket(""); setCode(""); setError(""); }}>
            Anmeldung neu beginnen
          </Button>
        </FormGroup> : <>
          <FormGroup label="E-Mail" labelFor="email"
            helperText="Die Adresse Ihres Kontos.">
            <InputGroup id="email" type="email" value={email} required autoFocus autoComplete="username"
              onChange={e => setEmail(e.target.value)} />
          </FormGroup>
          <FormGroup label="Passwort" labelFor="password">
            <InputGroup id="password" type="password" value={password} required autoComplete="current-password"
              onChange={e => setPassword(e.target.value)} />
          </FormGroup>
        </>}
        {error && <div style={{ color: "var(--g-danger-ink)", marginBottom: 10 }}>{error}</div>}
        <Button type="submit" intent="primary" fill loading={busy} icon="log-in">
          Anmelden
        </Button>
        {(testPinEnabled || gimelPinEnabled) && <Button type="button" minimal fill disabled={busy}
          onClick={() => { setPinMode(!pinMode); setPin(""); setTicket(""); setPassword(""); setCode(""); setError(""); }}>
          {pinMode ? "Mit E-Mail und Passwort anmelden" : gimelPinEnabled ? "Mit Gimel-PIN anmelden" : "Testzugang mit PIN"}
        </Button>}
      </form>
    </div>
  );
}

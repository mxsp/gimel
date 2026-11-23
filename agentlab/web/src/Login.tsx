import { Button, FormGroup, InputGroup } from "@blueprintjs/core";
import { useEffect, useState } from "react";
import { ApiError, login, loginMfa, loginOptions, loginPin, SessionUser } from "./api";
import BotSmiley from "./BotSmiley";

export default function Login({ onLogin, title = "Gimel Agent Lab",
  subtitle = "Assistent für Aufträge, Fertigung und Stammdaten. Anmeldung mit Ihrem Gimel-Konto." }: {
  onLogin: (user: SessionUser) => void;
  title?: string;
  subtitle?: string;
}) {
  const [options, setOptions] = useState({ test: false, gimel: false });
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ticket, setTicket] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loginOptions().then(setOptions).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (ticket) {
        onLogin(await loginMfa(ticket, code));
        return;
      }
      if (pinMode) {
        onLogin(await loginPin(pin));
        return;
      }
      const result = await login(email, password);
      if (result.mfaToken) {
        setTicket(result.mfaToken);
        setPassword("");
        return;
      }
      if (result.user) onLogin(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-stage">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title"><BotSmiley size={31} variant="brand" trackMouse /> {title}</h1>
        <p className="login-sub">{subtitle}</p>
        {ticket ? (
          <FormGroup label="App-Code oder Wiederherstellungscode" labelFor="mfa-code">
            <InputGroup id="mfa-code" autoFocus autoComplete="one-time-code" value={code}
              onChange={(e) => setCode(e.target.value)} />
          </FormGroup>
        ) : pinMode ? (
          <FormGroup label={options.gimel ? "Gimel-PIN" : "Test-PIN"}
            helperText="Betriebszugang. Benutzer und Anbieter bleiben persönlichen Admin-Konten vorbehalten.">
            <InputGroup id="pin" type="password" inputMode="numeric" autoFocus value={pin}
              onChange={(e) => setPin(e.target.value)} />
          </FormGroup>
        ) : (
          <>
            <FormGroup label="E-Mail" labelFor="email">
              <InputGroup id="email" type="email" autoFocus autoComplete="username" value={email}
                onChange={(e) => setEmail(e.target.value)} />
            </FormGroup>
            <FormGroup label="Passwort" labelFor="password">
              <InputGroup id="password" type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} />
            </FormGroup>
          </>
        )}
        {error && <p className="login-error" role="alert">{error}</p>}
        <Button type="submit" intent="primary" fill loading={busy} icon="log-in">
          {ticket ? "Code prüfen" : "Anmelden"}
        </Button>
        {(options.test || options.gimel) && (
          <Button type="button" minimal fill disabled={busy}
            onClick={() => { setPinMode(!pinMode); setPin(""); setTicket(""); setCode(""); setError(""); }}>
            {pinMode ? "Mit E-Mail und Passwort anmelden"
              : options.gimel ? "Mit Gimel-PIN anmelden" : "Testzugang mit PIN"}
          </Button>
        )}
        {ticket && (
          <Button type="button" minimal fill onClick={() => { setTicket(""); setCode(""); setError(""); }}>
            Neu beginnen
          </Button>
        )}
      </form>
    </div>
  );
}

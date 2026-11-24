import { Button, Callout, FormGroup, InputGroup, Tag } from "@blueprintjs/core";
import { useEffect, useState } from "react";
import { accountSetupStatus, ApiError, login, SessionUser, setupFirstAdmin } from "./api";
import BotSmiley from "./BotSmiley";

export default function Login({ onLogin, title = "Gimel Agent Lab",
  subtitle = "Lokale Anmeldung mit Benutzername und Passwort." }: {
  onLogin: (user: SessionUser) => void;
  title?: string;
  subtitle?: string;
}) {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [localnetOnly, setLocalnetOnly] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    accountSetupStatus()
      .then((s) => {
        setNeedsSetup(s.needsSetup);
        setLocalnetOnly(s.localnetOnly);
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    const cleanUser = username.trim();
    if (!cleanUser || !password) {
      setError("Benutzername und Passwort sind erforderlich.");
      return;
    }
    if (needsSetup) {
      if (password.length < 8) {
        setError("Das Passwort braucht mindestens 8 Zeichen.");
        return;
      }
      if (password !== passwordConfirm) {
        setError("Die Passwörter stimmen nicht überein.");
        return;
      }
    }
    setBusy(true);
    try {
      if (needsSetup) {
        onLogin(await setupFirstAdmin(cleanUser, password));
        return;
      }
      const result = await login(cleanUser, password);
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h1 className="login-title" style={{ margin: 0 }}><BotSmiley size={31} variant="brand" character="lab" trackMouse /> {title}</h1>
          {localnetOnly && <Tag minimal icon="shield">Localnet</Tag>}
        </div>
        <p className="login-sub">
          {needsSetup ? "Ersteinrichtung — erstes Admin-Konto anlegen." : subtitle}
        </p>
        {needsSetup && (
          <Callout intent="primary" icon="new-person" style={{ marginBottom: 12 }}>
            Es existiert noch kein Konto. Legen Sie jetzt ein Admin-Konto mit Benutzername und Passwort an.
          </Callout>
        )}
        <FormGroup label="Benutzername" labelFor="lab-username">
          <InputGroup
            id="lab-username"
            type="text"
            autoFocus
            autoComplete="username"
            placeholder={needsSetup ? "z. B. admin" : "Benutzername"}
            value={username}
            required
            onChange={(e) => setUsername(e.target.value)}
          />
        </FormGroup>
        <FormGroup label="Passwort" labelFor="lab-password" helperText={needsSetup ? "Mindestens 8 Zeichen." : undefined}>
          <InputGroup
            id="lab-password"
            type="password"
            autoComplete={needsSetup ? "new-password" : "current-password"}
            value={password}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormGroup>
        {needsSetup && (
          <FormGroup label="Passwort wiederholen" labelFor="lab-password-confirm">
            <InputGroup
              id="lab-password-confirm"
              type="password"
              autoComplete="new-password"
              value={passwordConfirm}
              required
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
          </FormGroup>
        )}
        {error && <p className="login-error" role="alert">{error}</p>}
        <Button type="submit" intent="primary" fill loading={busy} icon={needsSetup ? "new-person" : "log-in"}>
          {needsSetup ? "Admin-Konto anlegen" : "Anmelden"}
        </Button>
      </form>
    </div>
  );
}

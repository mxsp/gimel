import { useEffect, useState } from "react";
import { Button, Callout, Classes, FormGroup, InputGroup, Tag } from "@blueprintjs/core";
import { api, SessionUser, setSession } from "../api";
import GimelMark from "./GimelMark";

/* Anmeldung für das lokale Netz: nur Benutzername und Passwort.
   Bei einer leeren Produktionsdatenbank lässt sich hier direkt das erste
   Admin-Konto (Benutzername + Passwort) anlegen. */

export default function Login({ onLogin, subtitle = "Lokales Portal — Anmeldung mit Benutzername und Passwort" }: {
  onLogin: (u: SessionUser) => void;
  /** Zweite Zeile unter dem Titel; Twin Studio nennt sich dort selbst. */
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
    let cancelled = false;
    api<{ needs_setup?: boolean; localnet_only?: boolean }>("/api/accounts/setup-status")
      .then((data) => {
        if (cancelled) return;
        setNeedsSetup(data.needs_setup === true);
        setLocalnetOnly(data.localnet_only !== false);
      })
      .catch(() => {});
    return () => { cancelled = true; };
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
      const data = needsSetup
        ? await api<{ access_token: string; role: string; email: string; name: string; admin_work?: boolean }>(
            "/api/accounts/setup",
            {
              method: "POST",
              body: JSON.stringify({ username: cleanUser, password }),
            },
          )
        : await api<{ access_token: string; role: string; email: string; name: string; admin_work?: boolean }>(
            "/api/auth/login",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ username: cleanUser, password }),
            },
          );

      if (data.role === "customer") {
        setError("Dieses Konto hat keinen Zugriff auf das interne Portal.");
        return;
      }
      const user: SessionUser = {
        email: data.email,
        name: data.name || data.email,
        role: data.role,
        adminWork: data.admin_work === true,
      };
      setSession(data.access_token, user);
      onLogin(user);
    } catch (err: any) {
      setError(err.message ?? "Anmeldung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-stage">
      <form onSubmit={submit} className={Classes.CARD} style={{ width: 370 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h1 className="login-title" style={{ margin: 0 }}><GimelMark size={30} /> Gimel</h1>
          {localnetOnly && <Tag minimal icon="shield" intent="none">Localnet</Tag>}
        </div>
        <p style={{ color: "var(--g-muted)", marginTop: 8 }}>
          {needsSetup
            ? "Ersteinrichtung — erstes Admin-Konto anlegen"
            : subtitle}
        </p>

        {needsSetup && (
          <Callout intent="primary" icon="new-person" style={{ marginBottom: 12 }}>
            Es existiert noch kein Konto. Legen Sie jetzt einen lokalen Administrator mit Benutzername und Passwort an.
          </Callout>
        )}

        <FormGroup label="Benutzername" labelFor="login-username">
          <InputGroup
            id="login-username"
            type="text"
            placeholder={needsSetup ? "z. B. admin" : "Benutzername"}
            value={username}
            required
            autoFocus
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
        </FormGroup>

        <FormGroup
          label="Passwort"
          labelFor="login-password"
          helperText={needsSetup ? "Mindestens 8 Zeichen." : undefined}
        >
          <InputGroup
            id="login-password"
            type="password"
            value={password}
            required
            autoComplete={needsSetup ? "new-password" : "current-password"}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormGroup>

        {needsSetup && (
          <FormGroup label="Passwort wiederholen" labelFor="login-password-confirm">
            <InputGroup
              id="login-password-confirm"
              type="password"
              value={passwordConfirm}
              required
              autoComplete="new-password"
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
          </FormGroup>
        )}

        {error && <div style={{ color: "var(--g-danger-ink)", marginBottom: 10 }}>{error}</div>}

        <Button type="submit" intent="primary" fill loading={busy} icon={needsSetup ? "new-person" : "log-in"}>
          {needsSetup ? "Admin-Konto anlegen" : "Anmelden"}
        </Button>
      </form>
    </div>
  );
}

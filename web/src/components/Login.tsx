import { useEffect, useState } from "react";
import { Button, Callout, Classes, FormGroup, InputGroup, Tag } from "@blueprintjs/core";
import { api, SessionUser, setSession } from "../api";
import GimelMark from "./GimelMark";

/* Anmeldung für das lokale Netz: nur Benutzername und Passwort.
   Bei einer leeren Datenbank startet automatisch der geführte Erst-Einrichtungs-
   Assistent (Systemstatus, optionaler Betriebsname, erstes Admin-Konto). */

interface SetupStatus {
  needs_setup?: boolean;
  localnet_only?: boolean;
  mode?: string;
  db_backend?: string;
  version?: string;
  lan_urls?: string[];
}

function suggestPassword(): string {
  const words = ["Hobel", "Fraese", "Platte", "Ring", "Werkbank", "Zange", "Laser", "Bohrer"];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  const n = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
  return `${pick()}-${pick()}-${n}`;
}

export default function Login({ onLogin, subtitle = "Lokales Portal — Anmeldung mit Benutzername und Passwort" }: {
  onLogin: (u: SessionUser) => void;
  subtitle?: string;
}) {
  const [setupInfo, setSetupInfo] = useState<SetupStatus>({ needs_setup: false, localnet_only: true });
  const [plantName, setPlantName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<SetupStatus>("/api/accounts/setup-status")
      .then((data) => {
        if (cancelled) return;
        setSetupInfo({
          needs_setup: data.needs_setup === true,
          localnet_only: data.localnet_only !== false,
          mode: data.mode,
          db_backend: data.db_backend,
          version: data.version,
          lan_urls: Array.isArray(data.lan_urls) ? data.lan_urls : [],
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const needsSetup = setupInfo.needs_setup === true;
  const localnetOnly = setupInfo.localnet_only !== false;

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
              body: JSON.stringify({
                username: cleanUser,
                password,
                plant_name: plantName.trim(),
              }),
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
      <form onSubmit={submit} className={Classes.CARD} style={{ width: needsSetup ? 440 : 370, maxWidth: "94vw" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h1 className="login-title" style={{ margin: 0 }}><GimelMark size={30} /> Gimel</h1>
          <div style={{ display: "flex", gap: 6 }}>
            {setupInfo.version && <Tag minimal>v{setupInfo.version}</Tag>}
            {localnetOnly && <Tag minimal icon="shield" intent="success">Localnet</Tag>}
          </div>
        </div>
        <p style={{ color: "var(--g-muted)", marginTop: 8 }}>
          {needsSetup
            ? "Geführte Ersteinrichtung — Betrieb & erstes Admin-Konto anlegen"
            : subtitle}
        </p>

        {needsSetup && (
          <>
            <Callout intent="primary" icon="wrench" style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                <Tag minimal intent="success">DB: {setupInfo.db_backend || "sqlite"}</Tag>
                <Tag minimal intent="primary">Modus: {setupInfo.mode || "production"}</Tag>
                {localnetOnly && <Tag minimal intent="success">Localnet-Schutz aktiv</Tag>}
              </div>
              {setupInfo.lan_urls && setupInfo.lan_urls.length > 0 && (
                <div style={{ fontSize: 12 }}>
                  Im LAN erreichbar unter <code className="mono">{setupInfo.lan_urls[0]}</code>
                </div>
              )}
            </Callout>
            <FormGroup label="Betriebsname (optional)" labelFor="setup-plant-name">
              <InputGroup
                id="setup-plant-name"
                type="text"
                placeholder="z. B. Musterwerk GmbH"
                value={plantName}
                onChange={(e) => setPlantName(e.target.value)}
              />
            </FormGroup>
          </>
        )}

        <FormGroup label={needsSetup ? "Admin-Benutzername" : "Benutzername"} labelFor="login-username">
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
            type={showPw ? "text" : "password"}
            value={password}
            required
            autoComplete={needsSetup ? "new-password" : "current-password"}
            onChange={(e) => setPassword(e.target.value)}
            rightElement={
              needsSetup ? (
                <>
                  <Button
                    minimal
                    icon={showPw ? "eye-off" : "eye-open"}
                    aria-label="Passwort anzeigen"
                    onClick={() => setShowPw(!showPw)}
                  />
                  <Button
                    minimal
                    icon="refresh"
                    title="Passwort vorschlagen"
                    aria-label="Passwort vorschlagen"
                    onClick={() => {
                      const p = suggestPassword();
                      setPassword(p);
                      setPasswordConfirm(p);
                      setShowPw(true);
                    }}
                  />
                </>
              ) : undefined
            }
          />
        </FormGroup>

        {needsSetup && (
          <FormGroup label="Passwort wiederholen" labelFor="login-password-confirm">
            <InputGroup
              id="login-password-confirm"
              type={showPw ? "text" : "password"}
              value={passwordConfirm}
              required
              autoComplete="new-password"
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
          </FormGroup>
        )}

        {error && <div style={{ color: "var(--g-danger-ink)", marginBottom: 10 }}>{error}</div>}

        <Button type="submit" intent="primary" fill loading={busy} icon={needsSetup ? "new-person" : "log-in"}>
          {needsSetup ? "Gimel einrichten & anmelden" : "Anmelden"}
        </Button>
      </form>
    </div>
  );
}

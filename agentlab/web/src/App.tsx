import { useEffect, useState } from "react";
import { api, clearToken, getToken, refreshSession, setToken, SessionUser } from "./api";
import Lab from "./Lab";
import Login from "./Login";

const USER_KEY = "agentlab-user";

function storedUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY) || localStorage.getItem("gimel-user");
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(() => (getToken() ? storedUser() : null));
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const current = getToken();
        if (current) {
          setToken(current);
        } else {
          const ok = await refreshSession();
          if (!ok) return;
        }
        const me = await api<{ email: string; name: string; role: string }>("/api/auth/me");
        if (!active) return;
        if (me.role === "customer") {
          clearToken();
          setUser(null);
          setError("Dieses Portal ist für das Team. Kunden bestellen über das Bestellportal.");
          return;
        }
        const next: SessionUser = {
          email: me.email, name: me.name, role: me.role,
          adminWork: storedUser()?.adminWork === true || me.role === "admin",
        };
        setUser(next);
        localStorage.setItem(USER_KEY, JSON.stringify(next));
      } catch {
        if (!active) return;
        clearToken();
        setUser(null);
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onLogout = () => { setUser(null); localStorage.removeItem(USER_KEY); };
    window.addEventListener("agentlab-logout", onLogout);
    return () => window.removeEventListener("agentlab-logout", onLogout);
  }, []);

  const onLogin = (next: SessionUser) => {
    if (next.role === "customer") {
      clearToken();
      setError("Dieses Portal ist für das Team. Kunden bestellen über das Bestellportal.");
      return;
    }
    localStorage.setItem(USER_KEY, JSON.stringify(next));
    setUser(next);
    setError("");
  };

  if (checking) return <div className="login-stage"><div className="login-card">Anmeldung wird geprüft …</div></div>;
  if (!user) return <><Login onLogin={onLogin} />{error && <div className="login-stage" style={{ minHeight: 0, paddingTop: 0 }}><div className="login-card">{error}</div></div>}</>;
  return <Lab user={user} onLogout={() => { clearToken(); localStorage.removeItem(USER_KEY); setUser(null); }} />;
}

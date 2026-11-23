import { useEffect, useState } from "react";
import { getToken, getUser, resumeSession, SessionUser } from "../api";
import Login from "../components/Login";
import { useVersion } from "../useVersion";
import Studio from "./Studio";

/* Twin Studio: Anmeldung wie im Portal (dieselben Konten, dieselbe PIN),
   danach nur der Zwilling — ohne Seitenleiste, ohne Arbeitsbereiche. */
export default function StudioApp() {
  const [session, setSession] = useState<SessionUser | null>(getUser());
  const [resuming, setResuming] = useState(() => !getUser() || !getToken());
  const version = useVersion();
  const demo = version?.demo === true;

  useEffect(() => {
    if (!resuming) return;
    resumeSession().then((u) => { if (u) setSession(u); }).finally(() => setResuming(false));
  }, [resuming]);
  useEffect(() => {
    const onLogout = () => setSession(null);
    window.addEventListener("gimel-logout", onLogout);
    return () => window.removeEventListener("gimel-logout", onLogout);
  }, []);
  useEffect(() => { document.title = demo ? "Twin Studio · Gimel Demo" : "Twin Studio · Gimel"; }, [demo]);

  if (resuming) return null;
  if (!session || !getToken()) {
    return (
      <div className="login-page studio-login">
        {demo && <div className="demo-banner" role="note">DEMO – Musterwerk GmbH, keine echten Daten</div>}
        <Login subtitle="Twin Studio — der digitale Zwilling" onLogin={(u) => setSession(u)} />
      </div>
    );
  }
  return <Studio user={session} demo={demo} agent={version?.agent === true} onLogout={() => setSession(null)} />;
}

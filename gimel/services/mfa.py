"""Der zweite Faktor am Konto — Einrichten, Prüfen, Abschalten.

Die Rechnerei steht in ``services/totp.py``, die Ablage in
``services/secretbox.py``. Hier steht die *Politik*: wie oft darf geraten
werden, was passiert bei Erfolg, was bei einem Wiederherstellungscode, und
welche Sitzungen überleben eine Änderung. Diese Fragen an einer Stelle zu
halten ist der ganze Zweck der Datei — verteilt über zwei Router wären sie
zweimal beantwortet und einmal falsch.

Vier Regeln, jede mit einem Grund:

* **Raten ist teurer als Wissen.** Sechs Stellen sind eine Million
  Möglichkeiten; bei zehn Versuchen pro Viertelstunde wäre ein Konto in
  dreißig Jahren geknackt, bei unbegrenzten Versuchen in einer Stunde. Der
  Zähler ist deshalb kein Beiwerk, sondern das, was den Faktor trägt.
* **Ein Code gilt einmal.** ``totp_last_slot`` am Konto, gesetzt bei jedem
  Erfolg — auch beim Einrichten, sonst schaltet derselbe Code erst ein und
  meldet dann an.
* **Wiederherstellungscodes sind Passwörter.** bcrypt, einzeln entwertet,
  einmal angezeigt. Wer sie im Klartext ablegt, hat 2FA gegen einen
  Datenbankdiebstahl abgeschafft und es nicht gemerkt.
* **Jede Änderung am zweiten Faktor wirft die anderen Sitzungen hinaus.**
  Wer 2FA einschaltet, tut das meistens, weil er sich Sorgen macht; eine
  fremde Sitzung, die daneben weiterläuft, macht die Übung sinnlos.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..models import AuditLog, AuthSession, RecoveryCode, User
from ..security import hash_password, verify_password
from . import identity, secretbox, totp

#: Fehlversuche am zweiten Faktor, bevor gesperrt wird. Kleiner als bei der
#: Passwortsperre (5) wäre unhöflich — wer hier tippt, hat das Passwort
#: bereits richtig gehabt und ist mit hoher Wahrscheinlichkeit der Inhaber
#: mit einer schief gehenden Uhr.
MAX_MFA_FAILED = 5
MFA_LOCKOUT_MINUTES = 15

#: Meldung für einen Code aus einer bereits verbrauchten Zeitscheibe.
REPLAYED = "Dieser Code wurde gerade benutzt — bitte den nächsten abwarten"

#: Aussteller im Authenticator. Steht hier, weil er in der QR-URI *und* in der
#: Anzeige auftaucht und zwei Schreibweisen zwei Einträge in der App ergäben.

def issuer() -> str:
    """So heißt der Eintrag in der Authenticator-App."""
    return identity.texts().manufacturer_short or "Gimel"



def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# Zustand
# --------------------------------------------------------------------------
def is_enabled(user: User) -> bool:
    return bool(user.totp_enabled and user.totp_secret_enc)


def secret_of(user: User) -> str:
    return secretbox.open_(user.totp_secret_enc or "")


def locked_for(user: User, now: datetime | None = None) -> int:
    """Verbleibende Sperrsekunden am zweiten Faktor, 0 = offen."""
    until = _aware(user.mfa_locked_until)
    if not until:
        return 0
    delta = (until - (now or datetime.now(timezone.utc))).total_seconds()
    return max(0, int(delta))


def unused_recovery_count(db: Session, user: User) -> int:
    return (db.query(RecoveryCode)
              .filter(RecoveryCode.user_id == user.id, RecoveryCode.used_at.is_(None))
              .count())


# --------------------------------------------------------------------------
# Einrichten
# --------------------------------------------------------------------------
def begin_setup(db: Session, user: User) -> dict:
    """Ein frisches Geheimnis erzeugen und ablegen — aber noch nicht scharf.

    ``totp_enabled`` bleibt aus, bis der Kunde einen Code aus seiner App
    vorgelegt hat. Sonst reicht ein abgebrochener Einrichtungsversuch, um sich
    selbst auszusperren: Geheimnis am Konto, nichts im Telefon.

    Ein zweiter Aufruf überschreibt das unbestätigte Geheimnis. Das ist
    gewollt — wer die Seite neu lädt, soll einen frischen QR bekommen und
    nicht einen, den er schon halb abgescannt hat.
    """
    if is_enabled(user):
        raise ValueError("Der zweite Faktor ist bereits eingeschaltet.")
    secret = totp.new_secret()
    user.totp_secret_enc = secretbox.seal(secret)
    user.totp_enabled = False
    user.totp_confirmed_at = None
    db.commit()
    return {
        "secret": secret,
        "secret_grouped": totp.grouped(secret),
        "uri": totp.provisioning_uri(secret, account=user.email, issuer=issuer()),
        "digits": totp.DIGITS,
        "period": totp.PERIOD,
        "issuer": issuer(),
    }


def confirm_setup(db: Session, user: User, code: str,
                  keep_session: int | None = None) -> list[str]:
    """Den Code aus der App prüfen, einschalten, Wiederherstellungscodes geben.

    Der Rückgabewert ist die einzige Gelegenheit, die Codes zu sehen — danach
    liegen nur noch Hashes. Deshalb sind sie der Rückgabewert und nicht ein
    Nebeneffekt: eine Funktion, deren wichtigstes Ergebnis man ignorieren
    kann, wird ignoriert.

    ``keep_session`` ist die laufende Sitzung des Kunden. Ohne sie wirft das
    Einschalten **auch ihn selbst** hinaus — er sieht seine
    Wiederherstellungscodes noch, und beim nächsten Seitenwechsel ist er
    abgemeldet. Wer 2FA einschaltet, soll die anderen Geräte verlieren, nicht
    das, an dem er gerade sitzt.
    """
    if locked_for(user):
        raise ValueError("Zu viele falsche Codes — bitte später erneut versuchen.")
    secret = secret_of(user)
    if not secret:
        raise ValueError("Kein Geheimnis hinterlegt — Einrichtung neu starten.")
    used = totp.verify(secret, code, last_slot=user.totp_last_slot or None)
    if used is None:
        note_failure(db, user)
        raise ValueError("Der Code stimmt nicht. Stimmt die Uhrzeit im Telefon?")
    user.totp_enabled = True
    user.totp_confirmed_at = datetime.now(timezone.utc)
    user.totp_last_slot = used
    user.mfa_failed_count = 0
    user.mfa_locked_until = None
    codes = _issue_recovery(db, user)
    revoke_other_sessions(db, user, keep_id=keep_session)
    db.add(AuditLog(actor=user.email, action="mfa_enable", entity="user",
                    entity_id=str(user.id)))
    db.commit()
    return codes


def disable(db: Session, user: User, keep_session: int | None = None) -> None:
    """Abschalten. Geheimnis und Codes verschwinden mit."""
    user.totp_secret_enc = ""
    user.totp_enabled = False
    user.totp_confirmed_at = None
    user.totp_last_slot = 0
    user.mfa_failed_count = 0
    user.mfa_locked_until = None
    db.query(RecoveryCode).filter(RecoveryCode.user_id == user.id).delete()
    revoke_other_sessions(db, user, keep_id=keep_session)
    db.add(AuditLog(actor=user.email, action="mfa_disable", entity="user",
                    entity_id=str(user.id)))
    db.commit()


# --------------------------------------------------------------------------
# Prüfen
# --------------------------------------------------------------------------
def note_failure(db: Session, user: User) -> None:
    """Fehlversuch zählen und ab der Grenze sperren."""
    user.mfa_failed_count = (user.mfa_failed_count or 0) + 1
    if user.mfa_failed_count >= MAX_MFA_FAILED:
        user.mfa_locked_until = (datetime.now(timezone.utc)
                                 + timedelta(minutes=MFA_LOCKOUT_MINUTES))
    db.commit()


def check(db: Session, user: User, code: str) -> str:
    """Einen Code prüfen — TOTP oder Wiederherstellung.

    Gibt zurück, *womit* die Prüfung gelungen ist (``"totp"`` /
    ``"recovery"``), weil das im Protokoll und in der Antwort einen
    Unterschied macht: ein verbrauchter Wiederherstellungscode ist ein Anlass,
    dem Kunden zu sagen, wie viele er noch hat.

    Wirft ``PermissionError`` bei Sperre und ``ValueError`` bei falschem Code —
    zwei verschiedene Zustände, die der Aufrufer verschieden beantworten muss
    (423 gegen 401).
    """
    left = locked_for(user)
    if left:
        raise PermissionError(str(left))

    secret = secret_of(user)
    if secret:
        used = totp.verify(secret, code, last_slot=user.totp_last_slot or None)
        if used is not None:
            user.totp_last_slot = used
            user.mfa_failed_count = 0
            user.mfa_locked_until = None
            db.commit()
            return "totp"

    # Erst danach die Wiederherstellungscodes: sie sind die Ausnahme, nicht
    # der Normalfall, und jeder Versuch kostet einen bcrypt-Vergleich je Code.
    norm = totp.normalize_recovery(code)
    if len(norm) == totp.RECOVERY_GROUPS * totp.RECOVERY_GROUP_LEN:
        rows = (db.query(RecoveryCode)
                  .filter(RecoveryCode.user_id == user.id,
                          RecoveryCode.used_at.is_(None))
                  .all())
        for row in rows:
            if verify_password(norm, row.code_hash):
                row.used_at = datetime.now(timezone.utc)
                user.mfa_failed_count = 0
                user.mfa_locked_until = None
                db.add(AuditLog(actor=user.email, action="mfa_recovery_used",
                                entity="user", entity_id=str(user.id),
                                detail={"left": len(rows) - 1}))
                db.commit()
                return "recovery"

    note_failure(db, user)
    # Derselbe Code ein zweites Mal (Doppelklick, zweiter Tab, Passwortwechsel
    # direkt nach der Anmeldung): weiter abgelehnt und gezählt, aber mit einem
    # Satz, der sagt, was zu tun ist.
    if secret and totp.replayed(secret, code, last_slot=user.totp_last_slot or None):
        raise ValueError(REPLAYED)
    raise ValueError("Der Code stimmt nicht.")


# --------------------------------------------------------------------------
# Wiederherstellungscodes
# --------------------------------------------------------------------------
def _issue_recovery(db: Session, user: User) -> list[str]:
    db.query(RecoveryCode).filter(RecoveryCode.user_id == user.id).delete()
    codes = [totp.new_recovery_code() for _ in range(totp.RECOVERY_COUNT)]
    for c in codes:
        db.add(RecoveryCode(user_id=user.id,
                            code_hash=hash_password(totp.normalize_recovery(c))))
    db.flush()
    return codes


def regenerate_recovery(db: Session, user: User,
                        keep_session: int | None = None) -> list[str]:
    """Neue Codes; die alten gelten ab sofort nicht mehr.

    Nur mit gültigem zweitem Faktor aufrufbar (der Router prüft das) — sonst
    wäre es ein Weg, sich mit einem gestohlenen Passwort neue Ausweise
    auszustellen.
    """
    codes = _issue_recovery(db, user)
    revoke_other_sessions(db, user, keep_id=keep_session)
    db.add(AuditLog(actor=user.email, action="mfa_recovery_regenerate",
                    entity="user", entity_id=str(user.id)))
    db.commit()
    return codes


# --------------------------------------------------------------------------
# Sitzungen
# --------------------------------------------------------------------------
def revoke_other_sessions(db: Session, user: User, keep_id: int | None = None) -> int:
    """Alle Sitzungen bis auf die eigene beenden.

    Gerufen beim Einschalten des zweiten Faktors, beim Passwortwechsel und
    beim E-Mail-Wechsel: das sind genau die drei Momente, in denen jemand
    seine Zugangsdaten für kompromittiert hält.

    ``keep_id`` ist die Sitzungskennung aus dem Zugangstoken (``sid``, siehe
    security.create_access_token) und **nicht** der Refresh-Cookie: der liegt
    auf ``path=/api/auth`` und ist unter ``/api/account/…`` gar nicht da.
    """
    q = (db.query(AuthSession)
           .filter(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None)))
    if keep_id:
        q = q.filter(AuthSession.id != keep_id)
    n = q.update({"revoked_at": datetime.now(timezone.utc)},
                 synchronize_session=False)
    return int(n or 0)


#: Wie lange eine beendete Sitzung (abgelaufen oder widerrufen) samt IP und
#: Browserkennung noch für die Sicherheitsübersicht stehen bleibt. Danach wird
#: sie gelöscht — die Datenschutzerklärung nennt diese Frist.
SESSION_LOG_DAYS = 30


def purge_stale_sessions(db: Session, now: datetime | None = None) -> int:
    """Beendete Sitzungen nach ``SESSION_LOG_DAYS`` löschen (Art. 5 Abs. 1
    lit. e DSGVO). Gerufen beim Start und bei jeder neuen Anmeldung — wie
    ``mailer.purge_expired_contacts`` an der Naht statt in einem stillen
    Nachtdienst."""
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=SESSION_LOG_DAYS)
    n = (db.query(AuthSession)
           .filter((AuthSession.expires_at < cutoff)
                   | (AuthSession.revoked_at.isnot(None) & (AuthSession.revoked_at < cutoff)))
           .delete(synchronize_session=False))
    if n:
        db.commit()
    return int(n or 0)


def sessions_of(db: Session, user: User, current_id: int | None = None) -> list[dict]:
    """Die offenen Sitzungen für die Kontoseite.

    Ohne diese Liste ist „mein Konto wurde übernommen" eine Vermutung. Mit ihr
    ist es eine Zeile mit Ort, Gerät und Zeitpunkt — und einem Knopf daneben.
    """
    rows = (db.query(AuthSession)
              .filter(AuthSession.user_id == user.id,
                      AuthSession.revoked_at.is_(None))
              .order_by(AuthSession.created_at.desc())
              .limit(50).all())
    now = datetime.now(timezone.utc)
    out = []
    for s in rows:
        exp = _aware(s.expires_at)
        if exp and exp < now:
            continue
        out.append({
            "id": s.id,
            "created_at": (_aware(s.created_at) or now).isoformat(),
            "expires_at": exp.isoformat() if exp else None,
            "ip": s.ip or "",
            "user_agent": s.user_agent or "",
            "current": bool(current_id and s.id == current_id),
        })
    return out

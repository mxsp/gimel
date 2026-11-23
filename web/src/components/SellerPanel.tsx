import { useEffect, useState } from "react";
import { Button, Callout, Card, FormGroup, InputGroup, Switch } from "@blueprintjs/core";
import { api } from "../api";
import { toastError, toastSuccess } from "../toast";

/* Verkäuferdaten für lokale Rechnungen. Nur für Admins und nur ohne Anwendung:
   unter einer Anwendung bringt das Plugin diese Angaben mit. */

interface Seller {
  values: Record<string, string>; editable: boolean; env_locked: string[];
  complete: boolean; problem: string;
}

const FIELDS: [string, string][] = [
  ["name", "Firma"], ["street", "Straße"], ["zip", "PLZ"], ["city", "Ort"], ["country", "Land"],
  ["vatId", "USt-IdNr."], ["taxNumber", "Steuernummer"], ["email", "E-Mail"], ["website", "Website"],
  ["register", "Register, z. B. Amtsgericht Köln, HRB 12345"], ["managers", "Geschäftsführung"],
  ["partners", "Gesellschafter"], ["iban", "IBAN"], ["bic", "BIC"], ["bank", "Bank"],
];

export default function SellerPanel() {
  const [seller, setSeller] = useState<Seller | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Seller>("/api/invoicing/seller")
      .then((s) => { setSeller(s); setValues(s.values); })
      .catch(() => setSeller(null));  // 403 für Nicht-Admins: dann gibt es hier nichts zu pflegen
  }, []);

  if (!seller?.editable) return null;

  const save = async () => {
    setBusy(true);
    try {
      const s = await api<Seller>("/api/invoicing/seller", { method: "PUT", body: JSON.stringify(values) });
      setSeller(s); setValues(s.values);
      toastSuccess("Verkäuferdaten gespeichert.");
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card style={{ marginBottom: 14 }}>
      <h2 className="section-title" style={{ marginTop: 0 }}>Verkäuferdaten</h2>
      {seller.problem && <Callout intent="warning" title={seller.problem} style={{ marginBottom: 12 }} />}
      <div className="seller-grid">
        {FIELDS.map(([key, label]) => (
          <FormGroup key={key} label={label} labelFor={`seller-${key}`}>
            <InputGroup id={`seller-${key}`} value={values[key] ?? ""} disabled={seller.env_locked.includes(key)}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
          </FormGroup>
        ))}
      </div>
      <Switch checked={values.smallBusiness === "1"}
              label="Kleinunternehmer nach § 19 UStG (Gimel stellt dann keine Rechnungen aus, weil es immer Umsatzsteuer ausweist)"
              onChange={() => setValues({ ...values, smallBusiness: values.smallBusiness === "1" ? "" : "1" })} />
      <Button intent="primary" text="Speichern" loading={busy} onClick={save} />
    </Card>
  );
}

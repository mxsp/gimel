import { DETAIL_LABEL, Detail, useDetail } from "./detail";

const OPTIONS: Detail[] = ["einfach", "alles"];

/* Der Schalter oben rechts: Einfach zeigt das Nötige, Alles den ganzen Bildschirm.
   Zwei Knöpfe mit aria-pressed, damit Vorleser den Zustand nennen. */
export default function DetailSwitch() {
  const { detail, setDetail } = useDetail();
  return (
    <div className="ui-detail-switch" role="group" aria-label="Detailstufe"
         title="Einfach: nur das Nötige, der Rest hinter „Mehr anzeigen“. Alles: jeder Bildschirm vollständig.">
      {OPTIONS.map((value) => (
        <button key={value} type="button" className="ui-detail-option" aria-pressed={detail === value}
          onClick={() => setDetail(value)}>
          {DETAIL_LABEL[value]}
        </button>
      ))}
    </div>
  );
}

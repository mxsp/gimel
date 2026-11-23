/* Läuft vor dem ersten Anstrich (der Server erlaubt nur Skripte von sich selbst,
   darum eine Datei und kein Inline-Skript). Setzt nur data-theme, damit die
   Farben der Tokens von Anfang an stimmen; theme.ts übernimmt danach. */
(function () {
  try {
    var m = localStorage.getItem("gimel-theme");
    var dark = m === "dark" || (m !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (e) { /* ohne Speicher gilt das System, wie bisher */ }
})();

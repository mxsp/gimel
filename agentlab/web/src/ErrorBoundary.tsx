import { Button } from "@blueprintjs/core";
import { Component, ErrorInfo, ReactNode } from "react";

/* Fängt einen Fehler in einer Ansicht ab, statt die ganze Oberfläche leer zu
   lassen. Der Zurücksetzen-Knopf reicht für die meisten Fälle; „Neu laden“
   bleibt für einen kaputten Build oder eine alte Datei im Browser. */
export default class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Agent Lab Ansicht fehlgeschlagen:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="lab-crash" role="alert">
        <h2>{this.props.label || "Diese Ansicht"} konnte nicht geladen werden</h2>
        <p>
          Die Sitzung bleibt bestehen. Meistens genügt ein neuer Versuch; wenn der Build
          gerade ersetzt wurde, lädt die Seite die geänderte Datei erst mit „Neu laden“.
        </p>
        <pre>{this.state.error.message}</pre>
        <div className="lab-crash-actions">
          <Button text="Erneut versuchen" onClick={() => this.setState({ error: null })} />
          <Button intent="primary" icon="refresh" text="Neu laden" onClick={() => window.location.reload()} />
        </div>
      </div>
    );
  }
}

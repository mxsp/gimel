/* Zentrale Feature-Registrierung für interne Portal-Module.
   Module & Apps UI ist vorerst ausgeblendet; neue interne Features können
   jederzeit hier über registerFeature(...) eingehängt werden. */

let initialized = false;

export function registerCoreFeatures(): void {
  if (initialized) return;
  initialized = true;
}

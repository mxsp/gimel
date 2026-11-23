/* Der 7-Achs-Arm wohnt bei den 3D-Bausteinen des Zwillings, weil ihn beide
   Seiten benutzen: die Sortierzelle (mit IK und Animation) und der Grundriss
   (als statisches Modell eines Roboters mit kind="arm"). Hier nur die gleiche
   Schnittstelle weiterreichen, damit die Zelle bei ihrem Import bleibt. */

export * from "../../twin/arm7";

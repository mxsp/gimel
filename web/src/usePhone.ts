import { useEffect, useState } from "react";

/** Dieselbe Grenze wie im Leitstand: bis 720 Pixel gilt die Telefonansicht. */
const PHONE = "(max-width: 720px)";

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const media = window.matchMedia(PHONE);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Laedt die Server-Komponenten der Seite periodisch neu. Fuer laufende
 * Kampagnen: die Warteschlange soll sich mitbewegen, ohne dass der Nutzer
 * F5 drueckt. Bewusst per router.refresh() statt location.reload(), damit
 * Scrollposition und Formularzustand erhalten bleiben.
 */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    const ms = Math.max(5, seconds) * 1000;
    const id = setInterval(() => {
      // Im Hintergrundtab nicht pollen.
      if (document.visibilityState === "visible") router.refresh();
    }, ms);
    return () => clearInterval(id);
  }, [router, seconds]);

  return null;
}

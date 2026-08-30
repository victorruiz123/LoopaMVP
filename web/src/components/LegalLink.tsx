import type { ReactNode } from "react";
import { LEGAL_TITLES, legalHref, type LegalDoc } from "../lib/legal";
import { useT } from "../lib/i18n";

/**
 * Länken till en juridisk sida, varhelst den står.
 *
 * Alltid ny flik, och alltid `rel="noopener"`. Skälet till fliken står i lib/legal.ts: den som läser
 * villkoren mitt i säljflödet får inte förlora sina filmade bildrutor på vägen dit.
 */
export default function LegalLink({
  doc,
  className,
  children,
}: {
  doc: LegalDoc;
  className?: string;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <a className={className ?? "legal-link"} href={legalHref(doc)} target="_blank" rel="noopener noreferrer">
      {children ?? t(LEGAL_TITLES[doc])}
    </a>
  );
}

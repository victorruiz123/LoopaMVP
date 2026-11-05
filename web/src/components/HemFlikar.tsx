import { useT } from "../lib/i18n";

/** Adressen till Om oss. Läses av App för vägvalet och av flikarna för att veta vilken som är vald. */
export const OM_OSS_PATH = "/om-oss";

export function isOmOssPath(pathname: string): boolean {
  const clean = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return clean === OM_OSS_PATH;
}

/** Byter adress utan omladdning. App lyssnar på popstate, samma väg som butikens router tar. */
export function gaTill(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

/**
 * Startsidans två flikar: säljflödet och Om oss.
 *
 * Två och inte fler — topplisten ska fortfarande läsas som avsändare och konto, och flikarna är
 * bara vägen mellan de två sidor som hör till roten.
 */
export default function HemFlikar({ aktiv }: { aktiv: "salj" | "om-oss" }) {
  const t = useT();
  const flikar = [
    { id: "salj" as const, href: "/", label: t("Sälj") },
    { id: "om-oss" as const, href: OM_OSS_PATH, label: t("Om oss") },
  ];
  return (
    <nav className="hem-flikar" aria-label={t("Sidor")}>
      {flikar.map((f) => (
        <a
          key={f.id}
          href={f.href}
          className={`hem-flik ${aktiv === f.id ? "hem-flik-aktiv" : ""}`}
          aria-current={aktiv === f.id ? "page" : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            gaTill(f.href);
          }}
        >
          {f.label}
        </a>
      ))}
    </nav>
  );
}

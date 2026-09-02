import { useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../auth/AuthProvider";
import { track } from "./Bits";

/**
 * "Lägg en bevakning" — arket som fångar upp ett tomt sökresultat.
 *
 * Står i varje tomt läge, och det är dess viktigaste plats: ett tomt rutnät är butikens sämsta
 * ögonblick, och det enda som kan göras av det är att veta vad personen letade efter. Fälten är
 * därför förifyllda från sökningen de just gjorde — de ska inte behöva beskriva den igen.
 */
export default function BevakningSheet({
  categorySlug,
  brand,
  onClose,
}: {
  categorySlug?: string | null;
  brand?: string | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [maxPris, setMaxPris] = useState("");
  const [maxBredd, setMaxBredd] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError("Logga in först, så kopplar vi bevakningen till ditt konto.");
        setSaving(false);
        return;
      }
      const res = await fetch("/api/butik/bevakningar", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          kategori: categorySlug ?? null,
          marke: brand ?? null,
          maxpris: maxPris ? Number(maxPris) : null,
          maxbredd: maxBredd ? Number(maxBredd) : null,
        }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Kunde inte spara.");
      track("bevakning_created", { category: categorySlug, brand, max_price: maxPris || null });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte spara bevakningen.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="butik-sheet-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Lägg en bevakning">
      <div className="butik-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="butik-sheet-grip" />
        {done ? (
          <>
            <h3>Bevakningen är sparad</h3>
            <p style={{ color: "var(--muted)", lineHeight: 1.5 }}>
              Vi hör av oss så fort en möbel som matchar dyker upp. Du kan ta bort bevakningen när som helst.
            </p>
            <div className="butik-sheet-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>Klart</button>
            </div>
          </>
        ) : (
          <>
            <h3>Bevaka det du letar efter</h3>
            <p style={{ color: "var(--muted)", lineHeight: 1.5, margin: "0 0 4px" }}>
              Vi hör av oss när en Loopa-granskad möbel som matchar kommer in.
            </p>

            {(categorySlug || brand) && (
              <div className="butik-field">
                <span className="butik-field-label">Bevakar</span>
                <div className="butik-field-row">
                  {categorySlug && <span className="butik-chip butik-chip-on">{categorySlug.replace(/-/g, " & ")}</span>}
                  {brand && <span className="butik-chip butik-chip-on">{brand}</span>}
                </div>
              </div>
            )}

            <div className="butik-field">
              <span className="butik-field-label">Högsta pris (kr)</span>
              <input className="butik-input" style={{ width: "100%" }} type="number" inputMode="numeric" placeholder="T.ex. 4000" value={maxPris} onChange={(e) => setMaxPris(e.target.value)} />
            </div>

            <div className="butik-field">
              <span className="butik-field-label">Största bredd (cm)</span>
              <input className="butik-input" style={{ width: "100%" }} type="number" inputMode="numeric" placeholder="T.ex. 210" value={maxBredd} onChange={(e) => setMaxBredd(e.target.value)} />
              <p className="butik-toggle-hint" style={{ marginTop: 6 }}>
                Vi hör bara av oss om möbler vi mätt upp — så måttet är ett löfte, inte en gissning.
              </p>
            </div>

            {error && <p style={{ color: "var(--danger-dark)", lineHeight: 1.5 }}>{error}</p>}
            {!user && <p className="butik-toggle-hint">Du behöver ett konto för att vi ska veta vart vi hör av oss.</p>}

            <div className="butik-sheet-actions">
              <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={onClose}>Avbryt</button>
              <button type="button" className="btn btn-primary" style={{ flex: 2 }} disabled={saving} onClick={save}>
                {saving ? "Sparar…" : "Bevaka"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

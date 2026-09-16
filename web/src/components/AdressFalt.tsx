import { useEffect, useId, useRef, useState } from "react";
import { adressDetalj, adressForslag, type AdressForslag, type AdressTraff } from "../api";
import { useT } from "../lib/i18n";

/**
 * Gatuadressen, med förslag medan man skriver.
 *
 * Ett tryck på ett förslag fyller i gatan, postnumret och orten. Det är postnumret det handlar om:
 * det är det fält folk inte kan utantill, och det är det leveranszonen räknas på.
 *
 * FÄLTET ÄR FORTFARANDE ETT FÄLT. Förslagen är en genväg och aldrig en grind — den som inte hittar
 * sin adress, eller sitter på en server utan nyckel, skriver som förut, och det som står i fältet är
 * det som sparas. Därför fyller ett val bara i det Google faktiskt har och lämnar resten orört.
 *
 * Listan öppnas bara av att man SKRIVER. Efter ett val, eller när orten ändras längre ned, ska den
 * inte dyka upp igen under ett fält man redan lämnat.
 */

function nySession(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // randomUUID finns bara i en säker kontext. Token är ingen hemlighet, bara en fakturanyckel.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export default function AdressFalt({
  id,
  value,
  ort,
  onChange,
  onValj,
}: {
  id: string;
  value: string;
  /** Orten om den redan är ifylld — gör "Storgatan 12" entydig. */
  ort: string;
  onChange: (value: string) => void;
  onValj: (traff: AdressTraff) => void;
}) {
  const t = useT();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const session = useRef(nySession());
  /** Räknare så att ett sent svar på en gammal bokstav inte skriver över ett nyare. */
  const senaste = useRef(0);
  const skrevs = useRef(false);
  const [forslag, setForslag] = useState<AdressForslag[]>([]);
  const [oppen, setOppen] = useState(false);
  const [markerad, setMarkerad] = useState(-1);

  useEffect(() => {
    if (!skrevs.current) return;
    const q = value.trim();
    const nr = ++senaste.current;
    if (q.length < 4) {
      setForslag([]);
      setOppen(false);
      return;
    }
    const timer = setTimeout(async () => {
      const svar = await adressForslag(q, ort.trim(), session.current);
      if (nr !== senaste.current) return;
      setForslag(svar);
      setMarkerad(-1);
      setOppen(svar.length > 0 && document.activeElement === input.current);
    }, 250);
    return () => clearTimeout(timer);
  }, [value, ort]);

  async function valj(f: AdressForslag) {
    skrevs.current = false;
    senaste.current++;
    setOppen(false);
    setForslag([]);
    onChange(f.huvud);
    try {
      onValj(await adressDetalj(f.id, session.current));
    } catch {
      // Gatan står redan i fältet. Postnummer och ort får skrivas för hand, som förut.
    } finally {
      session.current = nySession();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!oppen || forslag.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMarkerad((m) => (m + 1) % forslag.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMarkerad((m) => (m <= 0 ? forslag.length - 1 : m - 1));
    } else if (e.key === "Enter" && markerad >= 0) {
      // Annars skickar Enter hela registreringen mitt i ett val.
      e.preventDefault();
      void valj(forslag[markerad]);
    } else if (e.key === "Escape") {
      setOppen(false);
    }
  }

  return (
    <span className="auth-input-wrap auth-input-plain">
      <input
        id={id}
        ref={input}
        value={value}
        onChange={(e) => {
          skrevs.current = true;
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => forslag.length > 0 && setOppen(true)}
        onBlur={() => setOppen(false)}
        required
        autoComplete="address-line1"
        placeholder={t("t.ex. Storgatan 12")}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={oppen}
        aria-controls={listId}
        aria-activedescendant={oppen && markerad >= 0 ? `${listId}-${markerad}` : undefined}
      />
      {oppen && (
        <ul id={listId} role="listbox" className="adress-forslag" aria-label={t("Adressförslag")}>
          {forslag.map((f, i) => (
            <li
              key={f.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === markerad}
              className={i === markerad ? "markerad" : undefined}
              // mousedown och inte click: fältet tappar fokus före click, och då är listan redan borta.
              onMouseDown={(e) => {
                e.preventDefault();
                void valj(f);
              }}
            >
              <span className="adress-forslag-huvud">{f.huvud}</span>
              {f.rest && <span className="adress-forslag-rest">{f.rest}</span>}
            </li>
          ))}
          {/* Googles villkor kräver att källan står utskriven när Places-data visas utan karta. */}
          <li className="adress-forslag-kalla" aria-hidden="true">
            Google Maps
          </li>
        </ul>
      )}
    </span>
  );
}

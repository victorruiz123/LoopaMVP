import { useEffect, useState } from "react";
import { hamtaRobotHalsa, korRobotHalsa } from "../api";
import { useT } from "../lib/i18n";
import type { RobotHalsaSvar, RobotUtfall } from "../types";

const NAMN = { blocket: "Blocket", tradera: "Tradera", facebook: "Facebook" } as const;
const ETIKETT: Record<RobotUtfall, string> = { ok: "OK", varning: "Varning", fel: "Fel", av: "Av" };
const RANG: Record<RobotUtfall, number> = { av: 0, ok: 1, varning: 2, fel: 3 };

/**
 * Robotarnas dagliga hälsokontroll (server/src/robotHalsa.ts): Blocket, Tradera och Facebook, en
 * gång om dagen klockan sju.
 *
 * SENASTE RAPPORTEN FÖRST, felen överst i varje kort. Fliken öppnas för att svara på "fungerar
 * robotarna?", och det svaret ska stå innan man läser något. Remsan under är en månad bakåt — ett fel
 * som kommer och går syns där och inte i en enskild rapport.
 */
export default function AdminRobotHalsaScreen() {
  const t = useT();
  const [data, setData] = useState<RobotHalsaSvar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kor, setKor] = useState(false);

  useEffect(() => {
    hamtaRobotHalsa()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Kunde inte hämta rapporten."));
  }, []);

  async function korNu() {
    setKor(true);
    setError(null);
    try {
      setData(await korRobotHalsa());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kontrollen misslyckades.");
    } finally {
      setKor(false);
    }
  }

  const r = data?.senaste ?? null;

  return (
    <div className="admin-flik">
      <p className="admin-lede">
        {r ? `${t("Senast kontrollerad")} ${nar(r.kordAt)} · ${r.sekunder} s` : t("Ingen kontroll har körts ännu")}
        {" · "}
        {t("körs varje dag kl. 07")}
      </p>
      {error && <p className="public-card-error">{error}</p>}

      <div className="admin-verktyg">
        <button className="btn btn-small" onClick={korNu} disabled={kor || data?.pagar}>
          {kor || data?.pagar ? t("Kontrollerar… (några minuter)") : t("Kontrollera nu")}
        </button>
      </div>

      {r && (
        <div className="robothalsa-kort">
          {r.robotar.map((robot) => (
            <section key={robot.robot} className={`robothalsa-robot robothalsa-${robot.utfall}`}>
              <h3>
                {NAMN[robot.robot]} <span className={`robothalsa-bricka robothalsa-${robot.utfall}`}>{ETIKETT[robot.utfall]}</span>
              </h3>
              <ul>
                {[...robot.kontroller]
                  .sort((a, b) => RANG[b.utfall] - RANG[a.utfall])
                  .map((k) => (
                    <li key={k.namn} className={`robothalsa-${k.utfall}`}>
                      <span className={`robothalsa-prick robothalsa-${k.utfall}`} aria-label={ETIKETT[k.utfall]} />
                      <span>
                        <strong>{k.namn}</strong> {k.text}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {data && data.historik.length > 1 && (
        <div className="robothalsa-historik">
          <p className="admin-note">{t("Senaste {antal} kontrollerna", { antal: data.historik.length })}</p>
          <div className="robothalsa-remsa">
            {data.historik.map((h) => (
              <span
                key={h.kordAt}
                className={`robothalsa-prick robothalsa-${h.utfall}`}
                title={`${nar(h.kordAt)}: ${h.robotar.map((b) => `${NAMN[b.robot]} ${ETIKETT[b.utfall]}`).join(", ")}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function nar(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

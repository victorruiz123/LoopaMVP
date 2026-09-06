import { useEffect, useState } from "react";
import { andra, fornya, minaEfterlysningar, taBort, type Efterlysning } from "../api";
import { useAuth } from "../../auth/AuthProvider";
import AuthScreen from "../../screens/AuthScreen";
import Inkorg from "../components/Inkorg";

/**
 * Mina efterlysningar: pausa, ändra, förnya, ta bort.
 *
 * PULSENS SIFFROR STÅR PÅ VARJE RAD, och de är verkliga. "Vi har läst igenom 214 objekt åt dig" är
 * hämtat ur efterlysningens egen räknare (se recordSweep) och inte ur en uppskattning. En rad utan
 * träffar ska ändå kunna visa att någon letat — det är skillnaden mellan en bevakning som arbetar
 * och en som glömts bort.
 */
export default function MinaEfterlysningar() {
  const { user, loading } = useAuth();
  const [rader, setRader] = useState<Array<{ efterlysning: Efterlysning; traffar: number }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const ladda = () => {
    minaEfterlysningar().then((r) => setRader(r.efterlysningar)).catch(() => setRader([]));
  };
  useEffect(() => { if (user) ladda(); }, [user]);

  if (loading) return <div className="butik-skeleton" style={{ height: 200 }} />;
  if (!user) {
    // Vägen ut går till butiken. Landningssidan som låg på /kop är borttagen.
    return <AuthScreen inbaddad
        intent="account" onBack={() => { window.location.href = "/butik"; }} onDone={() => ladda()} />;
  }

  const agera = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try { await fn(); ladda(); } finally { setBusy(null); }
  };

  return (
    <div className="kop-mina">
      <header className="kop-mina-head">
        <h1>Dina efterlysningar</h1>
        <p>Vi letar åt dig tills du säger stopp — eller tills de somnar efter 90 dagar.</p>
      </header>

      {/* Notiserna först: det är dem man kommer hit för när man klickat på ett brev. */}
      <Inkorg />

      {rader === null && <div className="butik-skeleton" style={{ height: 120 }} />}

      {rader?.length === 0 && (
        <div className="kop-mina-tom">
          <p>Du har inga efterlysningar än.</p>
          {/*
            Vägen till en NY efterlysning går genom butiken sedan landningssidan togs bort: söker man
            efter något vi inte har möter det tomma rutnätet en med "lägg en bevakning", förifylld med
            det man just sökte på (butik/components/BevakningSheet.tsx). Det är samma efterlysning,
            fångad där den faktiskt uppstår — i stunden då lagret inte räckte.
          */}
          <button type="button" className="kop-spec-go" onClick={() => { window.location.href = "/butik"; }}>
            Sök i butiken
          </button>
        </div>
      )}

      <ul className="kop-mina-lista">
        {(rader ?? []).map(({ efterlysning: e, traffar }) => {
          const dagarKvar = Math.ceil((new Date(e.expiresAt).getTime() - Date.now()) / 86_400_000);
          const somnar = dagarKvar <= 14;
          return (
            <li key={e.id} className={`kop-mina-rad${e.state !== "active" ? " kop-mina-vilande" : ""}`}>
              <div className="kop-mina-body">
                <h3>{e.summary}</h3>
                <p className="kop-mina-status">
                  {e.state === "active" ? "Bevakas nu" : e.state === "paused" ? "Pausad" : e.state === "fulfilled" ? "Uppfylld" : "Somnad"}
                  {" · "}
                  {/* Verkliga tal ur efterlysningens egen räknare. */}
                  {e.scannedCount > 0
                    ? `${e.scannedCount.toLocaleString("sv-SE")} objekt genomlästa`
                    : "inget genomläst än"}
                  {traffar > 0 ? ` · ${traffar} ${traffar === 1 ? "träff" : "träffar"}` : ""}
                </p>
                {e.state === "active" && somnar && (
                  <p className="kop-mina-somnar">
                    Somnar om {dagarKvar} {dagarKvar === 1 ? "dag" : "dagar"}.
                    <button type="button" onClick={() => void agera(e.id, () => fornya(e.id))}>Förnya 90 dagar</button>
                  </p>
                )}
              </div>
              <div className="kop-mina-knappar">
                {e.state === "active" ? (
                  <button type="button" disabled={busy === e.id} onClick={() => void agera(e.id, () => andra(e.id, { state: "paused" }))}>
                    Pausa
                  </button>
                ) : (
                  <button type="button" disabled={busy === e.id} onClick={() => void agera(e.id, () => andra(e.id, { state: "active" }))}>
                    Återuppta
                  </button>
                )}
                <button type="button" className="kop-mina-bort" disabled={busy === e.id} onClick={() => void agera(e.id, () => taBort(e.id))}>
                  Ta bort
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

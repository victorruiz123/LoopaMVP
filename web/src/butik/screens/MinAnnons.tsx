import { useEffect, useState } from "react";
import { deleteJob, getJob } from "../../api";
import { useAuth } from "../../auth/AuthProvider";
import ListingScreen from "../../screens/ListingScreen";
import type { ConditionJob } from "../../types";
import { navigate } from "../router";
import { useT } from "../../lib/i18n";

/**
 * Säljarens egen annons, öppnad ur profilen.
 *
 * SAMMA SKÄRM SOM SÄLJVERKTYGETS KORT (screens/ListingScreen.tsx), precis som profilen är samma skärm
 * på båda ingångarna. Möbeln är densamma och annonsen är densamma; det enda som skiljer är vad
 * knapparna runt omkring gör. En egen butiksvariant hade börjat glida isär från säljarens kort samma
 * vecka någon lade till en rad i den ena.
 *
 * VARFÖR INTE PRODUKTSIDAN. Profilen skickade förut hit-klicket till /butik/objekt/… för möbler som
 * låg i butiken och till det publika kortet för resten. Båda är KÖPARENS vy: de svarar på "vad är
 * det här för möbel", medan säljaren som trycker på sin egen rad frågar "hur går det med min annons,
 * och hur tar jag bort den". Den senare frågan hade inget svar någonstans.
 *
 * TILLBAKA GÅR TILL MINA ANNONSER och ingen annanstans. Kortet nås härifrån bara via profilen, så
 * det finns inget tvivel om vad som ligger bakom — och "tillbaka till skicket", som säljflödet
 * skriver, pekar på en skärm man aldrig var på.
 */
export default function MinAnnons({ jobId }: { jobId: string }) {
  const t = useT();
  const { user, loading } = useAuth();
  const [job, setJob] = useState<ConditionJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    let avbruten = false;
    getJob(jobId)
      .then((j) => {
        if (!avbruten) setJob(j);
      })
      .catch((err) => {
        if (!avbruten) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      avbruten = true;
    };
  }, [jobId, loading, user]);

  const tillProfilen = () => navigate({ name: "profile" });

  /**
   * Utan konto finns ingen annons att visa: servern svarar 404 på någon annans jobb, med flit (se
   * ägargrinden i server.ts). Vi skickar därför vidare till profilen, som ÄR stället inloggningen
   * hör hemma — att rita en inloggning här hade lovat att just det här kortet väntar bakom den,
   * vilket det bara gör för ägaren.
   *
   * I en effekt och inte i renderingen: en navigering mitt i en rendering byter adress medan React
   * räknar ut vad som ska stå på den.
   */
  useEffect(() => {
    if (!loading && !user) navigate({ name: "profile" }, { replace: true });
  }, [loading, user]);

  if (loading || !user) return <div className="butik-page"><div className="butik-skeleton" style={{ height: 200 }} /></div>;

  if (error) {
    return (
      <div className="butik-page">
        <section className="card-panel">
          <h2 className="card-title">{t("Annonsen kunde inte hämtas")}</h2>
          <p className="muted small">{error}</p>
          <button className="btn btn-primary" onClick={tillProfilen}>{t("Till mina annonser")}</button>
        </section>
      </div>
    );
  }

  if (!job) return <div className="butik-page"><div className="butik-skeleton" style={{ height: 320 }} /></div>;

  /**
   * Ett jobb utan resultat har ingen annons att visa — besiktningen föll eller pågår. Borttagningen
   * ska ändå finnas: det är just de raderna säljaren vill städa bort ur sin lista, och den som inte
   * kan ta bort ett misslyckat försök har en profil som bara växer.
   */
  if (!job.result) {
    return <UtanAnnons job={job} onDone={tillProfilen} />;
  }

  return (
    <ListingScreen
      result={job.result}
      loopaId={job.loopaId}
      onBack={tillProfilen}
      backLabel={t("Tillbaka till mina annonser")}
      // Butiken har ingen startsida i säljverktygets mening. Profilen är det närmaste "hem" den som
      // står i sin egen annons har.
      onHome={tillProfilen}
      onMyListings={tillProfilen}
      onDeleted={tillProfilen}
    />
  );
}

/**
 * Raden som aldrig blev en annons: besiktningen föll, eller den står kvar mitt i.
 *
 * Egen liten vy och inte ListingScreen: den vill ha ett `ConditionResult`, och det är just det som
 * saknas. Här står varför det inte finns något kort, och den enda handling som är möjlig.
 */
function UtanAnnons({ job, onDone }: { job: ConditionJob; onDone: () => void }) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await deleteJob(job.id);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
      setConfirm(false);
    }
  }

  return (
    <div className="butik-page">
      <section className="card-panel">
        <div className="card-kicker">{t("Annons")}</div>
        <h2 className="card-title">{t("Det blev ingen annons av den här")}</h2>
        <p className="muted small">{job.error ?? job.progress.message}</p>
        {error && <p className="sell-error">{error}</p>}
        <div className="card-delete-row">
          {confirm ? (
            <>
              <button className="btn btn-danger" onClick={() => void remove()} disabled={deleting}>
                {deleting ? t("Tar bort…") : t("Ja, ta bort")}
              </button>
              <button className="btn btn-text" onClick={() => setConfirm(false)} disabled={deleting}>
                {t("Avbryt")}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={onDone}>{t("Till mina annonser")}</button>
              <button className="btn btn-text card-delete-link" onClick={() => setConfirm(true)}>
                {t("Ta bort")}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ensureMediaSession } from "../../api";
import AuthScreen from "../../screens/AuthScreen";
import ProfileScreen from "../../screens/ProfileScreen";
import { harStegBakat, navigate } from "../router";
import { publicCardPath } from "../../lib/loopaId";

/**
 * Vägen ut ur profilen: TILLBAKA DIT MAN KOM IFRÅN.
 *
 * Profilen nås ur toppraden, och toppraden står på båda sidor av produkten — butiken, en annons, ett
 * sökresultat, säljstartsidan. Det finns alltså ingen enskild sida som ÄR "bakom" profilen; det finns
 * bara den man stod på. En knapp med en fast destination gissar, och gissar fel varannan gång: den
 * som satt i en annons och tittade på sitt konto hamnade i en katalog över hela lagret.
 *
 * Historiken vet svaret, och `history.back()` är därför inte en genväg här utan själva innebörden.
 *
 * FALLBACKEN finns för fliken som öppnats DIREKT på /butik/profil — en bokmärkt adress, en delad
 * länk. Där är steget bakåt någon annans sida eller ingen alls, och att kasta ut folk ur appen är
 * inte att gå tillbaka. `harStegBakat` skiljer de två fallen åt (se butik/router.ts). Butiken är
 * valet för att det är den sidan toppradens ordmärke pekar på.
 */
const UTAN_HISTORIK = "/butik";

function tillbaka() {
  if (harStegBakat()) window.history.back();
  else navigate(UTAN_HISTORIK);
}

/**
 * Butikens profilsida — SAMMA skärm som säljverktygets.
 *
 * Inte en kopia och inte en butiksvariant: `ProfileScreen` renderas rakt av. Den som säljer en soffa
 * och köper ett matbord ska se samma sida oavsett vilken ingång de kom in genom, och två skärmar med
 * samma syfte hade genast börjat glida isär — en ny statistikruta i den ena, en ny lista i den andra.
 *
 * Det ENDA som skiljer är vad knapparna runt omkring gör, och det är precis vad skärmens props är
 * till för: ett annonskort öppnas på sin publika adress, eftersom butiken inte har säljverktygets
 * kortvy.
 *
 * "Tillbaka" är den andra skillnaden, och den har ingen destination alls — se `tillbaka` ovan.
 * Knappen pekade tidigare på `{ name: "search", q: "" }`, alltså hela lagret, oavsett var man kom
 * ifrån. Vem som än tryckte hamnade i en katalog över allt vi har.
 */
export default function ButikProfile() {
  const { user, loading } = useAuth();

  /**
   * Adminrollen, hämtad på nytt här.
   *
   * Skärmen är densamma som säljverktygets profil, men PROPSEN är den här sidans. Säljverktyget
   * skickade `isAdmin` och `onOpenAdmin`; butiken skickade ingetdera, och adminingången försvann
   * därför helt för den som gick in via köpsidans profil — vilket är den enda vägen dit numera.
   *
   * Rollen avgörs av servern på adressen Supabase bekräftat (se admin.ts). Det här är bara beskedet
   * om huruvida ingången ska ritas; varje adminväg prövar rollen igen på sin egen sida.
   */
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!user) return;
    void ensureMediaSession()
      .then((s) => setIsAdmin(s.isAdmin))
      .catch((err) => {
        /**
         * ETT UTEBLIVET SVAR ÄR INTE ETT NEJ.
         *
         * Ingången kan inte ritas utan besked — men en tyst `catch` gjorde en nedlagd server, en
         * utgången token och "du står inte i adminlistan" till exakt samma sak på skärmen, och det
         * var precis det som gjorde en saknad adminpanel omöjlig att förklara. Felet loggas därför
         * med samma ord som säljverktyget använder (App.tsx), så att de två vägarna in i samma
         * skärm också felsöks likadant.
         */
        console.warn("[loopa] bildsession:", err);
        setIsAdmin(false);
      });
  }, [user]);

  if (loading) {
    return (
      <div className="butik-page">
        <div className="butik-skeleton" style={{ height: 200 }} />
      </div>
    );
  }

  // Profilen är personlig hela vägen — det finns ingenting att visa för den som inte är inloggad.
  if (!user) {
    return <AuthScreen inbaddad
        intent="account" onBack={tillbaka} onDone={() => undefined} />;
  }

  return (
    <ProfileScreen
      isAdmin={isAdmin}
      /**
       * Adminpanelen bor i säljverktyget, som medvetet saknar router — skärmen väljs i tillstånd och
       * har ingen egen adress. En frågeparameter är den minsta vägen dit som inte kräver en router,
       * och den läses en gång vid start precis som `?affar=` redan gör.
       */
      onOpenAdmin={() => { window.location.href = "/?admin=1"; }}
      onBack={tillbaka}
      /* Säljverktygets kortvy finns inte här. Det publika kortet gör det, och det är samma möbel —
         möbeln som ligger i butiken nås dessutom på sin butiksadress, som är den köparen ser. */
      onOpenJob={(job) => {
        if (job.shop) navigate({ name: "product", id: job.loopaId });
        else window.location.href = publicCardPath(job.loopaId);
      }}
    />
  );
}

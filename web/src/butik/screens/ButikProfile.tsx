import { useAuth } from "../../auth/AuthProvider";
import AuthScreen from "../../screens/AuthScreen";
import ProfileScreen from "../../screens/ProfileScreen";
import { navigate } from "../router";
import { publicCardPath } from "../../lib/loopaId";

/**
 * Butikens profilsida — SAMMA skärm som säljverktygets.
 *
 * Inte en kopia och inte en butiksvariant: `ProfileScreen` renderas rakt av. Den som säljer en soffa
 * och köper ett matbord ska se samma sida oavsett vilken ingång de kom in genom, och två skärmar med
 * samma syfte hade genast börjat glida isär — en ny statistikruta i den ena, en ny lista i den andra.
 *
 * Det ENDA som skiljer är vad knapparna runt omkring gör, och det är precis vad skärmens props är
 * till för: "Tillbaka" går till butiken i stället för till säljflödets startsida, och ett annonskort
 * öppnas på sin publika adress eftersom butiken inte har säljverktygets kortvy.
 */
export default function ButikProfile() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="butik-page">
        <div className="butik-skeleton" style={{ height: 200 }} />
      </div>
    );
  }

  // Profilen är personlig hela vägen — det finns ingenting att visa för den som inte är inloggad.
  if (!user) {
    return <AuthScreen intent="account" onBack={() => navigate({ name: "landing" })} onDone={() => undefined} />;
  }

  return (
    <ProfileScreen
      onBack={() => navigate({ name: "landing" })}
      /* Säljverktygets kortvy finns inte här. Det publika kortet gör det, och det är samma möbel —
         möbeln som ligger i butiken nås dessutom på sin butiksadress, som är den köparen ser. */
      onOpenJob={(job) => {
        if (job.shop) navigate({ name: "product", id: job.loopaId });
        else window.location.href = publicCardPath(job.loopaId);
      }}
    />
  );
}

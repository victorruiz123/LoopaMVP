import type { Profile } from "../auth/AuthProvider";
import { UserIcon } from "./icons";

/**
 * Vem som är inloggad, som en rund bricka.
 *
 * EN REGEL, TVÅ TOPPLISTER. Butiken och säljflödet ritade tidigare den här brickan var för sig —
 * butiken med bild eller initial, säljflödet med en generisk gubbe oavsett vem som var inloggad. Det
 * är samma användare på samma konto, och den som lagt en profilbild ska se den på båda ställena.
 * Regeln bor därför här och storleken hos den som ritar.
 *
 * TRAPPAN NEDÅT, i den ordningen:
 *
 *   1. PROFILBILDEN, när användaren har valt en. Den kommer ur `avatar_url` på profilen, satt vid
 *      inloggning med Google.
 *   2. INITIALEN. Ett tecken ur namnet, användarnamnet eller adressen. Redan det säger "det är DU
 *      som är inne" på ett sätt en ikon aldrig gör.
 *   3. IKONEN, och bara när ingen är inloggad. En gubbe betyder då just det den ser ut att betyda:
 *      här finns ett konto, men inte ditt.
 *
 * Att steg 3 är reserverat för utloggat läge är hela poängen. En generisk gubbe på en inloggad
 * användare säger varken "du är inne" eller "du är ute" — den säger ingenting, på den enda plats i
 * gränssnittet som ska svara på frågan.
 */
export default function Avatar({
  profile,
  email,
  inloggad,
  size = 20,
}: {
  profile: Profile | null;
  email: string | null | undefined;
  /** Falskt ger ikonen. Skilt från `profile`, som kan saknas en stund efter en lyckad inloggning. */
  inloggad: boolean;
  /** Ikonens storlek i pixlar. Bilden och initialen fyller brickan och styrs av dess CSS. */
  size?: number;
}) {
  if (!inloggad) return <UserIcon size={size} />;

  if (profile?.avatar_url) {
    /**
     * `alt=""` med flit: brickan är en knapp som redan bär sitt eget `aria-label` ("Din profil"), och
     * en bild som dessutom heter något upprepar knappens namn för den som lyssnar sig igenom sidan.
     */
    return <img src={profile.avatar_url} alt="" referrerPolicy="no-referrer" />;
  }

  return <span aria-hidden="true">{initial(profile?.full_name || profile?.username || email)}</span>;
}

/**
 * Första bokstaven, versal. Tom sträng när det inte finns någon — brickan visar då bara sin färg,
 * vilket är ärligare än ett frågetecken eller en punkt.
 *
 * `trimStart` före uppslaget: ett namn som börjar med ett mellanslag hade annars gett en tom bricka
 * åt någon som faktiskt har ett namn.
 */
function initial(name: string | null | undefined): string {
  return (name ?? "").trimStart().charAt(0).toUpperCase();
}

import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import AuthScreen from "../../screens/AuthScreen";
import { track } from "../../butik/components/Bits";

/**
 * Frågan om att logga in, innan man kollar en länk eller börjar bläddra.
 *
 * EN FRÅGA, INTE EN MUR. Den som redan är inloggad ser den aldrig; den som inte är det får den och
 * kan svara. Skillnaden mot en hård grind är att sidan bakom fortfarande FINNS — den är
 * server-renderad, den indexeras, och en delad länk till en möbel öppnar möbeln. Att låsa in det
 * hade kostat både sökbarheten och den som klickat sig hit från en kompis.
 *
 * VARFÖR FRÅGA ALLS: det som händer efter länken — analys, inbjudan, betalning, leverans — kräver
 * ett konto ändå, och att fråga när avsikten är som starkast är vänligare än att fråga tre steg
 * senare när någon redan lagt tid på det.
 *
 * Öppnas av ett fönsterhändelse så att toppradens "Logga in" och sidans knappar kan be om samma sak
 * utan att känna till varandra.
 */
export default function LoggaInGrind() {
  const { user } = useAuth();
  const [visa, setVisa] = useState(false);
  const [efterat, setEfterat] = useState<null | (() => void)>(null);

  useEffect(() => {
    const öppna = (e: Event) => {
      const detalj = (e as CustomEvent<{ anledning?: string; sedan?: () => void }>).detail ?? {};
      track("logga_in_fraga", { anledning: detalj.anledning ?? "okand" });
      setEfterat(() => detalj.sedan ?? null);
      setVisa(true);
    };
    window.addEventListener("loopa:logga-in", öppna);
    return () => window.removeEventListener("loopa:logga-in", öppna);
  }, []);

  if (!visa || user) return null;

  return (
    <div className="grind" role="dialog" aria-modal="true" aria-label="Logga in">
      <div className="grind-ruta">
        <AuthScreen
          inbaddad
        intent="account"
          initialTab="signup"
          onDone={() => { setVisa(false); efterat?.(); }}
          onBack={() => setVisa(false)}
        />
      </div>
    </div>
  );
}

/**
 * Ber om inloggning, och kör vidare efteråt.
 *
 * Returnerar sant när användaren redan är inne — då ska anroparen fortsätta direkt. Falskt betyder
 * att frågan är ställd och att `sedan` körs när den besvarats.
 */
export function fragaOmInloggning(inloggad: boolean, anledning: string, sedan: () => void): boolean {
  if (inloggad) return true;
  window.dispatchEvent(new CustomEvent("loopa:logga-in", { detail: { anledning, sedan } }));
  return false;
}

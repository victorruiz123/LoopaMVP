import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

/**
 * Inloggningen, med samma mekanik som vips-buy-sell-hub.
 *
 * Ordningen i useEffect är inte godtycklig och kopierad med flit: lyssnaren sätts FÖRST och
 * getSession körs efteråt. Tvärtom kan en inloggning som redan ligger i localStorage hinna avfyras
 * innan lyssnaren finns, och appen startar utloggad trots en giltig session.
 */

/** Profilen ur `profiles` — samma tabell och samma kolumner som Vips fyller vid registreringen. */
export interface Profile {
  user_id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  email: string | null;
}

/**
 * Var kontoinnehavaren bor — dit möbler hämtas och levereras. Krävs när ett konto skapas här.
 *
 * Ligger i användarens `user_metadata` och inte i `profiles`: tabellen delas med Vips och ägs av
 * dess registrering, och en kolumn där hade varit en schemaändring i någon annans databas. Konton
 * som skapats i Vips saknar adressen, så den som läser måste tåla null.
 */
export interface Adress {
  gatuadress: string;
  /** Fem siffror, utan mellanslag. */
  postnummer: string;
  ort: string;
  boende: "hus" | "lagenhet";
  portkod: string | null;
  /** Bara för lägenhet. */
  vaning: string | null;
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  /** Adressen på kontot, eller null för konton som skapades utan den. */
  adress: Adress | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: unknown }>;
  signUp: (email: string, password: string, adress: Adress) => Promise<{ error: unknown }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Adressen som väntar på att skrivas till ett nyskapat konto.
 *
 * `updateUser` kräver en session, och sessionen finns först efter inloggningen som följer på
 * registreringen — då har grinden ofta redan släppt och skärmen som samlade in adressen är borta.
 * Därför skrivs den härifrån, där lyssnaren lever kvar. I localStorage så att den också överlever
 * ett konto som måste bekräftas via mejl innan det går att logga in.
 */
const VANTANDE_ADRESS_KEY = "loopa_vantande_adress";

function lasVantande(): { email: string; adress: Adress } | null {
  try {
    const raw = localStorage.getItem(VANTANDE_ADRESS_KEY);
    return raw ? (JSON.parse(raw) as { email: string; adress: Adress }) : null;
  } catch {
    return null;
  }
}

function skrivVantande(value: { email: string; adress: Adress } | null) {
  try {
    if (value) localStorage.setItem(VANTANDE_ADRESS_KEY, JSON.stringify(value));
    else localStorage.removeItem(VANTANDE_ADRESS_KEY);
  } catch {
    // Privat läge: minnesreferensen i providern bär adressen resten av besöket.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const lastLoadedProfileFor = useRef<string | null>(null);
  const vantande = useRef(lasVantande());
  const skriverAdress = useRef(false);

  /** Skriver en väntande adress till kontot den skrevs in för. Misslyckas den ligger den kvar till nästa session. */
  const fullfoljAdress = useCallback(async (u: User) => {
    const pending = vantande.current;
    if (!pending || skriverAdress.current) return;
    if (pending.email.trim().toLowerCase() !== (u.email ?? "").toLowerCase()) return;
    skriverAdress.current = true;
    try {
      const { error } = await supabase.auth.updateUser({ data: { adress: pending.adress } });
      if (!error) {
        vantande.current = null;
        skrivVantande(null);
      }
    } finally {
      skriverAdress.current = false;
    }
  }, []);

  const loadProfile = useCallback(async (userId: string) => {
    if (lastLoadedProfileFor.current === userId) return;
    lastLoadedProfileFor.current = userId;
    const { data } = await supabase
      .from("profiles")
      .select("user_id, username, full_name, avatar_url, email")
      .eq("user_id", userId)
      .maybeSingle();
    setProfile((data as Profile | null) ?? null);
  }, []);

  useEffect(() => {
    // Lyssnaren först.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setUser(next?.user ?? null);
      setLoading(false);
      if (next?.user) {
        void loadProfile(next.user.id);
        // Utanför återanropet: supabase-js håller ett lås medan det körs, och ett auth-anrop härifrån
        // väntar på samma lås.
        const u = next.user;
        setTimeout(() => void fullfoljAdress(u), 0);
      } else {
        setProfile(null);
        lastLoadedProfileFor.current = null;
      }
    });

    // Sedan den befintliga sessionen.
    void supabase.auth.getSession().then(({ data: { session: existing } }) => {
      setSession(existing);
      setUser(existing?.user ?? null);
      setLoading(false);
      if (existing?.user) {
        void loadProfile(existing.user.id);
        void fullfoljAdress(existing.user);
      }
    });

    // En besiktning tar minuter och telefonen kan ligga i fickan under tiden. Token förnyas i
    // förväg så att ingen del av flödet plötsligt får 401 mitt i en körning.
    const refresh = setInterval(async () => {
      const {
        data: { session: current },
      } = await supabase.auth.getSession();
      const expiresAt = current?.expires_at;
      if (expiresAt && expiresAt * 1000 - Date.now() < 5 * 60 * 1000) {
        await supabase.auth.refreshSession();
      }
    }, 60 * 1000);

    return () => {
      subscription.unsubscribe();
      clearInterval(refresh);
    };
  }, [loadProfile, fullfoljAdress]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  };

  /**
   * Registreringen går via Vips egen edge-funktion `handle-signup`, precis som i vips-buy-sell-hub:
   * det är den som skapar profilraden och känner igen en e-post som redan finns.
   *
   * Två sorters fel, och de får inte behandlas lika. "E-posten finns redan" är ett SVAR och ska nå
   * säljaren ordagrant — annars körs Supabases egen signUp på en adress som redan har ett konto, den
   * svarar med en tom framgång, och skärmen säger "kontot är skapat" om ett konto som inte skapades.
   * Att funktionen är onåbar är däremot inget svar, och då är den vanliga signUp rätt reservväg.
   *
   * Adressen läggs som väntande FÖRE anropet och skrivs till kontot när sessionen finns — se
   * `VANTANDE_ADRESS_KEY`. Vips funktion känner inte till den, så den kan inte bära den själv.
   */
  const signUp = async (email: string, password: string, adress: Adress) => {
    const pending = { email, adress };
    vantande.current = pending;
    skrivVantande(pending);
    const { error } = await registrera(email, password, adress);
    if (error) {
      // Inget konto skapades — adressen får inte hamna på ett befintligt konto med samma e-post.
      vantande.current = null;
      skrivVantande(null);
    }
    return { error };
  };

  const registrera = async (email: string, password: string, adress: Adress) => {
    try {
      const { error } = await supabase.functions.invoke("handle-signup", {
        body: { email, password, redirectUrl: `${window.location.origin}/` },
      });
      if (!error) return { error: null };
      const detail = await readFunctionError(error);
      if (detail) return { error: new Error(detail) };
    } catch {
      // Funktionen svarade inte alls — faller tillbaka på Supabases egen registrering nedan.
    }
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/`, data: { email_confirm: true, adress } },
    });
    return { error };
  };

  const adress = (user?.user_metadata?.adress as Adress | undefined) ?? null;

  const signOut = async () => {
    try {
      await supabase.auth.signOut({ scope: "global" });
    } catch {
      // Lokalt tillstånd rensas ändå — annars sitter en trasig session kvar i appen.
    } finally {
      setSession(null);
      setUser(null);
      setProfile(null);
      lastLoadedProfileFor.current = null;
    }
  };

  return (
    <AuthContext.Provider value={{ user, session, profile, adress, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Meddelandet ur en edge-funktion som svarade med fel status.
 *
 * `error.message` är generisk ("non-2xx status code") — det som säger något står i svarskroppen.
 * Returnerar null när felet inte bär något att visa, och anropet får falla tillbaka.
 */
async function readFunctionError(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown }).context;
  if (!(context instanceof Response)) return null;
  try {
    const body = (await context.clone().json()) as {
      error?: string;
      userFriendlyMessage?: string;
      message?: string;
    };
    return body.userFriendlyMessage ?? body.error ?? body.message ?? null;
  } catch {
    return null;
  }
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

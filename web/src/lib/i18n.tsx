import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { TRANSLATIONS } from "./translations";

/**
 * Appens språk: svenska, engelska, franska.
 *
 * NYCKELN ÄR DEN SVENSKA TEXTEN. `t("Vi säljer den åt dig")` slår upp den svenska meningen i
 * ordlistan och lämnar tillbaka den engelska eller franska. Alternativet — symboliska nycklar som
 * `home.step3` — hade tömt komponenterna på det enda ställe där texten faktiskt går att läsa, och
 * den här kodbasen förklarar sina formuleringar i kommentarer bredvid dem. Med svenskan kvar i
 * koden står resonemanget och texten fortfarande på samma sida.
 *
 * Det ger också ett uppförande som håller under arbete: en mening som ännu inte är översatt visas
 * PÅ SVENSKA i stället för att bli en tom ruta eller en nyckel. Ett halvöversatt gränssnitt är
 * fult men användbart; ett med `home.step3` mitt i en mening är varken.
 *
 * Språket ligger i localStorage och läses innan första bildrutan målas, så ingen hinner se svenska
 * blinka förbi på väg till engelskan.
 */
export type Lang = "sv" | "en" | "fr";

/** Ordningen är den de står i väljaren: hemspråket först, sedan de två andra i storleksordning. */
export const LANGS: Array<{ code: Lang; label: string; short: string }> = [
  { code: "sv", label: "Svenska", short: "SV" },
  { code: "en", label: "English", short: "EN" },
  { code: "fr", label: "Français", short: "FR" },
];

const STORAGE_KEY = "loopa_lang";

export type Vars = Record<string, string | number>;

function isLang(value: unknown): value is Lang {
  return value === "sv" || value === "en" || value === "fr";
}

/**
 * Vad appen ska öppnas på.
 *
 * Sparat val först, annars webbläsarens språk — den som har sin telefon på franska ska inte behöva
 * hitta väljaren för att förstå startsidan. Allt annat än de tre blir svenska.
 */
function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // Privat läge eller blockerade kakor: valet går inte att spara, men appen ska fungera ändå.
  }
  const preferred = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  for (const tag of preferred) {
    const code = tag?.slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return "sv";
}

/**
 * Språket UTANFÖR React.
 *
 * En del text bor i vanliga funktioner — feldiagnoser, etikettlistor, sidtitlar — och de kan inte
 * anropa en hook. De läser den här i stället. Provider håller den i takt med tillståndet, så de
 * två kan inte glida isär: språkbytet skriver hit FÖRST och renderar sedan om.
 */
let current: Lang = "sv";

export function currentLang(): Lang {
  return current;
}

/**
 * Fyller i {namn} med värden. Saknas ett värde står platshållaren kvar — synligt, inte tyst.
 *
 * Mönstret matchar allt utom klammer och mellanslag, inte `\w`: JavaScripts `\w` är ASCII, och
 * {företag} och {märke} gick därför rakt igenom oersatta. Felet syns bara på de platshållare som
 * råkar ha en svensk bokstav i sig, vilket är precis den sortens fel som lever länge.
 */
function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{([^{}\s]+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

/** Översätter en svensk mening. Saknas den i ordlistan lämnas svenskan tillbaka — se filens topp. */
export function translate(lang: Lang, sv: string, vars?: Vars): string {
  if (lang === "sv") return fill(sv, vars);
  const entry = TRANSLATIONS[sv];
  return fill(entry?.[lang] ?? sv, vars);
}

/**
 * Översätt utanför en komponent.
 *
 * Samma funktion som `useT()` ger, men utan prenumeration: den som anropar den här måste själv
 * ritas om när språket byts. I praktiken sker det ändå — språket byts i en context högst upp och
 * hela trädet ritas om — men skillnaden är värd att veta om.
 */
export function t(sv: string, vars?: Vars): string {
  return translate(current, sv, vars);
}

interface LangContext {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

const Ctx = createContext<LangContext>({ lang: "sv", setLang: () => {} });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    current = initialLang();
    return current;
  });

  // <html lang> är inte kosmetika: skärmläsare väljer röst på den, och webbläsarens egen
  // översättningsfråga ("Vill du översätta den här sidan?") utgår från den.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    current = next;
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Går inte att spara: språket gäller den här sessionen och glöms vid omladdning.
    }
  }, []);

  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Språket och vägen att byta det. */
export function useLang(): LangContext {
  return useContext(Ctx);
}

/**
 * Översättaren för komponenter.
 *
 * Ritar om det som använder den när språket byts — det är hela skillnaden mot `t` ovan.
 */
export function useT(): (sv: string, vars?: Vars) => string {
  const { lang } = useContext(Ctx);
  return useCallback((sv: string, vars?: Vars) => translate(lang, sv, vars), [lang]);
}

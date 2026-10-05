/**
 * Annonsgranskaren: en agent som läser en annons som en människa och säger om den borde godkännas.
 *
 * EN AGENT, INTE ETT FLÖDE. Koden bestämmer inte i vilken ordning något kontrolleras. Modellen får
 * ett mål, några läsverktyg och ett sätt att avsluta, och väljer själv nästa steg varje varv utifrån
 * det den sett hittills. En spegel med en tunn beskrivning och en soffa med en bild som inte visar
 * soffan blir två olika utredningar. Loopen nedan gör bara tre saker: frågar modellen, kör verktyget
 * den valde, och lägger resultatet sist i historiken.
 *
 * BARA LÄSVERKTYG. Agenten ska rekommendera, inte agera, och spärren sitter i verktygslådan och inte
 * i instruktionen: det finns inget verktyg som publicerar, godkänner eller ändrar något. Den kan inte
 * göra det även om den skulle försöka. Godkännandet är fortfarande en människas tryck i panelen.
 *
 * VAD DEN BEDÖMER, och vad den inte gör. Märke, modell, skador, pris och mått kommer ur besiktningen
 * och prismotorn och ska stämma — de är fakta agenten får läsa, inte påståenden den ska pröva. Det den
 * granskar är det en människa ser när hon läser annonsen: beskrivningen, rubriken, kategorin, bilderna
 * och postnumret. Ser det rimligt ut, eller är något ofullständigt, felaktigt eller obegripligt?
 *
 * TAK. Högst MAX_VARV varv och MAX_BILDER bilder per granskning. Nås taket utan rekommendation
 * sparas granskningen som misslyckad — hellre inget svar än ett gissat.
 */

import { FunctionCallingConfigMode, Type, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import path from "node:path";
import { GEMINI_MODEL, getGeminiClient } from "../gemini.js";
import { loadImageAsBase64Scaled } from "../imageUtils.js";
import { jobDir } from "../jobStore.js";
import { CATEGORIES, categoryLabel } from "../butik/catalog.js";
import type { ConditionJob } from "../types.js";
import { hamtaGranskning, sparaGranskning, type AnnonsGranskning, type Beslut, type Omrade, type Problem } from "./store.js";

const MAX_VARV = Number(process.env.GRANSKNING_MAX_VARV ?? 12);
const MAX_BILDER = 12;
const STEG_TIMEOUT_MS = 90_000;

const OMRADEN: Omrade[] = ["beskrivning", "rubrik", "kategori", "bilder", "postnummer", "ovrigt"];

export const SYSTEMPROMPT = `Du är annonsgranskare på Loopa, en tjänst där privatpersoner säljer begagnade möbler. Loopa
besiktigar möbeln ur säljarens bilder och skriver annonsen, som sedan läggs ut i Loopas butik och på
Tradera och Blocket.

MÅL: Gå igenom annonsen som en noggrann människa skulle göra innan den publiceras. Ser den rimlig ut,
eller är något ofullständigt, felaktigt eller obegripligt? Avsluta med en rekommendation: borde den
godkännas eller inte?

VAD DU GRANSKAR:
- Beskrivningen och rubriken: begriplig svenska, stämmer med möbeln på bilderna, inga motsägelser,
  inga konstiga eller uppenbart felaktiga påståenden, inget som saknas för att en köpare ska förstå
  vad som säljs.
- Kategorin: hamnar möbeln där en köpare skulle leta efter den — i butiken, på Tradera och på Blocket?
- Bilderna: visar de möbeln som annonsen beskriver? Är de begripliga, eller är något fel (fel föremål,
  helt mörka, oskarpa så att möbeln inte syns, olämpligt innehåll, personer i fokus)?
- Postnumret: finns det och ser det ut som ett giltigt svenskt postnummer? Det behövs för Blocket och
  för hämtningen.

VAD DU INTE BEDÖMER: märke, modell, skador, skick, pris och mått. De kommer ur besiktningen och
prismotorn och ska stämma. Använd dem som fakta när du läser resten — en beskrivning som säger
"soffa" när besiktningen säger "spegel" är ett fel i BESKRIVNINGEN — men underkänn aldrig en annons
för att du själv tror att priset, märket eller måtten är fel.

ARBETSSÄTT: Du bestämmer själv vad du tittar på och i vilken ordning, med verktygen du har. Varje
svar från dig ska vara ett verktygsanrop. Titta på det som behövs för att kunna säga något säkert,
men inte mer. Du kan inte ändra, publicera eller godkänna något — du lämnar bara en rekommendation.

AVSLUTA alltid med lamna_rekommendation:
- "godkann" när annonsen ser rimlig ut för en köpare. Småsaker som inte stör en köpare är inget skäl
  att underkänna; nämn dem i sammanfattningen i stället.
- "godkann_inte" bara när något är fel, saknas eller är obegripligt på ett sätt som en köpare skulle
  märka och bli vilseledd eller förvirrad av. Lista då varje problem med område, vad som är fel och
  vad admin bör göra.

Var lika sträng som en erfaren människa, inte strängare. En kategori som är rimlig — där en köpare
skulle leta och hitta möbeln — är RÄTT, även om en annan kategori också hade varit rimlig. Underkänn
kategorin bara när den är tydligt fel (en soffa bland lampor) eller när möbeln hamnat i Övrigt fast
den hör hemma i en egen kategori. Samma sak med texten: en formulering du hade skrivit annorlunda är
inget fel.
Skriv på svenska, kort och konkret.`;

export const VERKTYG: FunctionDeclaration[] = [
  {
    name: "las_annonsen",
    description:
      "Läser annonsen så som den går ut: rubrik, hela annonstexten, kategorin i butiken, på Tradera och på Blocket, " +
      "besiktningens fakta (märke, modell, skick, pris, mått), antal bilder och vad systemet själv anser saknas.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "visa_bilder",
    description:
      "Visar annonsens bilder i den ordning de publiceras (omslaget först). Bilderna kommer direkt efter svaret. " +
      `Högst ${MAX_BILDER} bilder per granskning totalt.`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        fran: { type: Type.INTEGER, description: "Första bilden, räknat från 1. Förval 1." },
        antal: { type: Type.INTEGER, description: "Hur många bilder. Förval 4." },
      },
    },
  },
  {
    name: "lista_kategorier",
    description: "Butikens kategorier med vad som hör hemma i var och en. För att avgöra om kategorin är rimlig.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "kontrollera_postnummer",
    description: "Säljarens postnummer, var det kommer ifrån, och om formatet är ett giltigt svenskt postnummer.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "lamna_rekommendation",
    description: "Avslutar granskningen. Anropas exakt en gång, sist.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        beslut: { type: Type.STRING, enum: ["godkann", "godkann_inte"] },
        sammanfattning: { type: Type.STRING, description: "En till tre meningar om annonsen som helhet." },
        problem: {
          type: Type.ARRAY,
          description: "Tom när beslutet är godkann.",
          items: {
            type: Type.OBJECT,
            properties: {
              omrade: { type: Type.STRING, enum: OMRADEN },
              vad: { type: Type.STRING },
              forslag: { type: Type.STRING },
            },
            required: ["omrade", "vad", "forslag"],
          },
        },
      },
      required: ["beslut", "sammanfattning", "problem"],
    },
  },
];

/** Det verktygen läser ur. Hämtas en gång per granskning, så att alla varv ser samma annons. */
export interface Underlag {
  job: ConditionJob;
  annons: Record<string, unknown>;
  bilder: Array<{ fil: string; etikett: string | null }>;
  postnummer: { postnummer: string | null; kalla: string | null };
}

async function hamtaUnderlag(loopaId: string): Promise<Underlag> {
  const { jobByLoopaId } = await import("../publicCard.js");
  const job = await jobByLoopaId(loopaId);
  if (!job) throw new Error("Annonsen finns inte.");
  const { annonsDetalj } = await import("../adminAnnonser.js");
  const detalj = await annonsDetalj(loopaId);
  if (!detalj) throw new Error("Annonsen finns inte.");
  const { planTraderaPublish } = await import("../integrations/tradera/publish.js");
  const { blocketPaket } = await import("../integrations/blocket/publish.js");
  const { medRattelser } = await import("../butik/overrides.js");
  const { adImages } = await import("../adContent.js");

  const tradera = await planTraderaPublish(job).catch(() => null);
  const blocket = await blocketPaket(job).catch(() => null);
  const p = detalj.produkt;
  const text = detalj.overstyrning?.adText || detalj.harleddBeskrivning || detalj.annonstext?.description || null;
  const bilder = (await adImages(await medRattelser(job))).map((b) => ({
    fil: path.join(jobDir(job.id), "originals", b.path),
    etikett: b.viewLabel,
  }));

  const annons = {
    loopaId,
    rubrik: detalj.annonstext?.title ?? p?.title ?? null,
    annonstext: text,
    kategori: {
      butik: p ? categoryLabel(p.categorySlug) : null,
      tradera: tradera?.ok ? tradera.plan.categoryName : `kan inte räknas fram: ${tradera?.reason ?? "okänt"}`,
      blocket: blocket ? [blocket.kategori.main, blocket.kategori.sub, blocket.kategori.product].filter(Boolean).join(" › ") : null,
    },
    fakta_fran_besiktningen: {
      marke: p?.brand ?? null,
      modell: p?.model ?? null,
      skick: p?.condition ?? null,
      pris_kr: p?.priceSek ?? null,
      matt_mm: p ? { bredd: p.dimensions.widthMm, djup: p.dimensions.depthMm, hojd: p.dimensions.heightMm, uppskattade: p.dimensions.estimated } : null,
    },
    antal_bilder: bilder.length,
    systemet_anser_att_detta_saknas: detalj.saknas,
  };
  return { job, annons, bilder, postnummer: { postnummer: detalj.postnummer, kalla: detalj.postnummerKalla } };
}

/** Ett giltigt svenskt postnummer: fem siffror, första inte noll. */
export function giltigtPostnummer(pn: string | null): boolean {
  return !!pn && /^[1-9]\d{4}$/.test(pn.replace(/\s/g, ""));
}

interface VerktygsSvar {
  svar: Record<string, unknown>;
  /** Bilder som följer med svaret, som egna delar i samma meddelande. */
  bilder?: Part[];
  kort: string;
}

async function korVerktyg(
  namn: string,
  arg: Record<string, unknown>,
  u: Underlag,
  visade: { antal: number },
): Promise<VerktygsSvar> {
  switch (namn) {
    case "las_annonsen":
      return { svar: u.annons, kort: `rubrik "${String(u.annons.rubrik ?? "")}", ${u.bilder.length} bilder` };

    case "visa_bilder": {
      const fran = Math.max(1, Number(arg.fran ?? 1) || 1);
      const onskat = Math.max(1, Number(arg.antal ?? 4) || 4);
      const kvar = MAX_BILDER - visade.antal;
      if (kvar <= 0) return { svar: { fel: `Taket på ${MAX_BILDER} bilder är nått.` }, kort: "taket nått" };
      const urval = u.bilder.slice(fran - 1, fran - 1 + Math.min(onskat, kvar));
      if (urval.length === 0) return { svar: { fel: `Det finns ${u.bilder.length} bilder.` }, kort: "inga bilder i intervallet" };
      const delar: Part[] = [];
      for (const [i, b] of urval.entries()) {
        const bild = await loadImageAsBase64Scaled(b.fil, 1024, 80);
        delar.push({ text: `Bild ${fran + i}${b.etikett ? ` (${b.etikett})` : ""}${fran + i === 1 ? " — omslaget" : ""}:` });
        delar.push({ inlineData: { mimeType: bild.mimeType, data: bild.base64 } });
      }
      visade.antal += urval.length;
      return {
        svar: { visar: `bild ${fran}–${fran + urval.length - 1} av ${u.bilder.length}`, bilderna_foljer: true },
        bilder: delar,
        kort: `bild ${fran}–${fran + urval.length - 1} av ${u.bilder.length}`,
      };
    }

    case "lista_kategorier":
      return {
        svar: { kategorier: CATEGORIES.map((c) => ({ namn: c.label, innehall: c.blurb })) },
        kort: `${CATEGORIES.length} kategorier`,
      };

    case "kontrollera_postnummer": {
      const { postnummer, kalla } = u.postnummer;
      const giltigt = giltigtPostnummer(postnummer);
      return {
        svar: {
          postnummer,
          kalla: kalla === "jobb" ? "angivet vid försäljningen" : kalla === "konto" ? "säljarens konto" : null,
          giltigt_format: giltigt,
        },
        kort: postnummer ? `${postnummer} (${giltigt ? "giltigt" : "ogiltigt"} format)` : "saknas",
      };
    }

    default:
      return { svar: { fel: `Okänt verktyg ${namn}.` }, kort: "okänt verktyg" };
  }
}

/** Ett varv: modellens nästa drag. Ett nytt försök vid fel — ett nätverkshack ska inte fälla en hel granskning. */
async function nastaDrag(historik: Content[]) {
  const ai = getGeminiClient();
  const anrop = () =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: historik,
      config: {
        systemInstruction: SYSTEMPROMPT,
        tools: [{ functionDeclarations: VERKTYG }],
        // Varje svar SKA vara ett verktygsanrop. Utan det kan modellen svara i fritext halvvägs, och
        // en granskning som slutar i ett stycke prosa har ingen rekommendation att visa.
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
        temperature: 0,
        httpOptions: { timeout: STEG_TIMEOUT_MS },
      },
    });
  try {
    return await anrop();
  } catch (err) {
    console.warn(`[granskning] ett varv föll, provar igen: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    return await anrop();
  }
}

/** Rekommendationen, prövad. Modellen fyller i ett schema, men ett schema är ingen garanti. */
function tolkaRekommendation(arg: Record<string, unknown>): { beslut: Beslut; sammanfattning: string; problem: Problem[] } {
  const beslut: Beslut = arg.beslut === "godkann" ? "godkann" : "godkann_inte";
  const problem = (Array.isArray(arg.problem) ? arg.problem : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      omrade: (OMRADEN.includes(p.omrade as Omrade) ? p.omrade : "ovrigt") as Omrade,
      vad: String(p.vad ?? "").trim(),
      forslag: String(p.forslag ?? "").trim(),
    }))
    .filter((p) => p.vad);
  return { beslut, sammanfattning: String(arg.sammanfattning ?? "").trim(), problem };
}

const pagaende = new Set<string>();

/** Pågår en granskning av annonsen just nu, i den här processen? */
export function granskningPagar(loopaId: string): boolean {
  return pagaende.has(loopaId);
}

/**
 * Kör agenten på en annons och sparar resultatet. Kastar aldrig — ett fel sparas som status "fel".
 * Returnerar granskningen som den blev.
 */
/** Det loopen behöver utifrån. Utbytbart i testerna, så att loopen går att pröva utan modell och disk. */
export interface Beroenden {
  hamtaUnderlag: (loopaId: string) => Promise<Underlag>;
  nastaDrag: (historik: Content[]) => Promise<{
    candidates?: Array<{ content?: Content }>;
    functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
    usageMetadata?: { totalTokenCount?: number };
  }>;
}

export async function granskaAnnons(
  loopaId: string,
  startadAv: string,
  beroenden: Beroenden = { hamtaUnderlag, nastaDrag },
): Promise<AnnonsGranskning> {
  const g: AnnonsGranskning = {
    loopaId,
    status: "pagar",
    beslut: null,
    sammanfattning: null,
    problem: [],
    steg: [],
    fel: null,
    modell: GEMINI_MODEL,
    tokens: 0,
    startad: new Date().toISOString(),
    klar: null,
    startadAv,
  };
  if (pagaende.has(loopaId)) return (await hamtaGranskning(loopaId)) ?? g;
  pagaende.add(loopaId);
  await sparaGranskning(g);

  try {
    const u = await beroenden.hamtaUnderlag(loopaId);
    const visade = { antal: 0 };
    const historik: Content[] = [
      { role: "user", parts: [{ text: `Granska annons ${loopaId}.` }] },
    ];

    for (let varv = 1; varv <= MAX_VARV; varv += 1) {
      const svar = await beroenden.nastaDrag(historik);
      g.tokens += svar.usageMetadata?.totalTokenCount ?? 0;
      const modellensTur = svar.candidates?.[0]?.content;
      const anrop = svar.functionCalls ?? [];
      if (!modellensTur || anrop.length === 0) throw new Error("Modellen svarade utan att välja ett verktyg.");
      // Hela modellens tur tillbaka i historiken, oförändrad: den bär tankesignaturerna som nästa varv
      // behöver för att fortsätta resonera där det slutade.
      historik.push(modellensTur);

      const svarsdelar: Part[] = [];
      const bilddelar: Part[] = [];
      for (const fc of anrop) {
        const namn = fc.name ?? "";
        const arg = (fc.args ?? {}) as Record<string, unknown>;
        if (namn === "lamna_rekommendation") {
          const r = tolkaRekommendation(arg);
          g.steg.push({ verktyg: namn, argument: {}, resultat: r.beslut === "godkann" ? "Borde godkännas" : "Borde inte godkännas", tid: new Date().toISOString() });
          Object.assign(g, r, { status: "klar", klar: new Date().toISOString() });
          await sparaGranskning(g);
          console.info(`[granskning] ${loopaId}: ${r.beslut} efter ${varv} varv, ${g.tokens} tokens.`);
          return g;
        }
        const r = await korVerktyg(namn, arg, u, visade);
        g.steg.push({ verktyg: namn, argument: arg, resultat: r.kort, tid: new Date().toISOString() });
        svarsdelar.push({ functionResponse: { id: fc.id, name: namn, response: r.svar } });
        if (r.bilder) bilddelar.push(...r.bilder);
      }
      historik.push({ role: "user", parts: [...svarsdelar, ...bilddelar] });
      await sparaGranskning(g);
    }
    throw new Error(`Ingen rekommendation efter ${MAX_VARV} varv.`);
  } catch (err) {
    g.status = "fel";
    g.fel = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    g.klar = new Date().toISOString();
    await sparaGranskning(g);
    console.error(`[granskning] ${loopaId} föll:`, g.fel);
    return g;
  } finally {
    pagaende.delete(loopaId);
  }
}

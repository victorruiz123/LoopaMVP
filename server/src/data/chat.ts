/**
 * Dataflikens chatt: frågor om datan, besvarade ur datan.
 *
 * VAD DEN ÄR TILL FÖR. Vyn bredvid visar allt, och "allt" är precis det som gör den svår att fråga.
 * "Hur ofta har modellen fel om märket", "vilket steg tappar vi folk i", "sålde de vi sänkte priset
 * på snabbare" — det är frågor man ställer i huvudet framför en tabell och sedan låter bli att räkna
 * ut. Chatten är en väg in i tabellen, inte en andra källa vid sidan av den.
 *
 * SAMMA REGEL SOM KORTETS CHATT (cardChat.ts): boten ser exakt det som står i vyn, varken mer eller
 * mindre, och får inte påstå något datan inte bär. En bot som gissar en siffra är värre än ingen
 * bot alls — då är även de tal som ÄR räknade bara påståenden till. Underlaget byggs därför ur
 * `DataSvar` och ingenting annat, och modellen ombeds säga när svaret inte går att läsa ur det.
 *
 * BARA ADMIN. Vägen ligger under /api/admin och prövas där, som allt annat i panelen. Underlaget bär
 * ingen köparidentitet och ingen säljaradress — panelen behöver veta vad som hände med möbeln, aldrig
 * vem som ägde den, och en kontext utan adresser kan inte läcka en.
 */

import { callGeminiStructured, Type } from "../gemini.js";
import type { DataObjekt, DataSvar } from "./dataset.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface DataAnswer {
  answer: string;
  /** Sant när svaret går att läsa ur underlaget. Falskt = boten resonerar eller saknar täckning. */
  belagt: boolean;
  tokensUsed: number;
  modelUsed: string;
}

export const MAX_QUESTION_CHARS = 700;
const HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 1200;

/**
 * Hur många möbler som får plats i underlaget.
 *
 * Taket finns för att en kontext som växer med lagret till slut spränger anropet — tyst, mitt i en
 * fråga. Nyast först, för att det är de senaste körningarna frågorna oftast handlar om, och antalet
 * står utskrivet i underlaget så att boten kan säga att den bara sett en del.
 */
const MAX_OBJEKT = 120;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    answer: {
      type: Type.STRING,
      description:
        "Svaret på svenska, ren text utan markdown. Rakt på. Räkna med talen i underlaget och skriv ut dem. Säg uttryckligen när underlaget inte räcker.",
    },
    belagt: {
      type: Type.BOOLEAN,
      description: "true bara när varje tal i svaret går att läsa eller räkna ur underlaget. false annars.",
    },
  },
  required: ["answer", "belagt"],
};

const SYSTEM = `Du svarar på frågor om Loopas egen data, för en admin som sitter framför tabellen.

REGLER:
- Underlaget nedan är allt du vet. Hitta inte på tal, namn eller möbler som inte står där.
- Räkna gärna: andelar, medianer, jämförelser mellan grupper. Skriv ut vilka rader du räknat på.
- AI:ns påstående och människans rättelse är TVÅ OLIKA SAKER. Blanda dem aldrig ihop. En rättelse
  betyder att modellen hade fel; ett bekräftat fynd betyder att den hade rätt; ett obesvarat fynd
  betyder att ingen sagt något, vilket inte är samma sak som att det stämde.
- Fält som står som LUCKA samlas inte in. Svara att de saknas och varför — påstå aldrig en nolla.
- Underlaget är en delmängd när det står så överst. Säg det när frågan gäller helheten.
- Svara på svenska, 1-6 meningar. Ingen markdown, inga rubriker, inga punktlistor med tecken.`;

/** En möbel som en rad text. Tät med flit: kontexten ska rymma hela lagret, inte tio möbler. */
function objektRad(o: DataObjekt): string {
  const marke = o.identitet.falt.find((f) => f.falt === "märke");
  const del: string[] = [
    `${o.loopaId} "${o.titel}" läge=${o.lage} skapad=${o.createdAt.slice(0, 10)}`,
    `märke_ai=${marke?.aiSa ?? "-"}${marke?.manniskanSa ? ` märke_rättat=${marke.manniskanSa}` : ""}`,
    `identitet_konfidens=${o.identitet.konfidens ?? "-"}`,
    `betyg=${o.skick.betyg ?? "-"} modellens_betyg=${o.skick.modellensBetyg ?? "-"}`,
    `fynd=${o.skick.antalFynd} bekräftade=${o.skick.bekraftade} avvisade=${o.skick.avvisade} egna=${o.skick.saljarensEgna} obesvarade=${o.skick.obesvarade}`,
    `bilder=${o.skick.antalBilder}${o.skick.saknade.length ? ` saknade_vinklar=${o.skick.saknade.join("/")}` : ""}`,
    `pris_förslag=${o.pris.forslagSek ?? "-"} start=${o.pris.saljarensStartSek ?? "-"} golv=${o.pris.golvSek ?? "-"} sänkningar=${o.pris.sankningar.length} slut=${o.pris.slutSek ?? "-"}`,
    `andel_av_nypris=${o.pris.andelAvNypris ?? "-"}% andel_av_förslag=${o.pris.andelAvForslag ?? "-"}%`,
    `visningar=${o.distribution.sidvisningar} unika=${o.distribution.unikaVisningar} klick=${o.distribution.perHandelse ? Object.values(o.distribution.perHandelse).reduce((a, b) => a + b, 0) : 0} köp=${o.distribution.kop} bevakningar=${o.distribution.bevakningar}`,
    `kanaler=${o.distribution.kanaler.map((k) => k.kanal).join("/") || "-"}`,
    `dagar_till_såld=${o.transaktion.dagarTillSald ?? "-"} betalsätt=${o.transaktion.betalsatt ?? "-"} meddelanden=${o.transaktion.antalMeddelanden}${Object.keys(o.transaktion.perKategori).length ? ` (${Object.entries(o.transaktion.perKategori).map(([k, v]) => `${k}:${v}`).join(",")})` : ""}`,
    `flöde_sista_steg=${o.flode.sistaSteg ?? "-"} intygat=${o.flode.intygat ? "ja" : "nej"} tid_till_intygat_s=${o.flode.tidTillIntygatMs !== null ? Math.round(o.flode.tidTillIntygatMs / 1000) : "-"} enhet=${o.flode.enhet ?? "-"}`,
    `rättelser=${o.rattelser.length}`,
  ];
  return del.join(" | ");
}

/**
 * Rättelserna i klartext.
 *
 * Står som en EGEN lista och inte bara som ett antal per möbel, för att det är den enda delen av
 * datan där själva innehållet är poängen: "modellen sa scratch, säljaren sa stain" är svaret på den
 * fråga hela vyn finns för. Taket är hårt av samma skäl som objekttaket.
 */
function rattelseRader(objekt: DataObjekt[], tak = 200): string[] {
  const ut: string[] = [];
  for (const o of objekt) {
    for (const r of o.rattelser) {
      if (ut.length >= tak) return ut;
      ut.push(
        `${o.loopaId} ${r.omrade}/${r.falt}${r.fyndId ? ` fynd=${r.fyndId}` : ""}: ai="${r.aiSa ?? "-"}" människa="${r.manniskanSa ?? "-"}" av=${r.kalla}`,
      );
    }
  }
  return ut;
}

export function byggUnderlag(svar: DataSvar, fokus: DataObjekt | null): string {
  const s = svar.summering;
  const objekt = svar.objekt.slice(0, MAX_OBJEKT);
  const delmangd = svar.objekt.length > objekt.length;

  const rader: string[] = [];
  rader.push("=== UNDERLAG: LOOPAS DATA ===");
  if (delmangd) rader.push(`OBS: underlaget visar de ${objekt.length} senaste av ${svar.objekt.length} möbler.`);
  rader.push("");
  rader.push("--- SUMMERING ---");
  rader.push(
    `möbler=${s.antal} med_rättelse=${s.medRattelse} rättelser=${s.rattelser} fynd=${s.fynd} bekräftade=${s.bekraftadeFynd} avvisade=${s.avvisadeFynd} säljarens_egna=${s.egnaFynd}`,
  );
  rader.push(
    `träffsäkerhet_på_besvarade_fynd=${s.traffsakerhet ?? "-"}% betyg_rättade=${s.betygRattade} identitet_rättade=${s.identitetRattade} pris_rättade=${s.prisRattade}`,
  );
  rader.push(
    `sålda=${s.salda} median_dagar_till_såld=${s.medianDagarTillSald ?? "-"} median_tid_till_intygat_s=${s.medianTidTillIntygatMs !== null ? Math.round(s.medianTidTillIntygatMs / 1000) : "-"}`,
  );
  rader.push("");
  rader.push("--- TRATTEN (alla flöden, även de som aldrig blev ett jobb) ---");
  for (const t of svar.tratt) {
    rader.push(`${t.steg}: nådde=${t.naddeHit} hoppade_av_här=${t.stannade} median_s=${t.medianMs !== null ? Math.round(t.medianMs / 1000) : "-"}`);
  }
  rader.push(`flöden_som_aldrig_blev_ett_jobb=${svar.avhoppUtanJobb}`);
  rader.push("");
  /**
   * Säljarna och de avbrutna flödena.
   *
   * Tratten kan bara svara på hur många; de här två raderna svarar på vem och när, vilket är de
   * frågor panelen faktiskt ställer framför den. Taken är hårda av samma skäl som objekttaket, och
   * att underlaget är en delmängd står utskrivet — en bot som räknar på fyrtio rader och svarar som
   * om den räknat på alla ljuger med rätt siffra.
   */
  const saljare = svar.saljare.slice(0, 40);
  rader.push(`--- SÄLJARNA (${saljare.length} av ${svar.saljare.length}, senast aktiva först) ---`);
  if (!saljare.length) rader.push("Inga säljare är mätta än.");
  for (const s2 of saljare) {
    const vagg = Object.entries(s2.perSistaSteg).sort((a, b) => b[1] - a[1])[0];
    rader.push(
      `konto=${s2.uid} flöden=${s2.floden} påbörjade=${s2.paborjade} intygade=${s2.intygade} avbrutna=${s2.avbrutna} annonser=${s2.annonser} sålda=${s2.salda} samtal=${s2.samtal} vanligaste_avhoppssteget=${vagg ? `${vagg[0]}(${vagg[1]})` : "-"} enhet=${s2.enheter.join("/") || "-"} senast=${s2.senaste?.slice(0, 10) ?? "-"}`,
    );
  }
  rader.push("");
  const avhopp = svar.avhopp.filter((a) => a.paborjad).slice(0, 40);
  rader.push(`--- AVBRUTNA ANNONSER (${avhopp.length} av ${svar.avhopp.filter((a) => a.paborjad).length}, nyast först) ---`);
  if (!avhopp.length) rader.push("Inga avbrutna flöden är mätta än.");
  for (const a of avhopp) {
    rader.push(
      `${a.slut.slice(0, 16)} slutade_på=${a.sistaSteg ?? "-"} tid_i_steget_s=${a.sistaStegMs !== null ? Math.round(a.sistaStegMs / 1000) : "-"} hela_flödet_s=${Math.round(a.totaltMs / 1000)} konto=${a.uid ?? "utloggad"} jobb=${a.jobId ?? "-"} frågor=${a.antalFragor} enhet=${a.enhet ?? "-"} steg=${a.besokta.join(">")}`,
    );
  }
  rader.push("");
  rader.push("--- LUCKOR (samlas inte in — svara aldrig med en nolla på dessa) ---");
  for (const l of svar.luckor) rader.push(`${l.falt}: ${l.skal}`);
  rader.push("");
  if (fokus) {
    rader.push("--- FRÅGAN GÄLLER DEN HÄR MÖBELN ---");
    rader.push(objektRad(fokus));
    for (const f of fokus.skick.fynd) {
      rader.push(
        `  fynd ${f.id}: ${f.typ} på ${f.del}/${f.position} ${f.allvarlighet} konfidens=${f.konfidens} granskning=${f.granskning} säljaren=${f.saljarenSa ?? "svarade inte"}${f.saljarenLaTill ? " (säljarens eget)" : ""}`,
      );
    }
    rader.push("");
  }
  rader.push("--- MÖBLERNA ---");
  for (const o of objekt) rader.push(objektRad(o));
  rader.push("");
  const rattelser = rattelseRader(objekt);
  rader.push(`--- RÄTTELSERNA (${rattelser.length} rader) ---`);
  if (!rattelser.length) rader.push("Inga rättelser är loggade än.");
  for (const r of rattelser) rader.push(r);
  return rader.join("\n");
}

function historik(turns: ChatTurn[]): string {
  const senaste = turns.slice(-HISTORY_TURNS);
  const text = senaste.map((t) => `${t.role === "user" ? "Fråga" : "Svar"}: ${t.content}`).join("\n");
  return text.slice(-MAX_HISTORY_CHARS);
}

export async function svaraPaDatafraga(
  fraga: string,
  svar: DataSvar,
  fokus: DataObjekt | null,
  turns: ChatTurn[] = [],
): Promise<DataAnswer> {
  const underlag = byggUnderlag(svar, fokus);
  const tidigare = turns.length ? `\n\nTIDIGARE I SAMTALET:\n${historik(turns)}` : "";
  const result = await callGeminiStructured<{ answer: string; belagt: boolean }>({
    purpose: "data_chat",
    systemPrompt: SYSTEM,
    userPrompt: `${underlag}${tidigare}\n\nFRÅGA: ${fraga}`,
    images: [],
    responseSchema: RESPONSE_SCHEMA,
    resolution: "low",
    // Underlaget ändras vid varje rättelse, så ett cachat svar blir fel fort. En kort livslängd
    // fångar ändå den som trycker om samma fråga.
    cacheMaxAgeMs: 60_000,
  });
  return {
    answer: result.data.answer,
    belagt: !!result.data.belagt,
    tokensUsed: result.tokensUsed,
    modelUsed: result.modelUsed,
  };
}

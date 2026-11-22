/**
 * Avstämningen: det Facebook VISAR, inte det roboten sparade, avgör vilket pris som ska rättas.
 *
 * Redigeringsroboten (redigera.ts) går på publiceringarnas poster: Facebook-id, inläggsadress,
 * ögonblicksbild. Posterna har hål — säljinlägg utan id, textinlägg utan adress, inlägg som
 * publicerades men står som misslyckade, och inlägg från före posterna fanns. Uppmätt 2026-11-22: 37
 * kort på "Dina inlägg", varav flera i grupper roboten inte visste om, med priser veckor efter stegen.
 *
 * TVÅ SIDOR LÄSES:
 *   /marketplace/you/selling           Varje säljinlägg (Marketplace och grupper) är ett kort vars
 *                                      knapp bär etiketten "Rubrik, 1 950 kr, Aktiv, Publicerad 27/9,
 *                                      Publicerad i <grupp>". Kortets "Fler alternativ för …" öppnar en
 *                                      meny med länken /marketplace/edit/?listing_id=<id>.
 *   /groups/<grupp>/my_posted_content  Textinläggen, med länken "Visa i grupp"
 *                                      (?multi_permalinks=<inläggs-id>). Första raden är
 *                                      "<rubrik> säljes – 1 190 kr" (mapping.ts groupPostCopy).
 *
 * REGLERNA — en avstämning som rättar fel annons är värre än ingen:
 *  1. BARA SÄNKNINGAR. Ett kort vars pris är HÖGRE än möbelns rättas. Ett lägre pris kan vara
 *     säljarens eget, och ett högre än startpriset är inte vår stege — båda lämnas och rapporteras.
 *  2. ENTYDIG RUBRIK. Rubriken ska höra till exakt en möbel bland ALLA jobb (även sålda och
 *     borttagna). Två möbler med samma rubrik → ingenting rörs.
 *  3. BARA AKTIVA KORT ("Aktiv", "I lager"). Sålda och väntande lämnas.
 *  4. REDIGERINGEN SJÄLV är robotens vanliga (rubrikvakt, Loopa-länken i textinlägget).
 *  5. VAD SOM HITTAS SKRIVS IN i publiceringsposten (id, adress), så nästa prissänkning går den
 *     vanliga vägen.
 */

import type { Page } from "playwright";
import { facebookEnabled } from "./config.js";
import { facebookListingFor, groupListingCopy, groupListingSnapshot, groupPostCopy, groupSnapshot, marketplaceCopy, marketplaceSnapshot } from "./mapping.js";
import { fbUrl, goto, withFacebookBrowser } from "./session.js";
import { allGroupPublications, allGroups, allMarketplace, updateGroupPublication, updateMarketplace } from "./store.js";
import { facebookRedigeringSkarp, redigeraAnnons, redigeraTextinlagg, syns, type AnnonsInnehall } from "./redigera.js";
import { listJobs } from "../../jobStore.js";
import { loopaIdFor } from "../../loopaId.js";

// ---------- Tolkningen (ren, testad) ----------

export interface Saljkort {
  etikett: string;
  rubrik: string;
  pris: number;
  status: string;
  /** Gruppens namn som Facebook visar det, eller null för Marketplace. */
  grupp: string | null;
  /** "Publicerad 27/9" eller "Publicerad 2025-12-18" som datum (YYYY-MM-DD), eller null. */
  publicerad: string | null;
}

const KORT = /^(.+), ([\d ]+) kr(?:, ursprungligt pris [\d ]+ kr)?, ([^,]+), Publicerad ([^,]+), Publicerad (?:i (.+)|på Marketplace.*)$/;

/** Etiketten på kortets knapp → rubrik, pris, status och plats. Null för allt som inte är ett kort i kronor. */
export function tolkaSaljkort(etikett: string): Saljkort | null {
  // Facebook skriver "1 950 kr" med hårda mellanslag (U+00A0) — även före "kr" (uppmätt 2026-11-22).
  const m = etikett.replace(/[\u00a0\u202f]/g, " ").match(KORT);
  if (!m) return null;
  return { etikett, rubrik: m[1].trim(), pris: Number(m[2].replace(/\D/g, "")), status: m[3].trim(), grupp: m[5]?.trim() ?? null, publicerad: kortDatum(m[4].trim()) };
}

/** "27/9" (i år, eller förra året om det vore i framtiden) eller "2025-12-18" → "YYYY-MM-DD". */
export function kortDatum(s: string, nu = new Date()): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  let ar = nu.getFullYear();
  const iAr = `${ar}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
  if (iAr > nu.toISOString().slice(0, 10)) ar -= 1;
  return `${ar}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
}

export const AKTIV = /^(Aktiv|I lager|Active|In stock)$/i;

/** Textinläggets första rad: "<rubrik> säljes – 1 190 kr". */
export function tolkaTextinlagg(text: string): { rubrik: string; pris: number } | null {
  const m = text.replace(/[\u00a0\u202f]/g, " ").match(/^\s*(.+?) säljes – ([\d ]+) kr/m);
  return m ? { rubrik: m[1].trim(), pris: Number(m[2].replace(/\D/g, "")) } : null;
}

export function normRubrik(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface Mobel {
  jobId: string;
  loopaId: string;
  pris: number;
  /** Det högsta pris möbeln haft — ett kort över det är inte vår stege. */
  taket: number;
  mp: AnnonsInnehall;
  gl: AnnonsInnehall;
  text: string;
  canonicalUrl: string;
}

export type Utslag =
  | { slag: "ratta"; mobel: Mobel }
  | { slag: "ratt" }
  | { slag: "okand" }
  | { slag: "tvetydig"; jobb: string[] }
  | { slag: "inte_uppe"; jobId: string }
  | { slag: "lagre"; mobel: Mobel }
  | { slag: "over_taket"; mobel: Mobel };

/**
 * Vad ska göras med ett kort (eller textinlägg) med den här rubriken och det här priset?
 * `agare`: rubrik → de jobb som någon gång haft den. `levande`: jobb som ligger ute → möbeln.
 */
export function bedom(rubrik: string, pris: number, agare: Map<string, Set<string>>, levande: Map<string, Mobel>): Utslag {
  const jobb = [...(agare.get(normRubrik(rubrik)) ?? [])];
  if (jobb.length === 0) return { slag: "okand" };
  if (jobb.length > 1) return { slag: "tvetydig", jobb };
  const mobel = levande.get(jobb[0]);
  if (!mobel) return { slag: "inte_uppe", jobId: jobb[0] };
  if (pris === mobel.pris) return { slag: "ratt" };
  if (pris < mobel.pris) return { slag: "lagre", mobel };
  if (pris > mobel.taket) return { slag: "over_taket", mobel };
  return { slag: "ratta", mobel };
}

// ---------- Sidorna ----------

const KORTKNAPP = '[role="button"][aria-label*=", Publicerad "]';

/** Alla kortens etiketter på "Dina inlägg", i ordning. Listan laddas medan man rullar. */
async function lasSaljsidan(page: Page): Promise<string[]> {
  await goto(page, fbUrl("/marketplace/you/selling"), "Dina inlägg");
  // Korten kommer sekunder efter sidan. Inga kort alls efter 25 s = sidan laddade inte (eller är tom).
  await page.locator(KORTKNAPP).first().waitFor({ state: "visible", timeout: 25_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  let forra = -1;
  for (let i = 0; i < 40; i++) {
    const n = await page.locator(KORTKNAPP).count();
    if (n === forra && i > 2) break;
    forra = n;
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(1200);
  }
  return (await page.locator(KORTKNAPP).evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") ?? ""))).filter(Boolean);
}

/** Kort nummer `nr` med exakt den här etiketten → annonsens id ur menyns redigeringslänk. Stänger menyn. */
async function idForKort(page: Page, etikett: string, nr: number): Promise<string | null> {
  const knapp = page.locator(`[role="button"][aria-label="${etikett.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`).nth(nr);
  if ((await knapp.count()) === 0) return null;
  await knapp.scrollIntoViewIfNeeded().catch(() => undefined);
  const kort = knapp.locator("xpath=ancestor::div[.//*[@role='button'][starts-with(@aria-label,'Fler alternativ')]][1]");
  const mer = kort.locator('[role="button"][aria-label^="Fler alternativ"]').first();
  if (!(await syns(mer, 4000))) return null;
  await mer.click();
  const lank = page.locator('a[href*="/marketplace/edit/"]:visible').last();
  const href = (await syns(lank, 5000)) ? await lank.getAttribute("href") : null;
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(500);
  return href?.match(/listing_id=(\d+)/)?.[1] ?? null;
}

/** Gruppens publicerade textinlägg: adressen och texten. Listan laddas medan man rullar. */
async function lasGruppinlagg(page: Page, groupId: string): Promise<{ inlagg: Array<{ postId: string; text: string }>; lasbar: boolean }> {
  await goto(page, fbUrl(`/groups/${encodeURIComponent(groupId)}/my_posted_content`), `grupp ${groupId}: Ditt innehåll`);
  await page.waitForTimeout(4000);
  const hittade = new Map<string, string>();
  let lugnt = 0;
  for (let i = 0; i < 30 && lugnt < 3; i++) {
    // Inga namngivna funktioner i sidans callback (tsx lägger till __name, som inte finns där).
    const rader: Array<[string, string]> = await page.locator("a[href]").evaluateAll((as) => {
      const ut: Array<[string, string]> = [];
      for (const a of as) {
        if ((a.textContent ?? "").trim() !== "Visa i grupp") continue;
        let el: HTMLElement | null = a.parentElement;
        while (el && !/ säljes – /.test(el.innerText ?? "")) el = el.parentElement;
        ut.push([a.getAttribute("href") ?? "", el?.innerText ?? ""]);
      }
      return ut;
    });
    const fore = hittade.size;
    for (const [href, text] of rader) {
      const id = href.match(/multi_permalinks=(\d+)/)?.[1] ?? href.match(/\/posts\/(\d+)/)?.[1];
      if (id && text) hittade.set(id, text);
    }
    lugnt = hittade.size === fore ? lugnt + 1 : 0;
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1200);
  }
  const inlagg = [...hittade].map(([postId, text]) => ({ postId, text }));
  // Läsbar = vi vet att listan är hela sanningen: inlägg hittades, eller sidan säger uttryckligen att den är tom.
  const tom = /Det finns inga inlägg att visa|No posts to show/i.test(await page.locator("body").innerText().catch(() => ""));
  return { inlagg, lasbar: inlagg.length > 0 || tom };
}

// ---------- Underlaget ----------

async function underlag(): Promise<{ agare: Map<string, Set<string>>; levande: Map<string, Mobel> }> {
  const agare = new Map<string, Set<string>>();
  const lagg = (rubrik: string | null | undefined, jobId: string) => {
    if (!rubrik?.trim()) return;
    const k = normRubrik(rubrik);
    if (!agare.has(k)) agare.set(k, new Set());
    agare.get(k)!.add(jobId);
  };
  for (const p of await allMarketplace()) lagg(p.contentSnapshot?.title, p.jobId);
  for (const g of await allGroupPublications()) {
    lagg(g.contentSnapshot?.title, g.jobId);
    if (g.contentSnapshot?.text) lagg(tolkaTextinlagg(g.contentSnapshot.text)?.rubrik, g.jobId);
  }

  const { annonsenLever } = await import("../../priceLadder.js");
  const { listRemovedJobs } = await import("../../jobStore.js");
  for (const job of await listRemovedJobs()) {
    const redo = await facebookListingFor(job).catch(() => null);
    if (redo?.ok) lagg(marketplaceCopy(redo.listing).title, job.id);
  }
  const levande = new Map<string, Mobel>();
  for (const job of await listJobs()) {
    const redo = await facebookListingFor(job).catch(() => null);
    if (!redo?.ok) continue;
    const l = redo.listing;
    const mp = marketplaceCopy(l);
    const gl = groupListingCopy(l);
    lagg(mp.title, job.id);
    lagg(gl.title, job.id);
    if (!(await annonsenLever(job))) continue;
    const stege = job.priceLadder;
    const taket = Math.max(l.price, stege?.startPrice ?? 0, ...(stege?.drops ?? []).map((d) => d.from));
    levande.set(job.id, {
      jobId: job.id,
      loopaId: loopaIdFor(job.id),
      pris: l.price,
      taket,
      mp: { title: mp.title, price: l.price, description: mp.description },
      gl: { title: gl.title, price: l.price, description: gl.description },
      text: groupPostCopy(l),
      canonicalUrl: l.canonicalUrl,
    });
  }
  return { agare, levande };
}

// ---------- Körningen ----------

export interface AvstamningResultat {
  rattade: number;
  fel: number;
  rader: string[];
}

let pagar: Promise<AvstamningResultat> | null = null;

/** Kör avstämningen. Två samtidiga anrop delar samma körning. */
export function stamAvFacebook(opts: { skarp?: boolean; logga?: boolean } = {}): Promise<AvstamningResultat> {
  if (!pagar) pagar = korAvstamning(opts).finally(() => (pagar = null));
  return pagar;
}

async function korAvstamning(opts: { skarp?: boolean; logga?: boolean }): Promise<AvstamningResultat> {
  const res: AvstamningResultat = { rattade: 0, fel: 0, rader: [] };
  if (!facebookEnabled()) return res;
  const skarp = opts.skarp ?? facebookRedigeringSkarp();
  const { agare, levande } = await underlag();
  if (levande.size === 0) return res;
  const grupper = await allGroups();
  const gruppId = (namn: string) => grupper.find((g) => normRubrik(g.name) === normRubrik(namn))?.id ?? null;
  const textGrupper = [...new Set((await allGroupPublications()).filter((g) => (g.composer ?? g.contentSnapshot?.kind ?? "post") === "post").map((g) => g.groupId))];

  await withFacebookBrowser("avstamning", async ({ page }) => {
    // 1. Säljinläggen: läs alla kort, samla id:n för de som ska rättas, redigera sedan.
    const etiketter = await lasSaljsidan(page);
    const kortAlla = etiketter.map(tolkaSaljkort).filter((k): k is Saljkort => k !== null);
    if (opts.logga) res.rader.push(`Dina inlägg: ${etiketter.length} kort, ${kortAlla.length} i kronor. Levande möbler: ${levande.size}.`);
    const raknare = new Map<string, number>();
    const attGora: Array<{ kort: Saljkort; mobel: Mobel; nr: number }> = [];
    for (const e of etiketter) {
      const nr = raknare.get(e) ?? 0;
      raknare.set(e, nr + 1);
      const kort = tolkaSaljkort(e);
      if (!kort || !AKTIV.test(kort.status)) continue;
      const u = bedom(kort.rubrik, kort.pris, agare, levande);
      const var_ = kort.grupp ? `i ${kort.grupp}` : "på Marketplace";
      if (opts.logga) res.rader.push(`  kort "${kort.rubrik}" ${var_} ${kort.pris} kr → ${u.slag}${"mobel" in u ? ` (${u.mobel.jobId.slice(0, 8)} ${u.mobel.pris} kr)` : ""}`);
      if (u.slag === "ratta") attGora.push({ kort, mobel: u.mobel, nr });
      else if (u.slag === "tvetydig") res.rader.push(`"${kort.rubrik}" ${var_}: rubriken hör till flera möbler — rörs inte.`);
      else if (u.slag === "lagre") res.rader.push(`"${kort.rubrik}" ${var_}: ${kort.pris} kr är lägre än Loopas ${u.mobel.pris} kr — rörs inte.`);
      else if (u.slag === "over_taket") res.rader.push(`"${kort.rubrik}" ${var_}: ${kort.pris} kr är över möbelns högsta pris — rörs inte.`);
    }
    const medId: Array<{ kort: Saljkort; mobel: Mobel; id: string }> = [];
    for (const a of attGora) {
      const id = await idForKort(page, a.kort.etikett, a.nr).catch(() => null);
      if (!id) {
        res.fel += 1;
        res.rader.push(`"${a.kort.rubrik}": annonsens id gick inte att läsa ur menyn.`);
        continue;
      }
      if (!medId.some((m) => m.id === id)) medId.push({ ...a, id });
    }
    for (const { kort, mobel, id } of medId) {
      const vad = `"${kort.rubrik}" ${kort.grupp ? `i ${kort.grupp}` : "på Marketplace"}`;
      try {
        const rad = await redigeraAnnons(page, id, kort.grupp ? mobel.gl : mobel.mp, kort.rubrik, skarp, vad);
        res.rattade += 1;
        res.rader.push(`${rad} (${kort.pris} → ${mobel.pris} kr)`);
        if (skarp) await skrivIn(mobel, kort.grupp ? gruppId(kort.grupp) : null, { listingId: id });
      } catch (err) {
        res.fel += 1;
        res.rader.push(err instanceof Error ? err.message : String(err));
      }
    }

    // 1b. Åt andra hållet: säljinlägg som posterna säger ligger ute, men som inte har något kort.
    //     Bara när sidan gav kort alls — en sida som inte laddade får aldrig ta bort något.
    // Och bara för poster som är NYARE än det äldsta inlästa kortet: listan går nyast först och laddas
    // medan man rullar, så ett inlägg äldre än så kan ha legat i den del som inte hann laddas
    // (2026-11-22: samma sida gav 37 kort en gång och 25 nästa).
    const aldsta = kortAlla.map((k) => k.publicerad).filter((d): d is string => !!d).sort()[0] ?? null;
    const tackt = (publishedAt: string | null) => !!aldsta && !!publishedAt && aldsta < publishedAt.slice(0, 10);
    if (kortAlla.length > 0) {
      for (const mobel of levande.values()) {
        const harKort = (grupp: string | null) =>
          kortAlla.some((k) => (grupp === null ? k.grupp === null : k.grupp !== null && normRubrik(k.grupp) === normRubrik(grupp)) && agare.get(normRubrik(k.rubrik))?.has(mobel.jobId));
        for (const p of (await allGroupPublications()).filter((g) => g.listingId === mobel.loopaId && g.status === "PUBLISHED" && (g.composer ?? g.contentSnapshot?.kind) === "listing")) {
          const namn = grupper.find((g) => g.id === p.groupId)?.name;
          if (!namn || harKort(namn) || !tackt(p.publishedAt)) continue;
          if (skarp) await markeraBorta(mobel.loopaId, p.groupId, "finns inte bland Dina inlägg på Facebook");
          res.rader.push(`Grupp ${p.groupId}: säljinlägget finns inte längre på Facebook — räknas inte som uppe.`);
        }
        const mp = (await allMarketplace()).find((m) => m.listingId === mobel.loopaId && m.status === "PUBLISHED");
        if (mp && !harKort(null) && tackt(mp.publishedAt)) {
          if (skarp) await markeraBorta(mobel.loopaId, null, "finns inte bland Dina inlägg på Facebook");
          res.rader.push(`Marketplace: annonsen finns inte längre på Facebook — räknas inte som uppe.`);
        }
      }
    }

    // 2. Textinläggen i de grupper där vi lagt textinlägg.
    for (const g of textGrupper) {
      let last: { inlagg: Array<{ postId: string; text: string }>; lasbar: boolean };
      try {
        last = await lasGruppinlagg(page, g);
      } catch (err) {
        res.rader.push(`Grupp ${g}: inläggen gick inte att läsa (${err instanceof Error ? err.message : err}).`);
        continue;
      }
      const sedda = new Set<string>();
      for (const i of last.inlagg) {
        const t = tolkaTextinlagg(i.text);
        if (!t) continue;
        for (const j of agare.get(normRubrik(t.rubrik)) ?? []) sedda.add(j);
        const u = bedom(t.rubrik, t.pris, agare, levande);
        if (u.slag !== "ratta") {
          if (u.slag === "tvetydig") res.rader.push(`Grupp ${g}: "${t.rubrik}" hör till flera möbler — rörs inte.`);
          continue;
        }
        const url = fbUrl(`/groups/${encodeURIComponent(g)}/posts/${i.postId}/`);
        try {
          const rad = await redigeraTextinlagg(page, url, u.mobel.canonicalUrl, u.mobel.text, skarp, `Grupp ${g}`);
          res.rattade += 1;
          res.rader.push(`${rad} (${t.pris} → ${u.mobel.pris} kr)`);
          if (skarp) await skrivIn(u.mobel, g, { postUrl: url });
        } catch (err) {
          res.fel += 1;
          res.rader.push(err instanceof Error ? err.message : String(err));
        }
      }
      // Textinlägg utan adress som inte syns bland de publicerade: väntar på admin, avvisat eller borttaget.
      if (!last.lasbar) continue;
      for (const p of (await allGroupPublications()).filter((x) => x.groupId === g && x.status === "PUBLISHED" && !x.facebookPostUrl && (x.composer ?? x.contentSnapshot?.kind ?? "post") === "post")) {
        if (!levande.has(p.jobId) || sedda.has(p.jobId)) continue;
        if (skarp) await markeraBorta(p.listingId, g, "syns inte bland gruppens publicerade inlägg (väntar på admin, avvisat eller borttaget)");
        res.rader.push(`Grupp ${g}: textinlägget syns inte bland gruppens publicerade inlägg — räknas inte som uppe.`);
      }
    }
  });

  console.info(`[fb-avstamning] ${res.rattade} rättade, ${res.fel} fel${res.rader.length ? " — " + res.rader.join(" | ").slice(0, 600) : ""}`);
  return res;
}

/** Posten slutar räknas som uppe. Den finns kvar, med skälet, så adminpanelen visar vad som hände. */
export async function markeraBorta(loopaId: string, groupId: string | null, skal: string): Promise<void> {
  const nar = new Date().toISOString().slice(0, 10);
  const andra = <T extends { status: string; failureReason: string | null }>(c: T): T => ({ ...c, status: "FAILED", failureReason: `Borttagen på Facebook: ${skal} (upptäckt ${nar}).` });
  if (groupId) await updateGroupPublication(loopaId, groupId, andra);
  else await updateMarketplace(loopaId, andra);
}

/** Det som hittades skrivs in i publiceringsposten, om det finns en, så nästa sänkning går vanliga vägen. */
async function skrivIn(mobel: Mobel, groupId: string | null, hittat: { listingId?: string; postUrl?: string }): Promise<void> {
  const { job, listing } = await (async () => {
    const { getJob } = await import("../../jobStore.js");
    const job = await getJob(mobel.jobId);
    const redo = job ? await facebookListingFor(job) : null;
    return { job, listing: redo?.ok ? redo.listing : null };
  })();
  if (!job || !listing) return;
  if (groupId) {
    const finns = (await allGroupPublications()).find((p) => p.listingId === mobel.loopaId && p.groupId === groupId);
    if (!finns) return;
    await updateGroupPublication(mobel.loopaId, groupId, (c) => ({
      ...c,
      status: "PUBLISHED",
      ...(hittat.listingId ? { facebookListingId: hittat.listingId, composer: "listing" as const, contentSnapshot: groupListingSnapshot(listing) } : {}),
      ...(hittat.postUrl ? { facebookPostUrl: hittat.postUrl, contentSnapshot: groupSnapshot(listing) } : {}),
    }));
  } else if (hittat.listingId) {
    const finns = (await allMarketplace()).find((p) => p.listingId === mobel.loopaId);
    if (!finns) return;
    await updateMarketplace(mobel.loopaId, (c) => ({
      ...c,
      status: "PUBLISHED",
      facebookListingId: hittat.listingId!,
      contentSnapshot: marketplaceSnapshot(listing, c.contentSnapshot?.category ?? ""),
    }));
  }
}

// ---------- Schemat ----------

let timer: NodeJS.Timeout | null = null;

/** Be om en avstämning snart (t.ex. när redigeringen saknade ett id). Flera begäran blir en körning. */
export function begarAvstamning(drojMs = 5 * 60_000): void {
  if (timer || process.env.FACEBOOK_AVSTAMNING === "0") return;
  timer = setTimeout(() => {
    timer = null;
    void stamAvFacebook().catch((err) => console.warn("[fb-avstamning] föll:", err instanceof Error ? err.message : err));
  }, drojMs);
  timer.unref();
}

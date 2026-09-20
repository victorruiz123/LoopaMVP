import { supabase } from "./lib/supabase";
import { t } from "./lib/i18n";
import type { AdText, AdminAnnonsDetalj, AdminAnnonser, AdminUsers, AnnonsAndring, CardAnswer, ConditionJob, JobSummary, Damage, ConditionResult, DebugTrace, ListingAttribute, FurnitureIdentity, ModelCandidate, PriceEstimate, PriceLadder, PublicCard, TraderaState, TraderaPost, TraderaPosten, AdminOrdrar, AdminOrderDetalj, OrderAtgard, DataSvar, DataObjekt, Samtal, AdminEfterlysning, EfterlysningKandidat, AdminFeedbackSvar, MinInbjudan, UtbetalningsRad } from "./types";

/**
 * Varje anrop bär säljarens Supabase-token.
 *
 * Det är den servern knyter jobbet till ett konto med — utan huvudet vet den inte vems annons
 * som skapas, och profilen skulle antingen bli tom eller visa allas möbler.
 *
 * Bild-URL:erna (imageUrl/cropUrl) går utanför den här vägen: de sätts som src på <img> och kan inte
 * bära huvuden. De ligger kvar öppna, precis som förut.
 */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/**
 * Marginalen på en token innan den räknas som förbrukad.
 *
 * Uppladdningen bär sex bilder och tar sekunder. En token med tio sekunder kvar hinner gå ut mellan
 * att huvudet sätts och att servern läser det, och då är felet omöjligt att förstå för säljaren:
 * anropet såg giltigt ut när det skickades.
 */
const TOKEN_MIN_TTL_S = 60;

/**
 * En token som håller hela anropet — annars en inloggning.
 *
 * `getSession` förnyar av sig själv när den hinner, men på en telefon hinner den inte alltid:
 * intervallet i AuthProvider fryser med skärmen, och en säljare som filmat ett varv med appen öppen
 * kan stå här med en död token. Därför prövas hållbarheten uttryckligen och förnyelsen begärs för
 * hand innan anropet går iväg, i stället för att servern får svara 401 på ett varv som redan är
 * filmat.
 */
async function accessToken(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const expires = session?.expires_at;
  if (session?.access_token && (expires === undefined || expires - TOKEN_MIN_TTL_S > Date.now() / 1000)) {
    return session.access_token;
  }
  try {
    const {
      data: { session: renewed },
    } = await supabase.auth.refreshSession();
    if (renewed?.access_token) return renewed.access_token;
  } catch {
    // Förnyelsen gick inte att göra — samma utfall som att det inte fanns någon session alls.
  }
  throw new AuthRequiredError(t("Inloggningen har tagit slut."));
}

async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await accessToken()}`);
  const res = await fetch(input, { ...init, headers });
  /**
   * 401 här betyder att token fanns och såg giltig ut för klienten, men fick nej av Supabase — en
   * session som återkallats någon annanstans, till exempel av en utloggning på en annan enhet
   * (`signOut` går med scope "global"). Den lokala kopian ser hel ut och kan ligga kvar i timmar,
   * så appen skulle fortsätta visa säljaren som inloggad och få nej på varje anrop.
   *
   * Den städas därför bort HÄR, lokalt: utan det är felet outtömligt, och "försök igen" är ett löfte
   * som aldrig kan infrias. Bara den lokala kopian — servern har redan gjort sitt.
   */
  if (res.status === 401) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    throw new AuthRequiredError(t("Inloggningen har tagit slut."));
  }
  return res;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Client-curated shot — already selected/captured, ready to send as-is. */
export interface CapturedShot {
  dataUrl: string;
  viewLabel: string | null;
  source: "video" | "manual";
  /**
   * Satt bara på omslagsbilden, den enda bild säljaren blir ombedd att komponera.
   *
   * Servern läser fältet på två ställen och bedömningen är inte ett av dem: bilden hålls utanför
   * inspektionsanropet (den kostar annars sekunder säljaren står och väntar) och den vinner
   * omslagsvalet om urklippet av den håller måttet. Se `role` på CapturedImage i server/src/types.ts.
   */
  role?: "cover";
}

export async function createJob(
  images: CapturedShot[],
  identity: FurnitureIdentity | null,
  /**
   * Affären skanningen tillhör (Trygg affär), när säljaren kommit hit via en inbjudan.
   *
   * Måste följa med VID SKAPANDET, inte sättas efteråt: fältet är det som håller jobbet utanför
   * Butik och utanför det publika kortet (se ConditionJob.dealId), och ett jobb som märks i efterhand
   * har hunnit vara publikt däremellan. Servern kontrollerar att anroparen faktiskt är affärens
   * säljare innan den godtar id:t.
   */
  dealId: string | null = null,
): Promise<{ jobId: string; imageCount: number }> {
  const res = await authFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images, brand: identity?.brand ?? null, model: identity?.model ?? null, dealId }),
  });
  return json(res);
}

/**
 * Prisförslag på bara märke och modell, utan jobb och utan bilder.
 *
 * Startas i samma ögonblick som säljaren lämnar startsidan och löper medan de filmar. Prismotorn
 * svarar på ungefär 5-11 s; en varvfilmning tar 30-40. Priset är alltså framme innan de ens tryckt
 * stopp, och ligger färdigt när prisvyn öppnas.
 */
export async function fetchPrice(identity: FurnitureIdentity): Promise<PriceEstimate> {
  const res = await authFetch("/api/price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand: identity.brand, model: identity.model }),
  });
  const body = await json<{ price: PriceEstimate }>(res);
  return body.price;
}

/** Säljarens modellval. Startar fas 2: annonsen byggs på valet och priset räknas när skicket är klart. */
export async function selectModel(
  jobId: string,
  choice: { candidate?: ModelCandidate; manualModel?: string },
): Promise<void> {
  const res = await authFetch(`/api/jobs/${jobId}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(choice),
  });
  await json(res);
}

/**
 * "Ingen av dem" — be om fyra nya modellförslag.
 *
 * Servern svarar så fort jobbet står i sökläge och söker vidare i bakgrunden, så anropet är kort och
 * skärmen kan visa väntan direkt. De avfärdade förslagen ligger på jobbet och skickas därifrån som
 * förbudslista — klienten behöver inte bära listan, och en omladdning tappar den inte.
 */
export async function findMoreModels(jobId: string): Promise<void> {
  const res = await authFetch(`/api/jobs/${jobId}/model/more`, { method: "POST" });
  await json(res);
}

/**
 * Säljarens svar om pälsdjur, lukt — och för stolar hur många som säljs.
 *
 * Ställs medan annonsen byggs och sparas på jobbet, inte i webbläsaren: det är annonstexten som ska
 * bära dem, och den sätts samman på servern vid publiceringen — långt efter att den här fliken är
 * stängd.
 */
export async function saveDisclosures(
  jobId: string,
  svar: { pets: boolean; smell: boolean; smellNote?: string | null; chairCount?: number | null },
): Promise<void> {
  const res = await authFetch(`/api/jobs/${jobId}/disclosures`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(svar),
  });
  await json(res);
}

/** Kör om pipelinen på de bildrutor jobbet redan har — ingen ny filmning, ingen ny uppladdning. */
export async function retryJob(jobId: string): Promise<{ jobId: string; imageCount: number }> {
  const res = await authFetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
  return json(res);
}

/**
 * Säljarens prisspann: startpriset annonsen läggs upp med, och golvet den veckovisa sänkningen
 * stannar på.
 *
 * Sparas på jobbet, inte i webbläsaren: det är servern som sänker priset varje vecka, långt efter att
 * den här fliken är stängd.
 */
export async function savePricePlan(
  jobId: string,
  plan: { startPrice: number; floorPrice: number; weeklyDropPct?: number },
): Promise<PriceLadder> {
  const res = await authFetch(`/api/jobs/${jobId}/price-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  const body = await json<{ ladder: PriceLadder }>(res);
  return body.ladder;
}

/**
 * Var utläggningen står, och vad som skulle läggas ut.
 *
 * Pollas medan status är "publishing": Tradera köar annonsen och kön tar 10-60 s, så servern svarar
 * direkt och arbetar vidare i bakgrunden. Namnet på anropet är marknadsplatsens, för det är den
 * servern talar med — men det säljaren beställer är en försäljning, se SellWithLoopa.
 */
export async function getTraderaState(jobId: string): Promise<TraderaState> {
  const res = await authFetch(`/api/jobs/${jobId}/tradera`);
  return json(res);
}

/** Lägger ut möbeln till salu: en riktig Tradera-annons på Loopas konto. Svarar innan den är uppe. */
export async function publishToTradera(jobId: string, opts: { anvandGratis?: boolean } = {}): Promise<TraderaState> {
  const res = await authFetch(`/api/jobs/${jobId}/tradera`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anvandGratis: opts.anvandGratis === true }),
  });
  return json(res);
}

// ---- inbjudningar (/api/salj/inbjudan) ----

export async function getMinInbjudan(): Promise<MinInbjudan> {
  return json(await authFetch("/api/salj/inbjudan"));
}

/**
 * Vem som bjöd in, för landningssidan. UTAN inloggning — den som öppnar länken har sällan ett konto.
 * Null när koden inte finns; sidan visar då sin vanliga rubrik.
 */
export async function hamtaInbjudare(kod: string): Promise<{ namn: string | null } | null> {
  const res = await fetch(`/api/salj/inbjudan/fran/${encodeURIComponent(kod)}`);
  if (!res.ok) return null;
  return res.json();
}

/** Vem som bjöd in det inloggade kontot, så länge inbjudan är öppen (första annonsen inte upplagd). */
export async function hamtaMinInbjudare(): Promise<{ oppen: boolean; namn: string | null }> {
  return json(await authFetch("/api/salj/inbjudan/inbjuden"));
}

/** En ny gratisförsäljning som inbjudaren inte sett än. Driver popupen. */
export async function hamtaNyKredit(): Promise<{ kredit: { id: string; van: string | null; garUt: string } | null }> {
  return json(await authFetch("/api/salj/inbjudan/nytt"));
}

/** Popupen är stängd och visas inte igen. */
export async function markeraKreditVisad(id: string): Promise<void> {
  await authFetch(`/api/salj/inbjudan/visad/${encodeURIComponent(id)}`, { method: "POST" });
}

/** Den nyss registrerade kom via en länk. Utfallet spelar ingen roll för klienten — koden töms oavsett. */
export async function gorInbjudningsansprak(kod: string): Promise<{ utfall: string }> {
  return json(
    await authFetch("/api/salj/inbjudan/ansprak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kod }),
    }),
  );
}

/** Tyst. En mätning som inte gick fram får aldrig märkas av den som delade länken. */
export function loggaLankKopierad(kanal: "kopiera" | "dela"): void {
  void authFetch("/api/salj/inbjudan/handelse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "invite_link_copied", kanal }),
  }).catch(() => undefined);
}

// ---- utbetalningar (adminpanelen) ----

export async function listaUtbetalningar(): Promise<{ rader: UtbetalningsRad[] }> {
  return json(await authFetch("/api/admin/utbetalningar"));
}

/** Markerar möbeln utbetald. Görs EFTER att pengarna skickats — trycket är kvittot, inte överföringen. */
export async function markeraUtbetald(productId: string, mobelprisSek: number | null): Promise<UtbetalningsRad> {
  return json(
    await authFetch(`/api/admin/utbetalningar/${encodeURIComponent(productId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobelprisSek }),
    }),
  );
}

/**
 * Den publika annonsen bakom ett Loopa-ID.
 *
 * ENDA anropet i klienten som går utan Authorization-huvud, och det är avsiktligt: sidan öppnas av
 * någon som läst ett ID i en Tradera-annons och inte har något konto hos oss. Ett authFetch här hade
 * gjort ett publikt kort inloggningspliktigt i det ögonblick en session råkade finnas.
 */
export async function fetchPublicCard(loopaId: string): Promise<PublicCard> {
  const res = await fetch(`/api/cards/${encodeURIComponent(loopaId)}`);
  return json(res);
}

/**
 * En fråga om möbeln på en annons.
 *
 * Går utan Authorization-huvud av samma skäl som kortet själv: chatten sitter på kortet, och kortet
 * läses av någon som kom från en annons. Servern bygger sitt underlag ur det publika kortet, så
 * frågan bär ingen kontext — bara ID:t avgör vad boten kan se.
 */
/**
 * Startsidans chatt. Ingen möbel, inget Loopa-ID — bara en fråga om hur tjänsten fungerar.
 *
 * Egen väg och inte `askListing` med tomt kort: den chatten svarar UR ett kort och märker varje svar
 * med `source`, alltså om det står där eller inte. Den här har inget kort att stå på, och den
 * märkningen vore meningslös. Två frågor, två vägar.
 */
export async function askSalj(
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  /**
   * Vad samtalet hör ihop med.
   *
   * Servern skriver ned frågan och svaret (server/src/data/samtal.ts). `samtal` håller ihop turerna
   * till en tråd, `sess` lägger tråden bredvid flödesstegen den fördes i, och `uid` finns bara för
   * den som redan loggat in — de flesta som frågar har inte det, och ska inte behöva det.
   */
  spar: { samtal: string; sess: string | null; uid: string | null; steg: string | null } | null = null,
): Promise<{ answer: string }> {
  const res = await fetch("/api/salj/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history, ...(spar ?? {}) }),
  });
  return json(res);
}

export async function askListing(
  loopaId: string,
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<CardAnswer> {
  const res = await fetch(`/api/cards/${encodeURIComponent(loopaId)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
  return json(res);
}

export function debugUrl(jobId: string): string {
  return `/api/jobs/${jobId}/debug`;
}

export async function getDebugTrace(id: string): Promise<DebugTrace> {
  const res = await authFetch(debugUrl(id));
  return json(res);
}

export async function getJob(id: string): Promise<ConditionJob> {
  const res = await authFetch(`/api/jobs/${id}`);
  return json(res);
}

/**
 * Tar bort annonsen — möbeln, bildrutorna och kortet.
 *
 * Servern avgör om det får ske: en möbel som ligger ute till salu eller som någon köpt går inte att
 * ta bort, och beskedet om varför kommer därifrån (se handleDeleteJob i server/src/server.ts).
 * Klienten ska inte gissa den regeln i en inaktiverad knapp — då hade två ställen behövt hålla
 * samma lista aktuell.
 */
export async function deleteJob(id: string): Promise<void> {
  const res = await authFetch(`/api/jobs/${id}`, { method: "DELETE" });
  await json(res);
}

export async function listJobs(): Promise<JobSummary[]> {
  const res = await authFetch("/api/jobs");
  return json(res);
}

/**
 * Hämtar bildkakan.
 *
 * Bild-URL:erna nedan sätts som `src` på `<img>` och kan inte bära något Authorization-huvud. Servern
 * utfärdar i stället en signerad HttpOnly-kaka mot säljarens token, som webbläsaren skickar med av
 * sig själv på samma ursprung. Utan det här anropet svarar bildvägarna 401.
 *
 * Körs en gång per inloggning; kakan lever ett dygn.
 */
export async function ensureMediaSession(): Promise<{ isAdmin: boolean }> {
  const res = await authFetch("/api/session", { method: "POST" });
  if (!res.ok) throw new Error(`Kunde inte upprätta bildsession: ${res.status}`);
  // Svaret säger också om kontot är admin. Rollen avgörs på servern — det här är bara beskedet om
  // huruvida adminingången ska ritas, och den som fejkar flaggan i klienten får 404 på varje väg.
  const body = (await res.json().catch(() => ({}))) as { isAdmin?: boolean };
  return { isAdmin: !!body.isAdmin };
}

/** Alla konton, för adminpanelen. Svarar 404 för alla andra än adresserna i serverns admin.ts. */
export async function listUsers(): Promise<AdminUsers> {
  const res = await authFetch("/api/admin/users");
  return json(res);
}

/**
 * Alla annonser vi fått in, med läge, priser, tider och mätning.
 *
 * En rad per JOBB och inte per butiksvara: de som aldrig blev en annons är halva anledningen till att
 * listan finns. Se server/src/adminAnnonser.ts.
 */
export async function listAnnonser(): Promise<AdminAnnonser> {
  return json(await authFetch("/api/admin/annonser"));
}

export async function getAnnons(loopaId: string): Promise<AdminAnnonsDetalj> {
  return json(await authFetch(`/api/admin/annonser/${encodeURIComponent(loopaId)}`));
}

/**
 * Ändrar en annons och får tillbaka den som den blev.
 *
 * PATCH: kroppen är en delmängd. Ett fält som inte nämns lämnas i fred, och `null` betyder
 * uttryckligen tomt — skillnaden är hela överstyrningslagret (server/src/butik/overrides.ts).
 */
export async function patchAnnons(loopaId: string, andring: AnnonsAndring): Promise<AdminAnnonsDetalj> {
  return json(
    await authFetch(`/api/admin/annonser/${encodeURIComponent(loopaId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(andring),
    }),
  );
}

/**
 * Alla köp, med arbetslistan överst.
 *
 * En rad per ORDER och inte per annons: en möbel kan säljas mer än en gång om något går åter, och
 * frågan panelen ställer här är "vad ska köras hem", inte "vad har vi fått in".
 */
export async function listaOrdrar(): Promise<AdminOrdrar> {
  return json(await authFetch("/api/admin/ordrar"));
}

export async function getOrderDetalj(id: string): Promise<AdminOrderDetalj> {
  return json(await authFetch(`/api/admin/ordrar/${encodeURIComponent(id)}`));
}

/** Bokar frakt, markerar levererad eller skriver en anteckning. Svaret är ordern som den blev. */
export async function andraOrder(id: string, atgard: OrderAtgard): Promise<AdminOrderDetalj> {
  return json(
    await authFetch(`/api/admin/ordrar/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(atgard),
    }),
  );
}

/** Efterlysningarna, nyast först. Utkasten från direktsvepet är redan bortsållade på servern. */
export async function listaEfterlysningar(): Promise<{ poster: AdminEfterlysning[] }> {
  return json(await authFetch("/api/admin/efterlysningar"));
}

/** Vad vi har som ligger i närheten. Ett förslag att titta på, inte en matchning. */
export async function efterlysningKandidater(id: string): Promise<{ poster: EfterlysningKandidat[] }> {
  return json(await authFetch(`/api/admin/efterlysningar/${encodeURIComponent(id)}/kandidater`));
}

/** Skickar tipset. POST och inte PATCH: det som händer är att ett brev lämnar huset. */
export async function skickaEfterlysningTips(
  id: string,
  produkt: string,
  halsning?: string,
): Promise<{ skickat: boolean; till: string }> {
  return json(
    await authFetch(`/api/admin/efterlysningar/${encodeURIComponent(id)}/tips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ produkt, halsning }),
    }),
  );
}

/** Tradera-posten: det Gmail-bevakaren sett, nyast först, med bevakarens läge. */
export async function listTraderaPost(): Promise<TraderaPosten> {
  return json(await authFetch("/api/admin/tradera-post"));
}

/** Läser Gmail nu i stället för att vänta på timern. Svaret är hela posten igen plus räkningen. */
export async function hamtaTraderaPost(): Promise<TraderaPosten> {
  return json(await authFetch("/api/admin/tradera-post/hamta", { method: "POST" }));
}

export async function markeraTraderaPost(id: string, hanterad: boolean): Promise<TraderaPost> {
  return json(
    await authFetch(`/api/admin/tradera-post/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hanterad }),
    }),
  );
}

/** Ett kontos jobb, i samma form som profilens egen lista. */
export async function listUserJobs(userId: string): Promise<JobSummary[]> {
  const res = await authFetch(`/api/admin/users/${encodeURIComponent(userId)}/jobs`);
  return json(res);
}

export function imageUrl(jobId: string, imageId: string): string {
  return `/api/jobs/${jobId}/images/${imageId}`;
}

/**
 * Omslaget: säljarens möbel urklippt mot vitt. En fil per jobb, byggd av servern (pipeline/cutout.ts).
 *
 * Ingen bild-id i adressen — urklippet är HÄRLETT ur en av bildrutorna, inte en av dem.
 */
export function coverUrl(jobId: string): string {
  return `/api/jobs/${jobId}/cover`;
}

export function cropUrl(jobId: string, cropPath: string): string {
  const filename = cropPath.split("/").pop();
  return `/api/jobs/${jobId}/crops/${filename}`;
}

export async function actOnDamage(
  jobId: string,
  damageId: string,
  action: "confirm" | "reject" | "edit",
  patch?: Partial<Pick<Damage, "type" | "part" | "semanticLocation" | "severity" | "impact" | "description">>,
): Promise<ConditionResult> {
  const res = await authFetch(`/api/jobs/${jobId}/damages/${damageId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, patch }),
  });
  return json(res);
}

export interface DisputeResult {
  verdict: "REMOVE" | "KEEP";
  reason: string;
  result: ConditionResult;
}

/** Seller disputes one finding and backs it with a fresh close-up; Gemini adjudicates. */
export async function disputeDamage(jobId: string, damageId: string, dataUrl: string): Promise<DisputeResult> {
  const res = await authFetch(`/api/jobs/${jobId}/damages/${damageId}/dispute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  return json(res);
}

export interface AddFromPhotoResult {
  added: boolean;
  reason: string;
  result: ConditionResult;
}

/** Seller photographs damage the walkaround missed; Gemini describes it and it joins the findings. */
export async function addDamageFromPhoto(jobId: string, dataUrl: string): Promise<AddFromPhotoResult> {
  const res = await authFetch(`/api/jobs/${jobId}/damages/from-photo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  return json(res);
}

/**
 * Säljarens rättelser av annonsens uppgifter — måtten och beskrivningen.
 *
 * Skickar bara de fält som ändrats: en tom `attributes` betyder "ta bort alla rader" och inte
 * "rör dem inte", så en delvis patch måste vara delvis hela vägen ner. Svaret är hela
 * `ConditionResult`, som resten av jobbets skrivningar — vyn byter ut sitt tillstånd mot det i
 * stället för att gissa vad servern gjorde med indata.
 */
/** Annonstexten som den står (eller skulle stå) på Tradera. Se handleGetAdText i server/src/server.ts. */
export async function getAdText(jobId: string): Promise<AdText> {
  const res = await authFetch(`/api/jobs/${jobId}/annonstext`);
  return json(res);
}

export async function saveListingDetails(
  jobId: string,
  patch: { attributes?: ListingAttribute[]; description?: string; conditionText?: string },
): Promise<ConditionResult> {
  const res = await authFetch(`/api/jobs/${jobId}/listing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return json(res);
}

export async function addDamage(
  jobId: string,
  damage: Pick<Damage, "type" | "part" | "semanticLocation" | "severity" | "impact" | "description">,
): Promise<ConditionResult> {
  const res = await authFetch(`/api/jobs/${jobId}/damages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(damage),
  });
  return json(res);
}

/**
 * Datasetet: en rad per möbel med allt vi vet om den, och med AI:ns ord skilda från människans.
 *
 * Egen väg och inte en utökning av `listAnnonser`: de två svarar på olika frågor, och den här bär
 * varje fynd med sitt före och efter. Se server/src/data/dataset.ts.
 */
export async function listData(): Promise<DataSvar> {
  return json(await authFetch("/api/admin/data"));
}

/**
 * Samtalen i "Hur fungerar det?".
 *
 * Egen väg och inte ett fält i `listData`: de flesta samtal har ingen möbel, och panelens tyngsta
 * anrop ska inte växa med varje fråga någon ställer. Se server/src/data/samtal.ts.
 */
export async function listSamtal(): Promise<{ samtal: Samtal[] }> {
  return json(await authFetch("/api/admin/data/samtal"));
}

export async function getDataObjekt(id: string): Promise<DataObjekt> {
  return json(await authFetch(`/api/admin/data/${encodeURIComponent(id)}`));
}

/**
 * Frågar chatten om datan. `id` fokuserar svaret på en enskild möbel; utan den svarar den på
 * helheten.
 */
export async function fragaData(
  fraga: string,
  id: string | null,
  historik: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<{ answer: string; belagt: boolean }> {
  return json(
    await authFetch("/api/admin/data/fraga", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fraga, id, historik }),
    }),
  );
}

/**
 * Säljarens omdöme om processen, från kvittot.
 *
 * FÅR INTE KASTA. Rutan öppnas efter att möbeln redan är överlämnad, i ett flöde där säljaren inte
 * har något ärende kvar — ett fel här är alltså ett fel i något de gjorde oss en tjänst med. Svaret
 * är därför ett ja eller ett nej, och rutan tackar likadant i båda fallen.
 */
export async function skickaFeedback(input: {
  jobId?: string | null;
  betyg: number | null;
  text: string | null;
}): Promise<boolean> {
  try {
    const res = await authFetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Alla omdömen, nyast först, med snittbetyget. Adminpanelens feedbackflik. */
export async function listaFeedback(): Promise<AdminFeedbackSvar> {
  return json(await authFetch("/api/admin/feedback"));
}

export interface AdressForslag {
  id: string;
  huvud: string;
  rest: string | null;
}

export interface AdressTraff {
  gatuadress: string | null;
  postnummer: string | null;
  ort: string | null;
}

/**
 * Förslag på adresser till registreringen. Publik och utan token — den som registrerar sig har inget
 * konto än. Ett fel blir en tom lista: förslagen är en genväg, och fältet fungerar utan dem.
 */
export async function adressForslag(q: string, ort: string, session: string): Promise<AdressForslag[]> {
  const params = new URLSearchParams({ q, session });
  if (ort) params.set("ort", ort);
  try {
    const res = await fetch(`/api/adress/forslag?${params}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    return ((await res.json()) as { forslag: AdressForslag[] }).forslag;
  } catch {
    return [];
  }
}

/** Gatan, postnumret och orten för ett valt förslag. Kastar — anroparen lämnar då fälten som de är. */
export async function adressDetalj(id: string, session: string): Promise<AdressTraff> {
  const params = new URLSearchParams({ id, session });
  const res = await fetch(`/api/adress/detalj?${params}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Adressen kunde inte slås upp (${res.status})`);
  return (await res.json()) as AdressTraff;
}

/**
 * Adressen vid en position, för "Använd min nuvarande adress". null = ingen adress där (eller utanför
 * Sverige). Kastar när uppslaget inte gick att göra alls.
 */
export async function adressFranPosition(lat: number, lng: number): Promise<AdressTraff | null> {
  const params = new URLSearchParams({ lat: lat.toFixed(6), lng: lng.toFixed(6) });
  const res = await fetch(`/api/adress/har?${params}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Adressen kunde inte hämtas (${res.status})`);
  return ((await res.json()) as { traff: AdressTraff | null }).traff;
}

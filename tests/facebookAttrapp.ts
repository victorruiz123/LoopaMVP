/**
 * En attrapp av de delar av Facebook som Loopas Facebook-distribution rör: sökningen, gruppsidan med
 * Gå med-knapp och skrivruta, Om-sidan med regler, och Marketplace-formuläret.
 *
 * Markupen följer det som är VERIFIERAT mot den riktiga ytan (role=main, h1, "Offentlig grupp · 1,2 tn
 * medlemmar", "Gå med i grupp"/"Har gått med", "Skriv något …", en omärkt dialog med
 * contenteditable-ruta, Foto/video-knapp, Publicera med aria-label) och det som är ANTAGET för
 * Marketplace (etiketterade fält, listväljare, Nästa, Publicera). Den bevisar att VÅRT flöde är rätt —
 * stoppunkten för torrkörning, idempotensen, avbrottshanteringen — inte att Facebooks markup ser ut
 * så här i dag. Det kan bara en körning mot sajten svara på.
 *
 * Attrappen är också det enda stället automatiska tester någonsin "publicerar" till. Den är inte
 * Facebook; FACEBOOK_MODE=mock och FACEBOOK_BASE_URL pekar hit.
 */

import { createServer, type Server } from "node:http";

export interface AttrappGrupp {
  name: string;
  members: string;
  visibility: "Offentlig grupp" | "Privat grupp";
  rules: string;
  member: boolean;
  composer: "post" | "listing" | "none";
  joinResult: "member" | "pending" | "questions" | "blocked";
}

export interface FbAttrappLage {
  searches: string[];
  joinClicks: string[];
  joinAnswers: Array<{ groupId: string; answers: Record<string, string> }>;
  posts: Array<{ groupId: string; text: string; files: string[] }>;
  /** Säljinlägg genom "Sälj något" i en grupp. `fields.groups` är de ibockade grupperna, `fields.marketplace` brytarens läge. */
  listings: Array<{ groupId: string; fields: Record<string, string>; files: string[] }>;
  marketplace: Array<{ fields: Record<string, string>; files: string[] }>;
  visited: string[];
}

export interface FbAttrappOptions {
  loggedIn?: boolean;
  /** Visar en kontrollpunktssida på den här sortens sida. */
  checkpointOn?: "search" | "group" | "marketplace" | null;
  /** Sidan efter Nästa säger att kontot inte får publicera på Marketplace (verifierad Facebook-text). */
  marketplaceRestricted?: boolean;
  /**
   * Annonsen hamnar i Facebooks granskning direkt efter Publicera (VERIFIERAT 2026-09-26, LP-2FJW-W00Y):
   * varken sidan efter klicket eller "Dina annonser" länkar till /marketplace/item/<id>/ än — bara till
   * /commerce/listing/<id>/, som visar granskningstexten. Se resolveListingUrl i marketplace.ts.
   */
  marketplaceUnderReview?: boolean;
  /**
   * "Dina inlägg" som den såg ut 2026-10-05: korten bär INGEN länk. Adressen syns först i rutan som
   * öppnas när rubriken klickas. Samma möbel har ett kort per grupp ("Publicerad i …") och en äldre
   * annons med samma rubrik ligger längre ner — bara det nyaste Marketplace-kortet är vårt.
   */
  marketplaceCardsOnly?: boolean;
  /** Kontots Marketplace-valuta: "kr" (rätt) eller "$" (fel — så såg det riktiga kontot ut 2026-09-25). */
  marketplaceCurrency?: "kr" | "$";
  groups?: Record<string, AttrappGrupp>;
}

export interface FbAttrapp {
  bas: string;
  lage: FbAttrappLage;
  groups: Record<string, AttrappGrupp>;
  stang: () => Promise<void>;
}

export const STANDARD_GRUPPER: Record<string, AttrappGrupp> = {
  "111": {
    name: "Möbler säljes & köpes Stockholm",
    members: "4,2 tn",
    visibility: "Offentlig grupp",
    rules: "Gruppregler från administratörerna: 1. Var trevlig. 2. Bara möbler och inredning. 3. Inga dubbelpostningar.",
    member: false,
    composer: "post",
    joinResult: "member",
  },
  "222": {
    name: "Köp & Sälj Södermalm",
    members: "15,3 tn",
    visibility: "Privat grupp",
    rules: "Gruppregler: Skriv pris och ort i inlägget. Håll god ton. Bara Södermalm och närliggande områden.",
    member: false,
    composer: "post",
    joinResult: "pending",
  },
  "333": {
    name: "Loppis Stockholm",
    members: "980",
    visibility: "Offentlig grupp",
    rules: "Gruppregler: Skriv pris och ort. Håll god ton.",
    member: false,
    composer: "post",
    joinResult: "questions",
  },
  "444": {
    name: "Secondhand Göteborg",
    members: "8,1 tn",
    visibility: "Offentlig grupp",
    rules: "Gruppregler: Köp och sälj i Göteborg.",
    member: false,
    composer: "listing",
    joinResult: "member",
  },
};

function sida(titel: string, kropp: string, extra = ""): string {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>${titel}</title>
<style>body{font-family:system-ui;margin:0;padding:20px}[role=dialog]{position:fixed;top:60px;left:60px;right:60px;background:#fff;border:1px solid #333;padding:16px;z-index:9}[role=button]{display:inline-block;border:1px solid #333;padding:6px 10px;margin:4px;cursor:pointer}[role=option]{padding:4px;cursor:pointer}[role=listbox]{position:fixed;top:120px;left:100px;z-index:20;background:#fff;border:1px solid #333}[contenteditable]{min-height:60px;border:1px solid #999;padding:6px}</style>
</head><body>${kropp}
${extra}</body></html>`;
}

const CHECKPOINT = sida("Säkerhetskontroll", `<div role="main"><h1>Bekräfta din identitet</h1><p>Vi behöver bekräfta din identitet innan du kan fortsätta.</p></div>`);

const LOGIN = sida("Logga in på Facebook", `<div role="main"><h1>Logga in på Facebook</h1><form action="/login/" method="post"><input name="email" placeholder="E-post"><input name="pass" type="password"><button>Logga in</button></form></div>`);

export async function startaFbAttrapp(opts: FbAttrappOptions = {}): Promise<FbAttrapp> {
  const loggedIn = opts.loggedIn !== false;
  const groups: Record<string, AttrappGrupp> = JSON.parse(JSON.stringify(opts.groups ?? STANDARD_GRUPPER));
  const lage: FbAttrappLage = { searches: [], joinClicks: [], joinAnswers: [], posts: [], listings: [], marketplace: [], visited: [] };
  const pendingJoin = new Set<string>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const html = (body: string, status = 200) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    };
    const jsonOk = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    };
    const readBody = () =>
      new Promise<string>((r) => {
        let s = "";
        req.on("data", (c) => (s += c));
        req.on("end", () => r(s));
      });
    lage.visited.push(url.pathname + (url.search || ""));

    if (!loggedIn && !url.pathname.startsWith("/attrapp/")) return html(LOGIN);

    // ── Inspelningen ─────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname.startsWith("/attrapp/")) {
      void readBody().then((raw) => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const [, , what, id] = url.pathname.split("/");
        if (what === "join" && id) {
          lage.joinClicks.push(id);
          const g = groups[id];
          if (g?.joinResult === "member") g.member = true;
          if (g?.joinResult === "pending") pendingJoin.add(id);
        } else if (what === "answers" && id) {
          lage.joinAnswers.push({ groupId: id, answers: body as Record<string, string> });
          pendingJoin.add(id);
        } else if (what === "post" && id) {
          lage.posts.push({ groupId: id, text: String(body.text ?? ""), files: (body.files as string[]) ?? [] });
        } else if (what === "listing") {
          lage.listings.push({ groupId: id, fields: (body.fields as Record<string, string>) ?? {}, files: (body.files as string[]) ?? [] });
        } else if (what === "marketplace") {
          lage.marketplace.push({ fields: (body.fields as Record<string, string>) ?? {}, files: (body.files as string[]) ?? [] });
        }
        jsonOk();
      });
      return;
    }

    // ── Startsidan ───────────────────────────────────────────────────────
    if (url.pathname === "/") {
      return html(sida("Facebook", `<div role="main"><div role="button" aria-label="Din profil">Profil</div><h1>Flöde</h1><div role="feed"></div></div>`));
    }
    if (url.pathname.startsWith("/login")) return html(LOGIN);

    // ── Sökningen ────────────────────────────────────────────────────────
    if (url.pathname === "/search/groups/") {
      const q = url.searchParams.get("q") ?? "";
      lage.searches.push(q);
      if (opts.checkpointOn === "search") return html(CHECKPOINT);
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      let hits = Object.entries(groups).filter(([, g]) => words.some((w) => g.name.toLowerCase().includes(w)));
      if (hits.length === 0) hits = Object.entries(groups);
      const kort = hits
        .map(
          ([id, g]) =>
            `<div role="article"><a href="/groups/${id}/">${g.name}</a><div>${g.visibility} · ${g.members} medlemmar · Senast aktiv i dag</div></div>`,
        )
        .join("");
      return html(sida(`Sök: ${q}`, `<div role="main"><h1>Grupper</h1>${kort}<a href="/groups/feed/">Ditt flöde</a></div>`));
    }

    // ── Gruppsidan ───────────────────────────────────────────────────────
    const gm = url.pathname.match(/^\/groups\/([^/]+)\/?(about)?\/?$/);
    if (gm) {
      const [, id, about] = gm;
      const g = groups[id];
      if (!g) return html(sida("Saknas", `<div role="main"><h1>Sidan hittades inte</h1><p>Innehållet är inte tillgängligt just nu.</p></div>`), 404);
      if (opts.checkpointOn === "group") return html(CHECKPOINT);
      const pending = pendingJoin.has(id);
      const header = `<h1>${g.name}</h1><div>${g.visibility} · ${g.members} medlemmar</div>`;
      if (about) {
        return html(
          sida(
            `${g.name} — Om`,
            `<div role="main">${header}<h2>Om den här gruppen</h2><p>Beskriv de möbler du säljer, med pris och ort.</p><h3>Gruppregler</h3><p>${g.rules}</p><p>Medlemmar · ${g.members}</p></div>`,
          ),
        );
      }
      const membership = g.member
        ? `<div role="button" id="member">Har gått med</div>`
        : pending
          ? `<div role="button" id="pending">Avbryt begäran</div>`
          : g.joinResult === "blocked"
            ? `<p>Du kan för tillfället inte gå med i den här gruppen.</p>`
            : `<div role="button" aria-label="Gå med i grupp" id="join">Gå med i grupp</div>`;
      const composer =
        g.composer === "post" && g.member
          ? `<div role="button" id="composer">Skriv något ...</div>`
          : g.composer === "post"
            ? `<div role="button" id="composer">Skriv något ...</div>`
            : g.composer === "listing"
              ? `<div role="button" id="sell">Sälj något</div>`
              : "";
      const feed = `<div role="feed" id="feed">
        <div><a href="/groups/${id}/user/1001/">Anna Andersson</a><div data-ad-preview="message">Säljer ett soffbord i ek, 400 kr, Hägersten.</div><a href="/groups/${id}/posts/5001/">3 tim</a></div>
        <div><a href="/groups/${id}/user/1002/">Björn Berg</a><div data-ad-preview="message">Bortskänkes: bokhylla, hämtas på Södermalm.</div><a href="/groups/${id}/posts/5002/">1 d</a></div>
      </div>`;
      const script = `<script>
const GID = ${JSON.stringify(id)};
const GNAME = ${JSON.stringify(g.name)};
const GMEMBERS = ${JSON.stringify(g.members)};
const CUR = ${JSON.stringify(opts.marketplaceCurrency ?? "kr")};
const RESULT = ${JSON.stringify(g.joinResult)};
function post(path, body) { return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); }
const join = document.getElementById("join");
if (join) join.addEventListener("click", async () => {
  await post("/attrapp/join/" + GID);
  if (RESULT === "member") { join.outerHTML = '<div role="button" id="member">Har gått med</div>'; return; }
  if (RESULT === "pending") {
    join.outerHTML = '<div role="button" id="pending">Avbryt begäran</div>';
    document.body.insertAdjacentHTML("beforeend", '<div role="dialog" id="dlg"><p>Din begäran har skickats till gruppens administratörer.</p><div role="button" aria-label="Stäng" onclick="document.getElementById(\\'dlg\\').remove()">Stäng</div></div>');
    return;
  }
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog" id="dlg"><h2>Svara på frågorna för att gå med</h2>' +
    '<div><span dir="auto">Varför vill du gå med?</span><textarea aria-label="Varför vill du gå med?" id="q1"></textarea></div>' +
    '<div><span dir="auto">Bor du i Stockholm?</span><textarea aria-label="Bor du i Stockholm?" id="q2"></textarea></div>' +
    '<div role="checkbox" aria-label="Jag godkänner gruppens regler" aria-checked="false" id="cb" onclick="this.setAttribute(\\'aria-checked\\', this.getAttribute(\\'aria-checked\\')===\\'true\\'?\\'false\\':\\'true\\')">Jag godkänner gruppens regler</div>' +
    '<div role="button" id="send">Skicka</div><div role="button" aria-label="Stäng" onclick="document.getElementById(\\'dlg\\').remove()">Stäng</div></div>');
  document.getElementById("send").addEventListener("click", async () => {
    await post("/attrapp/answers/" + GID, { q1: document.getElementById("q1").value, q2: document.getElementById("q2").value, rules: document.getElementById("cb").getAttribute("aria-checked") });
    document.getElementById("dlg").remove();
    join.outerHTML = '<div role="button" id="pending">Avbryt begäran</div>';
  });
});
const composer = document.getElementById("composer");
if (composer) composer.addEventListener("click", () => {
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-label="Skapa inlägg" id="wrap"></div><div role="dialog" id="cdlg">' +
    '<div contenteditable="true" role="textbox" aria-label="Skriv något..." id="editor"></div>' +
    '<div role="button" aria-label="Foto/video" id="photo">Foto/video</div><input type="file" multiple id="file" style="display:none"><div id="preview"></div>' +
    '<div role="button" aria-label="Publicera" aria-disabled="false" id="publish">Publicera</div>' +
    '<div role="button" aria-label="Stäng dialogrutan i skaparverktyget" id="close">Stäng</div></div>');
  document.getElementById("photo").addEventListener("click", () => { document.getElementById("file").style.display = "block"; });
  document.getElementById("file").addEventListener("change", (e) => { for (const f of e.target.files) document.getElementById("preview").insertAdjacentHTML("beforeend", '<img src="blob:' + f.name + '" alt="" width="20" height="20">'); });
  document.getElementById("close").addEventListener("click", () => {
    document.body.insertAdjacentHTML("beforeend", '<div role="dialog" id="discard"><p>Vill du kasta inlägget?</p><div role="button" id="discardYes">Ta bort</div></div>');
    document.getElementById("discardYes").addEventListener("click", () => { for (const d of document.querySelectorAll("[role=dialog]")) d.remove(); });
  });
  document.getElementById("publish").addEventListener("click", async () => {
    const text = document.getElementById("editor").innerText;
    const files = Array.from(document.getElementById("file").files || []).map((f) => f.name);
    await post("/attrapp/post/" + GID, { text, files });
    for (const d of document.querySelectorAll("[role=dialog]")) d.remove();
    document.getElementById("feed").insertAdjacentHTML("afterbegin", '<div><a href="/groups/' + GID + '/user/9/">Loopa</a><div data-ad-preview="message">' + text.split("\\n")[0] + '</div><a href="/groups/' + GID + '/posts/9999/">Just nu</a></div>');
  });
});
// ── "Sälj något": typval -> Vara till salu -> Dela på fler platser (markupen följer den riktiga ytan 2026-09-26) ──
const sell = document.getElementById("sell");
function closeListing() {
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog" id="ldiscard"><p>Vill du kasta säljinlägget?</p><div role="button" id="ldiscardYes">Kasta</div></div>');
  document.getElementById("ldiscardYes").addEventListener("click", () => { for (const d of document.querySelectorAll("[role=dialog]")) d.remove(); });
}
if (sell) sell.addEventListener("click", () => {
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog" id="ldlg"><h2>Skapa nytt säljinlägg</h2><p>Välj typ av säljinlägg</p><div role="button" id="ltype">Vara till salu<br>Skapa ett säljinlägg för en eller flera varor som skall säljas.</div><div role="button" aria-label="Stäng" id="lclose0">Stäng</div></div>');
  document.getElementById("lclose0").addEventListener("click", closeListing);
  document.getElementById("ltype").addEventListener("click", () => {
    const d = document.getElementById("ldlg");
    d.innerHTML = '<h2>Vara till salu</h2><div><div role="button">Lägg till foton</div><input type="file" multiple id="lfile"><span id="lphotos">0 foton bifogade</span></div>' +
      '<h3>Obligatoriskt</h3><label>Titel<input aria-label="Titel" id="ltitle"></label><label>Pris<input aria-label="Pris" id="lprice"></label>' +
      '<label role="combobox" aria-haspopup="listbox" aria-expanded="false" id="lcond"><span>Skick</span></label>' +
      '<div role="button" aria-expanded="false" id="lmore">Mer information<br>Locka fler intresserade genom att ange mer information.</div>' +
      '<div id="lmoreFields" style="display:none"><label>Beskrivning<textarea aria-label="Beskrivning" id="ldesc"></textarea></label><label>Produkttaggar<textarea aria-label="Produkttaggar"></textarea></label><label>Plats<input aria-label="Plats" role="combobox" id="lloc" value="Stocksund"></label><div role="checkbox" aria-checked="false">Träff på offentlig plats</div></div>' +
      '<div id="lerrors"></div><div role="button" aria-label="Nästa" id="lnext">Nästa</div><div role="button" aria-label="Stäng" id="lclose1">Stäng</div>';
    document.getElementById("lclose1").addEventListener("click", closeListing);
    const lprice = document.getElementById("lprice");
    lprice.addEventListener("input", () => { lprice.dataset.raw = lprice.value.replace(/[^0-9]/g, ""); });
    lprice.addEventListener("blur", () => { const raw = lprice.dataset.raw || lprice.value.replace(/[^0-9]/g, ""); lprice.value = CUR === "$" ? "$" + Number(raw).toLocaleString("sv-SE") : Number(raw).toLocaleString("sv-SE") + " kr"; });
    document.getElementById("lfile").addEventListener("change", (e) => { const n = e.target.files.length; document.getElementById("lphotos").textContent = n + (n === 1 ? " foto bifogat" : " foton bifogade"); document.getElementById("lphotos").insertAdjacentHTML("afterend", '<div role="button" aria-label="Ta bort foto 1 av ' + n + '">Ta bort</div>'); });
    document.getElementById("lcond").addEventListener("click", () => {
      const old = document.getElementById("lcondlist"); if (old) old.remove();
      document.body.insertAdjacentHTML("beforeend", '<div role="listbox" id="lcondlist">' + ["Nytt", "Använd – nyskick", "Använd – i gott skick", "Använd – i använt skick"].map((o) => '<div role="option">' + o + '</div>').join("") + '</div>');
      for (const o of document.querySelectorAll("#lcondlist [role=option]")) o.addEventListener("click", () => { const lbl = document.getElementById("lcond"); lbl.querySelector("span").textContent = "Skick" + o.textContent; lbl.dataset.value = o.textContent; document.getElementById("lcondlist").remove(); });
    });
    document.getElementById("lmore").addEventListener("click", () => { document.getElementById("lmore").setAttribute("aria-expanded", "true"); document.getElementById("lmoreFields").style.display = "block"; });
    const lloc = document.getElementById("lloc");
    lloc.addEventListener("input", () => {
      const old = document.getElementById("lloclist"); if (old) old.remove();
      if (!lloc.value) return;
      document.body.insertAdjacentHTML("beforeend", '<div role="listbox" id="lloclist"><div role="option">' + lloc.value + ' Ort</div></div>');
      for (const o of document.querySelectorAll("#lloclist [role=option]")) o.addEventListener("click", () => { lloc.value = o.textContent.replace(/ Ort$/, ""); document.getElementById("lloclist").remove(); });
    });
    document.getElementById("lnext").addEventListener("click", () => {
      const title = document.getElementById("ltitle").value;
      if (!title) { document.getElementById("lerrors").innerHTML = '<div role="alert">Titel krävs</div>'; return; }
      const fields = { title, price: lprice.dataset.raw || lprice.value.replace(/[^0-9]/g, ""), condition: document.getElementById("lcond").dataset.value || "", description: document.getElementById("ldesc").value, location: lloc.value };
      const files = Array.from(document.getElementById("lfile").files || []).map((f) => f.name);
      // Steget "Dela på fler platser": målgruppen förvald, en annan grupp också förvald (för att pröva att den bockas ur), Marketplace PÅ.
      d.innerHTML = '<h2>Dela på fler platser</h2>' +
        '<div role="checkbox" aria-checked="true" class="lgrp" data-name="' + GNAME + '">' + GNAME + '<br>' + GMEMBERS + ' medlemmar · Offentlig</div>' +
        '<div role="checkbox" aria-checked="true" class="lgrp" data-name="Annan grupp">Annan grupp<br>1,1 tn medlemmar · Offentlig</div>' +
        '<div role="checkbox" aria-checked="false" class="lgrp" data-name="Tredje gruppen">Tredje gruppen<br>500 medlemmar · Privat</div>' +
        '<p>Lägg till ditt säljinlägg på Marketplace</p><div role="button" id="lmp">Marketplace<br>Varor på Marketplace är offentliga och kan ses av alla på och utanför Facebook.</div><div id="lmpopts"></div>' +
        '<div role="button" aria-label="Publicera" aria-disabled="false" id="lpublish">Publicera</div><div role="button" aria-label="Stäng" id="lclose2">Stäng</div>';
      document.getElementById("lclose2").addEventListener("click", closeListing);
      for (const cb of document.querySelectorAll(".lgrp")) cb.addEventListener("click", () => cb.setAttribute("aria-checked", cb.getAttribute("aria-checked") === "true" ? "false" : "true"));
      // Som den riktiga ytan: ingen aria-checked på raden; Marketplace-alternativen (en switch) syns bara när Marketplace är på. Förval PÅ här för att pröva att föraren stänger av.
      let lmpOn = true;
      const lmpRender = () => { document.getElementById("lmpopts").innerHTML = lmpOn ? '<div role="switch" aria-checked="false">Dölj från vänner</div>' : ""; };
      lmpRender();
      document.getElementById("lmp").addEventListener("click", () => { lmpOn = !lmpOn; lmpRender(); });
      document.getElementById("lpublish").addEventListener("click", async () => {
        fields.marketplace = String(lmpOn);
        fields.groups = Array.from(document.querySelectorAll(".lgrp")).filter((c) => c.getAttribute("aria-checked") === "true").map((c) => c.dataset.name).join(",");
        await post("/attrapp/listing/" + GID, { fields, files });
        for (const x of document.querySelectorAll("[role=dialog]")) x.remove();
        document.getElementById("feed").insertAdjacentHTML("afterbegin", '<div><a href="/groups/' + GID + '/user/9/">Loopa</a><div data-ad-preview="message">' + fields.title + '</div><a href="/commerce/listing/8888/">' + fields.title + '</a></div>');
      });
    });
  });
});
</script>`;
      return html(sida(g.name, `<div role="main">${header}${membership}<div role="button" aria-label="Dela grupp">Dela</div>${composer}${feed}</div>`, script));
    }

    // ── Marketplace (markupen följer den RIKTIGA ytan, avläst 2026-09-25) ──
    // Kategori och skick är <label role="combobox">; kategorin öppnar en dialog med en knapp per
    // kategori (löv), skicket en lista med role=option. Beskrivning och plats ligger under den
    // hopfällda knappen "Mer information". Prisfältet formateras med kontots valuta (här kr).
    // Sidan efter Nästa (?step=audience) bär Publicera — och eventuellt Facebooks spärrtext.
    if (url.pathname === "/marketplace/create/item") {
      if (opts.checkpointOn === "marketplace") return html(CHECKPOINT);
      const restricted = opts.marketplaceRestricted === true;
      const currency = opts.marketplaceCurrency ?? "kr";
      const underReview = opts.marketplaceUnderReview === true || opts.marketplaceCardsOnly === true;
      const script = `<script>
function post(path, body) { return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); }
const CUR = ${JSON.stringify(currency)};
const RESTRICTED = ${JSON.stringify(restricted)};
const UNDER_REVIEW = ${JSON.stringify(underReview)};
const price = document.getElementById("price");
price.addEventListener("input", () => { price.dataset.raw = price.value.replace(/[^0-9]/g, ""); });
price.addEventListener("blur", () => { const raw = price.dataset.raw || price.value.replace(/[^0-9]/g, ""); price.value = CUR === "$" ? "$" + Number(raw).toLocaleString("sv-SE") : Number(raw).toLocaleString("sv-SE") + " kr"; });
document.getElementById("category").addEventListener("click", () => {
  const old = document.getElementById("catdlg"); if (old) old.remove();
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog" id="catdlg"><span>Hem och trädgård</span>' + ["Verktyg", "Möbler", "Hushåll", "Trädgård", "Vitvaror"].map((o) => '<div role="button" data-cat="' + o + '"><span>' + o + '</span></div>').join("") + '</div>');
  for (const b of document.querySelectorAll("#catdlg [role=button]")) b.addEventListener("click", () => { const lbl = document.getElementById("category"); lbl.querySelector("span").textContent = "Kategori" + b.dataset.cat; lbl.dataset.value = b.dataset.cat; document.getElementById("catdlg").remove(); });
});
document.getElementById("condition").addEventListener("click", () => {
  const old = document.getElementById("condlist"); if (old) old.remove();
  document.body.insertAdjacentHTML("beforeend", '<div role="listbox" id="condlist">' + ["Nytt", "Använd – nyskick", "Använd – i gott skick", "Använd – i använt skick"].map((o) => '<div role="option">' + o + '</div>').join("") + '</div>');
  for (const o of document.querySelectorAll("#condlist [role=option]")) o.addEventListener("click", () => { const lbl = document.getElementById("condition"); lbl.querySelector("span").textContent = "Skick" + o.textContent; lbl.dataset.value = o.textContent; document.getElementById("condlist").remove(); });
});
document.getElementById("more").addEventListener("click", () => { const m = document.getElementById("more"); m.setAttribute("aria-expanded", "true"); document.getElementById("moreFields").style.display = "block"; });
const loc = document.getElementById("location");
loc.addEventListener("input", () => {
  const old = document.getElementById("loclist"); if (old) old.remove();
  if (!loc.value) return;
  document.body.insertAdjacentHTML("beforeend", '<div role="listbox" id="loclist"><div role="option">' + loc.value + ' Ort</div><div role="option">' + loc.value + ', Maine Ort</div></div>');
  for (const o of document.querySelectorAll("#loclist [role=option]")) o.addEventListener("click", () => { loc.value = o.textContent.replace(/ Ort$/, ""); document.getElementById("loclist").remove(); });
});
document.getElementById("file").addEventListener("change", (e) => { for (const f of e.target.files) document.getElementById("photos").insertAdjacentHTML("beforeend", '<img src="blob:' + f.name + '" alt="" width="20" height="20">'); });
document.getElementById("next").addEventListener("click", () => {
  const title = document.getElementById("title").value;
  if (!title) { document.getElementById("errors").innerHTML = '<div role="alert">Titel krävs</div>'; return; }
  document.getElementById("next").remove();
  document.getElementById("step2").innerHTML = (RESTRICTED ? '<p>Publicera offentligt</p><p>Du kan inte skapa inlägg på Marketplace just nu eftersom du har nått den dagliga gränsen för nya Facebook-konton.</p>' : '<p>Publicera offentligt</p>') + '<div role="button" aria-label="Föregående">Föregående</div><div role="button" aria-label="Publicera" aria-disabled="false" id="publish">Publicera</div>';
  history.replaceState(null, "", "/marketplace/create/item?step=audience");
  document.getElementById("publish").addEventListener("click", async () => {
    const fields = { title, price: price.dataset.raw || price.value.replace(/[^0-9]/g, ""), category: document.getElementById("category").dataset.value || "", condition: document.getElementById("condition").dataset.value || "", description: document.getElementById("description").value, location: loc.value };
    const files = Array.from(document.getElementById("file").files || []).map((f) => f.name);
    await post("/attrapp/marketplace", { fields, files });
    // Granskningen (VERIFIERAT 2026-09-26): sidan direkt efter Publicera länkar INTE till annonsen än —
    // bara "Dina annonser" gör det, och då till /commerce/listing/, inte /marketplace/item/.
    location.href = UNDER_REVIEW ? "/marketplace/you/selling" : "/marketplace/item/777/";
  });
});
</script>`;
      return html(
        sida(
          "Vara till salu",
          `<div role="main"><h1>Vara till salu</h1>
<div id="photos"><div role="button">Lägg till foton</div><input type="file" multiple id="file"></div>
<h2>Obligatoriskt</h2>
<label>Titel<input aria-label="Titel" id="title"></label>
<label>Pris<input aria-label="Pris" id="price"></label>
<label role="combobox" aria-expanded="false" id="category"><span>Kategori</span></label>
<label role="combobox" aria-haspopup="listbox" aria-expanded="false" id="condition"><span>Skick</span></label>
<div role="button" aria-expanded="false" id="more">Mer information<br>Locka fler intresserade genom att ange mer information.</div>
<div id="moreFields" style="display:none">
<label>Beskrivning<textarea aria-label="Beskrivning" id="description"></textarea></label>
<label>Plats<input aria-label="Plats" role="combobox" id="location" value="Stocksund"></label>
</div>
<div id="errors"></div>
<div role="button" aria-label="Nästa" id="next">Nästa</div><div id="step2"></div>
</div>`,
          script,
        ),
      );
    }
    if (url.pathname.startsWith("/marketplace/item/")) return html(sida("Annons", `<div role="main"><h1>Din annons är publicerad</h1><a href="${url.pathname}">Visa annonsen</a></div>`));
    if (url.pathname.startsWith("/commerce/listing/")) return html(sida("Säljinlägg", `<div role="main"><h1>Säljinlägget granskas</h1><p>Det här inlägget granskas innan andra ser det (standardgranskning).</p></div>`));
    if (url.pathname === "/marketplace/you/selling" && opts.marketplaceCardsOnly === true) {
      const titel = lage.marketplace.at(-1)?.fields.title ?? "Soffa";
      const kort = (status: string, id: string) =>
        `<div class="kort"><div><span dir="auto"><span>${titel}</span></span><span dir="auto">6 500 kr</span></div><div><span dir="auto">Aktiv · Publicerad 5/10</span></div><div><span dir="auto">${status}</span></div><template data-id="${id}"></template></div>`;
      const script = `<script>
for (const k of document.querySelectorAll(".kort")) {
  k.querySelector("span[dir=auto] span").addEventListener("click", () => {
    const id = k.querySelector("template").dataset.id;
    document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><a href="/marketplace/item/' + id + '/?ref=selling">Visa</a></div>');
  });
}
</script>`;
      return html(
        sida(
          "Dina inlägg",
          `<div role="main"><h1>Dina inlägg</h1>${kort("Publicerad i Secondhand Stockholm", "9999")}${kort("Publicerad på Marketplace · 0 klick på säljinlägg", "4242")}${kort("Publicerad på Marketplace · 2 klick på säljinlägg", "1111")}</div>`,
          script,
        ),
      );
    }
    if (url.pathname === "/marketplace/you/selling") {
      const href = opts.marketplaceUnderReview === true ? "/commerce/listing/6543/" : "/marketplace/item/777/";
      const badge = opts.marketplaceUnderReview === true ? "<p>Det här inlägget granskas.</p>" : "";
      return html(sida("Dina annonser", `<div role="main"><h1>Dina annonser</h1>${badge}<a href="${href}">Soffa</a></div>`));
    }
    if (url.pathname.startsWith("/marketplace")) return html(sida("Marketplace", `<div role="main"><h1>Marketplace</h1></div>`));

    return html(sida("Saknas", `<div role="main"><h1>Sidan hittades inte</h1></div>`), 404);
  });

  await new Promise<void>((klar) => server.listen(0, "127.0.0.1", klar));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    bas: `http://127.0.0.1:${port}`,
    lage,
    groups,
    stang: () => new Promise<void>((klar) => server.close(() => klar())),
  };
}

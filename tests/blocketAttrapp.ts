/**
 * En attrapp av Blockets Torget-flöde, byggd av WEB COMPONENTS MED SHADOW DOM.
 *
 * Den förra attrappen (blocket-publicerare/tester/attrapp.ts) byggde formuläret av vanliga
 * `<select>`, `<input type="radio">`, `<button>` och `<textarea>` i light-DOM. Den kunde därför inte
 * fånga en enda av de sju buggar som en skarp körning mot blocket.se hittade den 8 september 2026 —
 * den blinda koden gick rakt igenom den och allt såg grönt ut.
 *
 * Den här är byggd för att FALLA för dem. Varje fälla nedan motsvarar en uppmätt bugg:
 *
 *  1. Fälten ligger i shadow roots. `document.querySelectorAll` ser noll; locators ser alla.
 *  2. Etiketten sitter på VÄRDELEMENTET (`aria-label` på `w-textfield`/`w-textarea`), inte på fältet
 *     inuti — `getByLabel(...).fill()` dör, och man måste gå in i komponenten.
 *  3. Underkategorilistan innehåller "Soffor och fåtöljer" medan produktlistan har "Fåtöljer": en
 *     luddig matchning lista-för-lista tar fel lista.
 *  4. Knapparna är `<w-button>` med texten i light-DOM UTANFÖR den `<button>` som ligger i skuggan.
 *  5. (BankID prövas inte här — det kräver en människa. Se README i vips-v40-fixar.)
 *  6. Fraktalternativen är `<w-radio>` utan inre input, etiketten via `aria-labelledby`, valet som
 *     attributet `checked` — och FEL alternativ ("Stor") är förvalt.
 *  7. "Dina senaste utkast" ligger ÖVERST med en post märkt exakt "Torget", korten under. Den som
 *     tar den översta träffen öppnar ett utkast i stället för att skapa en ny annons.
 *
 * Plus: transaktionstypen står på "Bortskänkes" från början, sitthöjden ligger före höjden, och det
 * finns en bildtext-textarea före beskrivningens.
 *
 * Vad den INTE bevisar: att Blockets verkliga markup ser ut så här i dag. Det kan bara en körning mot
 * sajten svara på. Den bevisar att VÅRT flöde är rätt — ordningen, värdena, verifieringarna,
 * stoppunkten för torrkörning och att kvittoadressen översätts.
 */

import { createServer, type Server } from "node:http";

export interface AttrappLage {
  /** Fälten formuläret skickade in. Null tills Fortsätt tryckts. */
  formular: Record<string, string> | null;
  /** Filnamnen i den ordning de laddades upp. */
  bilder: string[];
  fraktval: string | null;
  transaktionstyp: string | null;
  paket: string | null;
  publicerad: boolean;
  annonsId: string;
  /** Sidor som besökts, i ordning. Visar att flödet gick rätt väg. */
  besokta: string[];
  /** Hur många gånger formuläret hämtats. Driver utkastfällan. */
  formularVisningar: number;
}

export interface AttrappOptions {
  /** Falskt = /mina-annonser kastar ut till inloggningen. */
  inloggad?: boolean;
  /**
   * Rubriken ett redan påbörjat utkast har när formuläret öppnas.
   *
   * Blocket kan återuppta ett utkast i stället för att skapa ett nytt. Är rubriken någon annans får
   * roboten inte röra det.
   */
  utkastRubrik?: string | null;
  /** Sant = utkastet ligger kvar bara första gången, och andra försöket får ett tomt formulär. */
  utkastForsvinner?: boolean;
}

export interface Attrapp {
  bas: string;
  lage: AttrappLage;
  stang: () => Promise<void>;
}

const ANNONS_ID = "24720589";

/**
 * Komponentbiblioteket, som ett skript varje sida laddar.
 *
 * Shadow roots är ÖPPNA (`mode: "open"`), precis som Blockets. Det är det som gör att Playwrights
 * locators når in medan `document.querySelectorAll` inte gör det — vore de stängda vore ingen av
 * strategierna möjlig.
 */
const KOMPONENTER = `<script>
class WTextfield extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const rot = this.attachShadow({ mode: "open" });
    const inne = document.createElement("input");
    inne.setAttribute("data-namn", this.getAttribute("name") || "");
    if (this.hasAttribute("value")) inne.value = this.getAttribute("value");
    rot.appendChild(inne);
  }
  get varde() { return this.shadowRoot.querySelector("input").value; }
}
class WTextarea extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const rot = this.attachShadow({ mode: "open" });
    const inne = document.createElement("textarea");
    if (this.hasAttribute("placeholder")) inne.setAttribute("placeholder", this.getAttribute("placeholder"));
    rot.appendChild(inne);
  }
  get varde() { return this.shadowRoot.querySelector("textarea").value; }
}
class WSelect extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const rot = this.attachShadow({ mode: "open" });
    const inne = document.createElement("select");
    for (const rad of JSON.parse(this.getAttribute("options") || "[]")) {
      const o = document.createElement("option");
      o.value = rad.value; o.textContent = rad.label;
      inne.appendChild(o);
    }
    inne.addEventListener("change", () => {
      this.dispatchEvent(new CustomEvent("valt", { bubbles: true, detail: { varde: inne.value } }));
    });
    rot.appendChild(inne);
  }
  get varde() { const s = this.shadowRoot.querySelector("select"); return s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : ""; }
}
/* Texten ligger i light-DOM UTANFÖR knappen i skuggan — därför missar button:has-text() den. */
class WButton extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const rot = this.attachShadow({ mode: "open" });
    rot.innerHTML = '<slot></slot><button style="position:absolute;width:1px;height:1px;opacity:0"></button>';
    this.style.display = "inline-block";
    this.style.cursor = "pointer";
    this.style.border = "1px solid #333";
    this.style.padding = "8px 14px";
    this.style.margin = "6px 0";
  }
}
/* Inget inre <input>. Valet står som attributet checked, etiketten nås via aria-labelledby. */
class WRadio extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const rot = this.attachShadow({ mode: "open" });
    rot.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:1px solid #333;border-radius:50%"></span>';
    this.style.display = "inline-block";
    this.style.cursor = "pointer";
    this.style.width = "16px";
    this.style.height = "16px";
    this.addEventListener("click", () => {
      const grupp = this.getAttribute("name");
      // Namnlösa alternativ hör ändå ihop. Paketsidan hos Blocket har inget name alls, och utan det
      // här hade attrappen låtit två alternativ vara valda samtidigt — ett tillstånd sidan inte har.
      const syskon = grupp ? document.querySelectorAll('w-radio[name="' + grupp + '"]') : document.querySelectorAll("w-radio:not([name])");
      for (const s of syskon) s.removeAttribute("checked");
      this.setAttribute("checked", "");
    });
  }
}
/* Ett klick på etiketten väljer alternativet, som ett kort eller en <label> gör. Utan det här vore
   attrappen SNÄLLARE än förlagan på fel sätt: den skulle straffa ett klick som fungerar i verkligheten. */
document.addEventListener("click", function (e) {
  const mal = e.target;
  if (!mal || mal.tagName === "W-RADIO") return;
  const agare = mal.id ? document.querySelector('w-radio[aria-labelledby~="' + mal.id + '"]') : null;
  if (agare) { agare.click(); return; }
  // Etiketten som bara ligger BREDVID sitt alternativ, utan aria-labelledby — så ser paketsidan ut.
  const granne = mal.parentElement && mal.parentElement.querySelector("w-radio");
  if (granne) granne.click();
});
customElements.define("w-textfield", WTextfield);
customElements.define("w-textarea", WTextarea);
customElements.define("w-select", WSelect);
customElements.define("w-button", WButton);
customElements.define("w-radio", WRadio);
</script>`;

function sida(titel: string, kropp: string, extra = ""): string {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>${titel}</title>
<style>
 body{font-family:system-ui;margin:0;padding:24px}
 .kort{width:220px;height:120px;border:1px solid #ccc;border-radius:8px;padding:12px;cursor:pointer;display:inline-block;margin:8px;vertical-align:top}
 .rad{margin:10px 0}
 footer{margin-top:120px;color:#888}
</style>
${KOMPONENTER}
${extra}</head><body>${kropp}</body></html>`;
}

const COOKIE_BANNER = `
<div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:16px;z-index:99">
  Vi använder kakor. <button onclick="document.getElementById('cookie-banner').remove()">Godkänn alla</button>
</div>`;

/** Startar attrappen på en ledig port. `lage` fylls i medan flödet går framåt. */
export async function startaAttrapp(opts: AttrappOptions = {}): Promise<Attrapp> {
  const inloggad = opts.inloggad !== false;
  const lage: AttrappLage = {
    formular: null,
    bilder: [],
    fraktval: null,
    transaktionstyp: null,
    paket: null,
    publicerad: false,
    annonsId: ANNONS_ID,
    besokta: [],
    formularVisningar: 0,
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const vag = url.pathname;
    lage.besokta.push(vag);

    const html = (kropp: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(kropp);
    };
    const omdirigera = (till: string) => {
      res.writeHead(302, { location: till });
      res.end();
    };
    const jsonKropp = (klar: (data: Record<string, unknown>) => void) => {
      let text = "";
      req.on("data", (bit) => (text += bit));
      req.on("end", () => {
        try {
          klar(JSON.parse(text || "{}"));
        } catch {
          klar({});
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    };

    // ── Startsidan ────────────────────────────────────────────────────────
    if (vag === "/") {
      return html(
        sida(
          "Blocket",
          `${COOKIE_BANNER}
           <nav><a href="/mina-annonser">Mina annonser</a> · <a href="/torget">Torget</a> · <a href="/create-item/start">Ny annons</a></nav>
           <h1>Blocket</h1>`,
        ),
      );
    }

    // ── Välj var annonsen ska ligga ───────────────────────────────────────
    // FÄLLA 7: utkasten ligger ÖVERST, korten under — precis som på riktiga sidan (utkast y≈198,
    // kort y≈397). Ett av utkasten är märkt exakt "Torget". Den som tar den ÖVERSTA träffen på
    // "Torget" öppnar alltså ett gammalt utkast; bara den som tar den NEDERSTA hittar kortet.
    if (vag === "/create-item/start") {
      return html(
        sida(
          "Vad vill du sälja?",
          `<nav><a href="/torget">Torget</a></nav>
           <h1>Vad vill du sälja?</h1>
           <section id="utkast">
             <h2>Dina senaste utkast</h2>
             <div class="kort" onclick="location.href='/recommerce/create/utkast-20990506'">
               <span>Torget</span><p>Bokhylla Karamel från Hannah Home</p>
             </div>
           </section>
           <section id="kort">
             <div class="kort" onclick="location.href='/recommerce/create/abc123'"><h3>Torget</h3><p>Prylar, möbler och kläder</p></div>
             <a class="kort" href="/bostad"><h3>Bostad</h3><p>Lägenhet, hus, tomt</p></a>
             <a class="kort" href="/bil"><h3>Fordon</h3><p>Bil, mc, båt</p></a>
           </section>
           <footer><p>Villkor och Support</p></footer>`,
        ),
      );
    }

    // ── Formuläret ────────────────────────────────────────────────────────
    if (/^\/recommerce\/create\//.test(vag) && req.method === "GET") {
      lage.formularVisningar += 1;
      const visaUtkast = Boolean(opts.utkastRubrik) && (!opts.utkastForsvinner || lage.formularVisningar === 1);
      return html(formularSida(visaUtkast ? opts.utkastRubrik! : ""));
    }

    if (vag === "/skicka-formular" && req.method === "POST") {
      return jsonKropp((data) => {
        const falt: Record<string, string> = {};
        for (const [nyckel, varde] of Object.entries(data)) {
          if (nyckel === "bilder") lage.bilder = varde as string[];
          else if (nyckel === "transaktionstyp") lage.transaktionstyp = String(varde);
          else falt[nyckel] = String(varde ?? "");
        }
        lage.formular = falt;
      });
    }

    // ── Fraktsidan ────────────────────────────────────────────────────────
    // FÄLLA 6: w-radio utan inre input, etikett via aria-labelledby, och "Stor" är FÖRVALT. Den som
    // bara klickar och går vidare utan att verifiera lägger ut möbeln med paketfrakt.
    if (vag === "/shipping" && req.method === "GET") {
      return html(
        sida(
          "Frakt och leverans",
          `<h1>Frakt och leverans</h1>
           <div class="rad"><w-radio name="package-size" aria-labelledby="lbl-liten"></w-radio><span id="lbl-liten">Liten</span></div>
           <div class="rad"><w-radio name="package-size" aria-labelledby="lbl-stor" checked></w-radio><span id="lbl-stor">Stor</span></div>
           <div class="rad"><w-radio name="package-size" aria-labelledby="lbl-ingen"></w-radio><span id="lbl-ingen">Jag kan inte skicka varan</span></div>
           <w-button id="vidare">Fortsätt</w-button>
           <script>
             document.getElementById("vidare").addEventListener("click", function () {
               var valt = document.querySelector('w-radio[checked]');
               var etikett = valt ? document.getElementById(valt.getAttribute("aria-labelledby")).textContent : "";
               fetch("/valj-frakt", { method: "POST", body: JSON.stringify({ frakt: etikett }) })
                 .then(function () { location.href = "/choose-products"; });
             });
           </script>`,
        ),
      );
    }
    if (vag === "/valj-frakt" && req.method === "POST") {
      return jsonKropp((data) => {
        lage.fraktval = String(data.frakt ?? "");
      });
    }

    // ── Paketsidan ────────────────────────────────────────────────────────
    // FÄLLA 8, uppmätt på riktiga /recommerce/choose-products den 9 september 2026: paketsidan är
    // byggd HELT ANNORLUNDA än fraktsidan. De tre alternativen är `w-radio` UTAN name, UTAN role,
    // UTAN aria-labelledby, UTAN aria-label och utan egen text — alltså tre identiska element. Enda
    // skillnaden är texten i förälderelementet, och ingen är förvald.
    //
    // Den som läser etiketten som fraktsidan gör får tre tomma strängar, kan varken välja rätt eller
    // verifiera valet — och en vakt mot betalda paket läser då sitt EGET Bas-val som ett namnlöst
    // valt alternativ. Det var exakt det som hände: "Paketsidan har ett betalt paket valt ()".
    if (vag === "/choose-products" && req.method === "GET") {
      return html(
        sida(
          "Nästan klart",
          `<h1>Nästan klart</h1>
           <div class="rad"><div class="valj"><w-radio></w-radio><span>Bas</span></div><p>Gratis</p></div>
           <div class="rad"><div class="valj"><w-radio></w-radio><span>Plus</span></div><p>149 kr</p></div>
           <div class="rad"><div class="valj"><w-radio></w-radio><span>Premium</span></div><p>399 kr</p></div>
           <w-button id="betala">Gå till betalning</w-button>
           <script>
             document.getElementById("betala").addEventListener("click", function () {
               var valt = document.querySelector('w-radio[checked]');
               var etikett = valt ? valt.parentElement.textContent.replace(/\\s+/g, " ").trim() : "";
               fetch("/valj-paket", { method: "POST", body: JSON.stringify({ paket: etikett }) })
                 .then(function () { location.href = "/order-and-payment/ad-receipt?adId=${ANNONS_ID}"; });
             });
           </script>`,
        ),
      );
    }
    if (vag === "/valj-paket" && req.method === "POST") {
      return jsonKropp((data) => {
        lage.paket = String(data.paket ?? "");
        lage.publicerad = true;
      });
    }

    // ── Kvittot ───────────────────────────────────────────────────────────
    // Adressen bär annons-id:t men fungerar bara för den inloggade. Länken vidare är den enda publika
    // adressen, och det är den publiceraren ska plocka fram.
    if (vag === "/order-and-payment/ad-receipt") {
      return html(
        sida("Tack för din annons!", `<h1>Tack!</h1><p>Din annons är publicerad.</p><a href="/${ANNONS_ID}">Fortsätt till annonsen</a>`),
      );
    }

    if (vag === `/${ANNONS_ID}`) {
      return html(sida("Annonsen", `<h1>${lage.formular?.rubrik ?? "Annons"}</h1><p>${lage.formular?.pris ?? ""} kr</p>`));
    }

    // ── Riktad provsida: bara kategorifällan ──────────────────────────────
    // FÄLLA 3 i renodlad form. Den TOMMA listan innehåller den luddiga träffen ("Soffor och
    // fåtöljer" innehåller "fåtöljer") och den FYLLDA innehåller den exakta ("Fåtöljer"). Här
    // hjälper ingen turordning mellan listorna: bara regeln att alla listor prövas på exakt
    // matchning innan någon prövas luddigt väljer rätt.
    if (vag === "/prov/listor") {
      const luddig = JSON.stringify([
        { value: "", label: "Välj underkategori" },
        { value: "7756", label: "Soffor och fåtöljer" },
      ]);
      const exakt = JSON.stringify([
        { value: "2", label: "Fåtöljer" },
        { value: "1", label: "Soffor" },
      ]);
      return html(
        sida(
          "Provsida: listor",
          `<h1>Listor</h1>
           <w-select id="tom" options='${luddig}'></w-select>
           <w-select id="fylld" options='${exakt}'></w-select>`,
        ),
      );
    }

    // ── Mina annonser / inloggning ────────────────────────────────────────
    if (vag === "/mina-annonser") {
      if (!inloggad) return omdirigera("/email-login");
      return html(sida("Mina annonser", `${COOKIE_BANNER}<h1>Mina annonser</h1><p>Du har 0 annonser.</p>`));
    }
    if (vag === "/email-login") {
      return html(sida("Logga in", "<h1>Logga in</h1><p>Vi skickar en kod till din e-post.</p>"));
    }

    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(sida("Hittades inte", "<h1>404</h1>"));
  });

  await new Promise<void>((klar) => server.listen(0, "127.0.0.1", klar));
  const adress = server.address();
  const port = typeof adress === "object" && adress ? adress.port : 0;

  return {
    bas: `http://127.0.0.1:${port}`,
    lage,
    stang: () => new Promise<void>((klar) => server.close(() => klar())),
  };
}

/**
 * Själva formuläret, byggt av komponenter.
 *
 * Etiketterna sitter som `aria-label` PÅ VÄRDELEMENTET, inte på fältet inuti — det är så Blockets
 * formulär är byggt, och det är hela orsaken till att `getByLabel(...).fill()` dör med "Element is
 * not an <input>". Sitthöjden ligger FÖRE höjden, så en luddig etikettsökning fyller fel fält.
 */
function formularSida(utkastRubrik: string): string {
  const kategorier = JSON.stringify([
    { value: "", label: "Välj kategori" },
    { value: "78", label: "Möbler och inredning" },
    { value: "76", label: "Konst och antikt" },
    { value: "10", label: "Elektronik" },
  ]);
  // FÄLLA 3: "Soffor och fåtöljer" ligger i UNDERkategorilistan medan "Fåtöljer" är ett löv i
  // produktlistan. En luddig matchning som går lista för lista tar underkategorin och lövet blir
  // aldrig satt.
  const underkategorier = JSON.stringify([
    { value: "", label: "Välj underkategori" },
    { value: "7756", label: "Soffor och fåtöljer" },
    { value: "5196", label: "Bord och stolar" },
    { value: "8345", label: "Hyllor och byråer" },
  ]);
  const produkter = JSON.stringify([
    { value: "", label: "Välj produkttyp" },
    { value: "1", label: "Soffor" },
    { value: "2", label: "Fåtöljer" },
    { value: "3", label: "Bäddsoffor" },
  ]);
  const skick = JSON.stringify([
    { value: "", label: "Välj skick" },
    { value: "1", label: "Nytt skick - helt ny" },
    { value: "2", label: "Mycket bra skick - som ny" },
    { value: "3", label: "Bra skick - varsamt använd" },
    { value: "4", label: "Okej skick - synligt använd" },
  ]);

  return sida(
    "Skapa annons",
    `<h1>Skapa annons</h1>

     <div class="rad">
       <w-radio name="transaktion" aria-labelledby="lbl-salj"></w-radio><span id="lbl-salj">Sälj</span>
       <w-radio name="transaktion" aria-labelledby="lbl-skank" checked></w-radio><span id="lbl-skank">Bortskänkes</span>
     </div>

     <div class="rad">
       <input type="file" id="filfalt" accept="image/*">
       <ul id="bildlista"></ul>
     </div>

     <div class="rad"><span>Kategori</span> <w-select id="huvud" options='${kategorier}'></w-select></div>
     <div class="rad" id="underruta" style="display:none"><span>Underkategori</span> <w-select id="under" options='${underkategorier}'></w-select></div>
     <div class="rad" id="produktruta" style="display:none"><span>Produkttyp</span> <w-select id="produkt" options='${produkter}'></w-select></div>
     <div class="rad" id="skickruta" style="display:none"><span>Skick</span> <w-select id="skick" options='${skick}'></w-select></div>

     <div class="rad"><w-textfield id="sitthojd" name="sitthojd" aria-label="Sitthöjd"></w-textfield></div>
     <div class="rad"><w-textfield id="hojd" name="hojd" aria-label="Höjd"></w-textfield></div>
     <div class="rad"><w-textfield id="bredd" name="bredd" aria-label="Bredd"></w-textfield></div>
     <div class="rad"><w-textfield id="djup" name="djup" aria-label="Djup"></w-textfield></div>
     <div class="rad"><w-textfield id="marke" name="brand" aria-label="Varumärke"></w-textfield></div>

     <div class="rad"><w-textfield id="rubrik" name="subject" aria-label="Annonsrubrik" value="${utkastRubrik.replace(/"/g, "&quot;")}"></w-textfield></div>

     <div class="rad"><w-textarea id="bildtext" placeholder="Skriv en bildtext"></w-textarea></div>
     <div class="rad"><w-textarea id="beskrivning" aria-label="Beskrivning"></w-textarea></div>

     <div class="rad"><w-textfield id="pris" name="price" aria-label="Pris"></w-textfield></div>
     <div class="rad"><w-textfield id="postnummer" name="zipcode" aria-label="Postnummer"></w-textfield></div>

     <w-button id="vidare">Fortsätt</w-button>

     <script>
       var bilder = [];
       // Uppladdaren tar en fil i taget och TÖMMER fältet efteråt, precis som Blockets gör.
       document.getElementById("filfalt").addEventListener("change", function () {
         for (var i = 0; i < this.files.length; i++) {
           bilder.push(this.files[i].name);
           var rad = document.createElement("li");
           rad.textContent = this.files[i].name;
           document.getElementById("bildlista").appendChild(rad);
         }
         this.value = "";
       });

       // Nivåerna kommer fram en i taget, som hos Blocket.
       document.getElementById("huvud").addEventListener("valt", function (e) {
         document.getElementById("underruta").style.display = e.detail.varde ? "" : "none";
       });
       document.getElementById("under").addEventListener("valt", function (e) {
         document.getElementById("produktruta").style.display = e.detail.varde ? "" : "none";
         document.getElementById("skickruta").style.display = e.detail.varde ? "" : "none";
       });

       document.getElementById("vidare").addEventListener("click", function () {
         var hamta = function (id) { var el = document.getElementById(id); return el ? el.varde : ""; };
         var valdTyp = document.querySelector('w-radio[name="transaktion"][checked]');
         fetch("/skicka-formular", {
           method: "POST",
           body: JSON.stringify({
             transaktionstyp: valdTyp ? document.getElementById(valdTyp.getAttribute("aria-labelledby")).textContent : "",
             huvudkategori: hamta("huvud"),
             underkategori: hamta("under"),
             produkttyp: hamta("produkt"),
             skick: hamta("skick"),
             sitthojd: hamta("sitthojd"),
             hojd: hamta("hojd"),
             bredd: hamta("bredd"),
             djup: hamta("djup"),
             marke: hamta("marke"),
             rubrik: hamta("rubrik"),
             bildtext: hamta("bildtext"),
             beskrivning: hamta("beskrivning"),
             pris: hamta("pris"),
             postnummer: hamta("postnummer"),
             bilder: bilder
           })
         }).then(function () { location.href = "/shipping"; });
       });
     </script>`,
  );
}

/**
 * Butiken på marknadsdomänen.
 *
 * VARFÖR DEN FINNS. loopa.nu serveras av Cloudflare Pages (marknadssajten: /, /company, /brands,
 * /secondhand) medan appen och butiken kör på Oracle bakom en tunnel på app.loopa.nu. För Google är
 * det två skilda sajter: marknadsdomänen har byggt upp auktoritet, app-subdomänen har ingen. Och
 * det är butikssidorna — de som ska ranka på "begagnad stol" — som låg på den utan.
 *
 * Workern flyttar bara ADRESSEN. Ingen kod flyttas, ingen server byter roll: en förfrågan till
 * loopa.nu/butik/... hämtas från Oracle och svaret skickas vidare oförändrat.
 *
 * BUNDEN TILL EGNA RUTTER, inte till hela zonen. Se listan längst ner. Allt Workern inte är bunden
 * till når den aldrig, och går till Pages precis som förut — det är därför den inte behöver någon
 * "skicka vidare till marknadssajten"-gren, och därför den inte kan slinga.
 */

/** Servern bakom tunneln. Adressen är fortfarande app.loopa.nu — tunnelns ingress matchar på det namnet. */
const URSPRUNG = "app.loopa.nu";

export default {
  async fetch(request) {
    const inkommande = new URL(request.url);
    const mal = new URL(request.url);
    mal.hostname = URSPRUNG;
    mal.protocol = "https:";
    mal.port = "";

    /**
     * Huvudet som hindrar en oändlig slinga.
     *
     * Servern omdirigerar butikssidor till den kanoniska domänen (se flyttadAdress i butik/seo.ts),
     * och den avgör på värdnamnet. Anropet nedan går till app.loopa.nu, så utan det här huvudet
     * skulle servern se sitt eget namn, svara 301 till loopa.nu, och den förfrågan hade kommit
     * tillbaka hit. `x-forwarded-host` säger vad BESÖKAREN bad om, och då svarar servern 200.
     */
    const huvuden = new Headers(request.headers);
    huvuden.set("x-forwarded-host", inkommande.host);
    huvuden.set("x-forwarded-proto", inkommande.protocol.replace(":", ""));

    const svar = await fetch(
      new Request(mal.toString(), {
        method: request.method,
        headers: huvuden,
        body: request.body,
        redirect: "manual",
      }),
    );

    /**
     * En omdirigering från servern skrivs om till besökarens domän.
     *
     * Servern känner bara sitt eget namn och svarar t.ex. `Location: /butik` eller en absolut
     * adress på app.loopa.nu. Skickas den vidare orörd hoppar besökaren ut ur marknadsdomänen
     * mitt i ett besök, och nästa sida ligger återigen på fel adress.
     */
    const plats = svar.headers.get("location");
    if (plats) {
      const omskriven = new URL(plats, mal);
      if (omskriven.hostname === URSPRUNG) {
        omskriven.hostname = inkommande.hostname;
        const nya = new Headers(svar.headers);
        nya.set("location", omskriven.toString());
        return new Response(svar.body, { status: svar.status, statusText: svar.statusText, headers: nya });
      }
    }
    return svar;
  },
};

/*
 * RUTTERNA WORKERN SKA BINDAS TILL
 * ────────────────────────────────
 * Cloudflare → Workers & Pages → den här workern → Settings → Domains & Routes → Add route.
 * En rad per mönster, zon loopa.nu:
 *
 *   loopa.nu/butik*
 *   loopa.nu/efterlyses*
 *   loopa.nu/sitemap.xml
 *   loopa.nu/robots.txt
 *   loopa.nu/app-assets/*
 *   loopa.nu/api/butik/*
 *   loopa.nu/api/efterlysning/*
 *   loopa.nu/api/cards/*
 *   loopa.nu/api/analys*
 *   loopa.nu/api/session*
 *
 * VARFÖR API-VÄGARNA RÄKNAS UPP EN OCH EN. Marknadssajten har egna funktioner på /api/chat,
 * /api/generate-listing, /api/brand-preview och /api/seller/*. Bands workern till hela /api/*
 * hade de slutat fungera. Listan ovan är precis de vägar butikssidorna och efterlysningsväggen
 * anropar — inget mer, och inget av säljverktygets (/api/jobs, /api/price, /api/admin), som ska
 * fortsätta bo på app.loopa.nu.
 *
 * /c/ STÅR MEDVETET INTE HÄR. Publicerade Tradera-annonser bär sanningskortets adress inbakad i
 * annonstexten, och den pekar på app.loopa.nu. Den adressen ska fortsätta svara där den står.
 *
 * ORDNINGEN EFTERÅT SPELAR ROLL:
 *   1. Lägg upp workern och rutterna.
 *   2. Prova loopa.nu/butik — den ska visa butiken.
 *   3. FÖRST DÄREFTER: sätt LOOPA_PUBLIC_URL=https://loopa.nu i server/.env och starta om.
 * Görs 3 före 1 börjar servern omdirigera butiken till en adress som ännu inte fungerar.
 */

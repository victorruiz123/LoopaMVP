// ─── Kontaktbrevet till Massproductions ─────────────────────────────────────
//
// Säljs en möbel som säljaren valt credits för ska vår kontakt på Massproductions få säljarens namn
// och e-post. Telefonnumret ingår inte. Brevet går vid försäljningen, inte vid "Sälj med Loopa".
// Inget i den här filen skickar något brev på riktigt. Den skarpa vägen (nodemailer → SMTP) provas mot
// en SMTP-server som startas lokalt här och bara sparar det den tar emot.
//
// Fyra saker måste hålla:
//   1. Brevet når rätt adress och innehåller rätt uppgifter.
//   2. Magnus får aldrig två brev om samma möbel.
//   3. Ett brev som inte går fram larmar admin, försöks igen och syns i kontrollen.
//   4. Den skarpa SMTP-vägen fungerar från början till slut.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const rot = await mkdtemp(path.join(tmpdir(), "loopa-mpk-"));
process.env.LOOPA_JOBS_DIR = path.join(rot, "jobs");
process.env.EMAIL_PROVIDER = "none";
delete process.env.MASSPRODUCTIONS_KONTAKT_EPOST;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const k = await import("../server/src/massproductionsKontakt.js");

const MAGNUS = "magnus.eleback@massproductions.se";
const ANNA = { namn: "Anna Svensson", epost: "anna@exempel.se", telefon: "070-123 45 67" };
const NU = new Date("2026-11-15T12:00:00Z");

async function nyKatalog(): Promise<void> {
  process.env.MP_KONTAKT_DIR = await mkdtemp(path.join(tmpdir(), "loopa-mpk-data-"));
  k.nollstall();
}

function val(jobId = "job-1") {
  return { userId: "user-anna", jobId, loopaId: "LP-1234", titel: "Pinocchio Sofa", mobelprisSek: 5000, credits: 5500 };
}

/** Falska beroenden: inget nätverk, och allt som "skickas" eller "larmas" sparas för att läsas. */
function falska(opts: { skicka?: (b: k.Kontaktbrev) => Promise<{ messageId: string | null; accepted: string[]; rejected: string[] }> } = {}) {
  const skickade: k.Kontaktbrev[] = [];
  const larm: Array<{ subject: string; body: string }> = [];
  k.anvandBeroenden({
    hamtaKontakt: async () => ({ ...ANNA }),
    skicka:
      opts.skicka ??
      (async (b) => {
        skickade.push(b);
        return { messageId: "<id@loopa>", accepted: [b.to], rejected: [] };
      }),
    larma: async (subject, body) => {
      larm.push({ subject, body });
    },
    nu: () => NU,
  });
  return { skickade, larm };
}

// ---------------------------------------------------------------------------
// 1. Brevet
// ---------------------------------------------------------------------------

test("brevet går till Magnus och innehåller namn och e-post — men inget telefonnummer", () => {
  const b = k.byggKontaktbrev({ loopaId: "LP-1234", titel: "Pinocchio Sofa", mobelprisSek: 5000, credits: 5500, saljare: ANNA });
  assert.equal(b.to, MAGNUS);
  assert.equal(b.replyTo, "anna@exempel.se", "svar ska gå direkt till säljaren");
  assert.match(b.subject, /Anna Svensson/);
  const text = b.text.replace(/\u00a0/g, " ");
  for (const del of ["Anna Svensson", "anna@exempel.se", "Pinocchio Sofa", "LP-1234", "5 500", "5 000 kr", "har sålt"]) {
    assert.ok(text.includes(del), `brevet saknar "${del}"`);
  }
  assert.ok(!/Telefon/i.test(text) && !text.includes("070-123 45 67"), "telefonnumret ska inte stå i brevet");
});

test("namnet säljaren skrev vid valet går före kontots namn", async () => {
  await nyKatalog();
  const { skickade } = falska();
  await k.kontaktVidCreditsVal({ ...val("job-namn"), namn: "Bertil Berg" });
  assert.match(skickade[0].text, /Namn: +Bertil Berg/);
  assert.match(skickade[0].subject, /Bertil Berg/);
});

test("standardmottagaren är Magnus; MASSPRODUCTIONS_KONTAKT_EPOST pekar om", () => {
  assert.equal(k.kontaktAdress(), MAGNUS);
  process.env.MASSPRODUCTIONS_KONTAKT_EPOST = "prov@loopa.se";
  try {
    assert.equal(k.kontaktAdress(), "prov@loopa.se");
  } finally {
    delete process.env.MASSPRODUCTIONS_KONTAKT_EPOST;
  }
});

test("ett fält som saknas står som 'saknas', inte som en tom rad; utan e-post inget Reply-To", () => {
  const b = k.byggKontaktbrev({ loopaId: "LP-1", titel: "Stol", mobelprisSek: 100, credits: 110, saljare: { namn: null, epost: null, telefon: "0701" } });
  assert.match(b.text, /Namn: +saknas/);
  assert.match(b.text, /E-post: +saknas/);
  assert.equal(b.replyTo, undefined);
});

// ---------------------------------------------------------------------------
// 2. Ett brev per möbel
// ---------------------------------------------------------------------------

test("credits-val skickar ETT brev; ett nytt tryck för samma möbel skickar inget mer", async () => {
  await nyKatalog();
  const { skickade, larm } = falska();
  const post = await k.kontaktVidCreditsVal(val());
  assert.equal(post.status, "skickat");
  assert.equal(post.messageId, "<id@loopa>");
  assert.equal(skickade.length, 1);
  assert.equal(skickade[0].to, MAGNUS);

  const igen = await k.kontaktVidCreditsVal(val());
  assert.equal(igen.status, "skickat");
  assert.equal(skickade.length, 1, "Magnus fick ett andra brev om samma möbel");
  assert.equal((await k.skickaOm()).length, 0, "svepet ska inte röra ett brev som gått fram");
  assert.equal(larm.length, 0);
});

test("två olika möbler ger två brev", async () => {
  await nyKatalog();
  const { skickade } = falska();
  await k.kontaktVidCreditsVal(val("job-a"));
  await k.kontaktVidCreditsVal(val("job-b"));
  assert.equal(skickade.length, 2);
});

// ---------------------------------------------------------------------------
// 3. När det inte går
// ---------------------------------------------------------------------------

test("brevet föll: admin larmas EN gång, svepet försöker igen, och admin får veta när det gick fram", async () => {
  await nyKatalog();
  let gar = false;
  const { larm } = falska({
    skicka: async (b) => {
      if (!gar) throw Object.assign(new Error("451 4.7.1 Too many mails"), { responseCode: 451 });
      return { messageId: "<ok>", accepted: [b.to], rejected: [] };
    },
  });

  const forst = await k.kontaktVidCreditsVal(val());
  assert.equal(forst.status, "misslyckat");
  assert.match(forst.senasteFel ?? "", /Too many mails/);
  assert.equal(larm.length, 1);
  assert.match(larm[0].subject, /FEL: brevet till Massproductions/);
  assert.match(larm[0].body, /Too many mails/);

  await k.skickaOm(); // fortfarande fel
  assert.equal(larm.length, 1, "inget nytt larm för varje försök");

  gar = true;
  const [klar] = await k.skickaOm();
  assert.equal(klar.status, "skickat");
  assert.equal(klar.forsok, 3);
  assert.equal(larm.length, 2);
  assert.match(larm[1].subject, /gick fram/);
});

test("en mottagare som SMTP-servern avvisar räknas som fel, inte som skickat", async () => {
  await nyKatalog();
  const { larm } = falska({ skicka: async (b) => ({ messageId: "<x>", accepted: [], rejected: [b.to] }) });
  const post = await k.kontaktVidCreditsVal(val());
  assert.equal(post.status, "misslyckat");
  assert.match(post.senasteFel ?? "", /avvisad/);
  assert.equal(larm.length, 1);
});

test("efter MAX_FORSOK ger vi upp och larmar en sista gång; --skicka-om tar dem igen", async () => {
  await nyKatalog();
  const { larm } = falska({
    skicka: async () => {
      throw new Error("535 Authentication failed");
    },
  });
  await k.kontaktVidCreditsVal(val());
  for (let i = 1; i < k.MAX_FORSOK; i++) await k.skickaOm();
  const [post] = await k.listaPoster();
  assert.equal(post.status, "gav-upp");
  assert.equal(post.forsok, k.MAX_FORSOK);
  assert.equal(larm.length, 2);
  assert.match(larm[1].subject, /GAV UPP/);
  assert.equal((await k.skickaOm()).length, 0, "svepet slutar försöka");

  // Felet rättat för hand: alla gav-upp provas igen.
  falska();
  const [igen] = await k.skickaOm({ alla: true });
  assert.equal(igen.status, "skickat");
});

test("säljare utan e-post: fel och larm, inget halvtomt brev till Magnus", async () => {
  await nyKatalog();
  const { skickade, larm } = falska();
  k.anvandBeroenden({
    hamtaKontakt: async () => ({ namn: "Anna", epost: null, telefon: null }),
    skicka: async (b) => (skickade.push(b), { messageId: null, accepted: [b.to], rejected: [] }),
    larma: async (subject, body) => void larm.push({ subject, body }),
    nu: () => NU,
  });
  const post = await k.kontaktVidCreditsVal(val());
  assert.equal(post.status, "misslyckat");
  assert.equal(skickade.length, 0);
  assert.equal(larm.length, 1);
});

test("larmet kastar: posten står ändå som misslyckat och larmas igen vid nästa försök", async () => {
  await nyKatalog();
  k.anvandBeroenden({
    hamtaKontakt: async () => ({ ...ANNA }),
    skicka: async () => {
      throw new Error("nere");
    },
    larma: async () => {
      throw new Error("larmet också nere");
    },
    nu: () => NU,
  });
  const post = await k.kontaktVidCreditsVal(val());
  assert.equal(post.status, "misslyckat");
  assert.equal((await k.listaPoster())[0].larmatAt, null);
});

// ---------------------------------------------------------------------------
// Kontrollen
// ---------------------------------------------------------------------------

test("kontrollen: fel när ett brev inte gått fram, ok när alla gått fram, fel när inloggningen nekas", async () => {
  await nyKatalog();
  falska({
    skicka: async () => {
      throw new Error("nere");
    },
  });
  await k.kontaktVidCreditsVal(val());
  let [inl, brev] = await k.kontrollera(async () => {}, NU);
  assert.equal(inl.utfall, "ok");
  assert.match(inl.text, /Inget brev skickades/);
  assert.equal(brev.utfall, "fel");
  assert.match(brev.text, /LP-1234/);

  falska();
  await k.skickaOm();
  [inl, brev] = await k.kontrollera(async () => {
    throw new Error("535 Authentication failed");
  }, NU);
  assert.equal(inl.utfall, "fel");
  assert.match(inl.text, /535/);
  assert.equal(brev.utfall, "ok");
});

test("kontrollen utan SMTP-uppgifter är fel, inte grön", async () => {
  await nyKatalog();
  const [inl] = await k.kontrollera(undefined, NU);
  assert.equal(inl.utfall, "fel");
  assert.match(inl.text, /SMTP_USER och SMTP_PASS saknas/);
});

test("ett brev som fastnat på 'vantar' (omstart mitt i) blir en varning och provas igen", () => {
  const p: k.KontaktPost = {
    ...val(),
    till: MAGNUS,
    status: "vantar",
    forsok: 0,
    senasteFel: null,
    skapad: "2026-11-15T11:00:00Z",
    senastForsok: null,
    skickadAt: null,
    messageId: null,
    larmatAt: null,
  };
  assert.equal(k.behoverForsok(p, NU), true);
  assert.equal(k.bedomPoster([p], NU).utfall, "varning");
  assert.equal(k.behoverForsok({ ...p, skapad: NU.toISOString() }, NU), false, "nyss skapad: låt försöket bli klart");
});

// ---------------------------------------------------------------------------
// 4. Den skarpa vägen, mot en lokal SMTP-server
// ---------------------------------------------------------------------------

interface Mottaget {
  auth: string | null;
  from: string | null;
  rcpt: string[];
  data: string;
}

/**
 * En SMTP-server på localhost som bara sparar det den tar emot. Den räcker för nodemailer: EHLO, AUTH
 * PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT. `avvisa` ger 550 på den adressen, som en riktig server gör med
 * en okänd mottagare.
 */
async function lokalSmtp(opts: { avvisa?: string; nekaInloggning?: boolean } = {}): Promise<{ port: number; brev: Mottaget[]; stang: () => Promise<void> }> {
  const brev: Mottaget[] = [];
  const server: Server = createServer((sock: Socket) => {
    let aktuellt: Mottaget = { auth: null, from: null, rcpt: [], data: "" };
    let iData = false;
    let authSteg = 0;
    let buf = "";
    const svara = (r: string) => sock.write(r + "\r\n");
    svara("220 lokal ESMTP");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const rad = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (iData) {
          if (rad === ".") {
            iData = false;
            brev.push(aktuellt);
            aktuellt = { auth: aktuellt.auth, from: null, rcpt: [], data: "" };
            svara("250 OK: queued as LOKAL1");
          } else aktuellt.data += (rad.startsWith("..") ? rad.slice(1) : rad) + "\n";
          continue;
        }
        if (authSteg > 0) {
          authSteg = authSteg === 1 ? 2 : 0;
          if (authSteg === 2) svara("334 UGFzc3dvcmQ6");
          else svara(opts.nekaInloggning ? "535 5.7.8 Authentication failed" : "235 Authentication successful");
          continue;
        }
        const kmd = rad.toUpperCase();
        if (kmd.startsWith("EHLO")) sock.write("250-lokal\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (kmd.startsWith("HELO")) svara("250 lokal");
        else if (kmd.startsWith("AUTH PLAIN")) {
          aktuellt.auth = Buffer.from(rad.split(" ")[2] ?? "", "base64").toString("utf8").split("\0")[1] ?? null;
          svara(opts.nekaInloggning ? "535 5.7.8 Authentication failed" : "235 Authentication successful");
        } else if (kmd.startsWith("AUTH LOGIN")) {
          authSteg = 1;
          svara("334 VXNlcm5hbWU6");
        } else if (kmd.startsWith("MAIL FROM:")) {
          aktuellt.from = rad.slice(10).replace(/[<>]/g, "").split(" ")[0];
          svara("250 OK");
        } else if (kmd.startsWith("RCPT TO:")) {
          const till = rad.slice(8).replace(/[<>]/g, "").split(" ")[0];
          if (opts.avvisa && till.toLowerCase() === opts.avvisa.toLowerCase()) svara("550 5.1.1 User unknown");
          else {
            aktuellt.rcpt.push(till);
            svara("250 OK");
          }
        } else if (kmd === "DATA") {
          iData = true;
          svara("354 End data with <CR><LF>.<CR><LF>");
        } else if (kmd === "RSET") {
          aktuellt = { auth: aktuellt.auth, from: null, rcpt: [], data: "" };
          svara("250 OK");
        } else if (kmd === "NOOP") svara("250 OK");
        else if (kmd === "QUIT") {
          svara("221 Bye");
          sock.end();
        } else svara("502 Command not implemented");
      }
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, brev, stang: () => new Promise((r) => server.close(() => r())) };
}

async function medSmtp<T>(port: number, f: () => Promise<T>): Promise<T> {
  const fore = { ...process.env };
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(port),
    SMTP_USER: "hej@loopa.se",
    SMTP_PASS: "hemligt",
    SMTP_FROM: "Loopa <hej@loopa.se>",
  });
  try {
    return await f();
  } finally {
    for (const n of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) {
      if (fore[n] === undefined) delete process.env[n];
      else process.env[n] = fore[n];
    }
  }
}

test("SKARPA VÄGEN: brevet går genom nodemailer och SMTP till Magnus, med rätt rubriker och innehåll", async () => {
  await nyKatalog();
  const smtp = await lokalSmtp();
  try {
    // Bara Supabase-uppslaget och larmet är falska. Skickandet är det riktiga.
    const larm: string[] = [];
    k.anvandBeroenden(null);
    k.anvandBeroenden({ hamtaKontakt: async () => ({ ...ANNA }), larma: async (s) => void larm.push(s), nu: () => NU });

    const post = await medSmtp(smtp.port, () => k.kontaktVidCreditsVal(val()));

    assert.equal(post.status, "skickat", post.senasteFel ?? "");
    assert.equal(larm.length, 0);
    assert.equal(smtp.brev.length, 1);
    const [m] = smtp.brev;
    assert.equal(m.auth, "hej@loopa.se", "inloggad med SMTP_USER");
    assert.equal(m.from, "hej@loopa.se");
    assert.deepEqual(m.rcpt, [MAGNUS], "brevet gick till Magnus och ingen annan");

    // Rubrikerna som Magnus mejlprogram läser. Ämnet är MIME-kodat (åäö), så det avkodas först.
    const rubriker = m.data.split("\n\n")[0].replace(/\n[ \t]+/g, " ");
    assert.match(rubriker, /^To: magnus\.eleback@massproductions\.se$/m);
    assert.match(rubriker, /^Reply-To: anna@exempel\.se$/m);
    assert.match(rubriker, /^From: Loopa <hej@loopa\.se>$/m);
    assert.match(rubriker, /^X-Loopa-Kind: massproductions-kontakt$/m);
    const amne = /^Subject: (.*)$/m.exec(rubriker)?.[1] ?? "";
    const avkodat = amne.replace(/=\?utf-8\?([BQ])\?([^?]*)\?=\s*/gi, (_, typ: string, t: string) =>
      typ.toUpperCase() === "B" ? Buffer.from(t, "base64").toString("utf8") : decodeURIComponent(t.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, "%$1")),
    );
    assert.match(avkodat, /credits till Anna Svensson/);

    // Kroppen: quoted-printable eller 8bit. Avkoda mjukt och leta efter uppgifterna.
    const kropp = m.data
      .slice(m.data.indexOf("\n\n") + 2)
      .replace(/=\n/g, "")
      .replace(/(=[0-9A-F]{2})+/gi, (s) => Buffer.from(s.split("=").filter(Boolean).map((h) => parseInt(h, 16))).toString("utf8"));
    for (const del of ["Anna Svensson", "anna@exempel.se", "LP-1234", "Pinocchio Sofa"]) {
      assert.ok(kropp.includes(del), `kroppen saknar "${del}"`);
    }
  } finally {
    await smtp.stang();
  }
});

test("SKARPA VÄGEN: SMTP-servern avvisar Magnus adress → misslyckat och larm", async () => {
  await nyKatalog();
  const smtp = await lokalSmtp({ avvisa: MAGNUS });
  try {
    const larm: string[] = [];
    k.anvandBeroenden(null);
    k.anvandBeroenden({ hamtaKontakt: async () => ({ ...ANNA }), larma: async (s) => void larm.push(s), nu: () => NU });
    const post = await medSmtp(smtp.port, () => k.kontaktVidCreditsVal(val()));
    assert.equal(post.status, "misslyckat");
    assert.match(post.senasteFel ?? "", /550|User unknown|avvisad|recipients/i);
    assert.equal(larm.length, 1);
    assert.equal(smtp.brev.length, 0);
  } finally {
    await smtp.stang();
  }
});

test("SKARPA VÄGEN: inloggningskontrollen loggar in utan att skicka något, och ser ett nekat lösenord", async () => {
  await nyKatalog();
  const bra = await lokalSmtp();
  const dalig = await lokalSmtp({ nekaInloggning: true });
  try {
    const [ok] = await medSmtp(bra.port, () => k.kontrollera(undefined, NU));
    assert.equal(ok.utfall, "ok", ok.text);
    assert.equal(bra.brev.length, 0, "kontrollen får aldrig skicka ett brev");

    const [fel] = await medSmtp(dalig.port, () => k.kontrollera(undefined, NU));
    assert.equal(fel.utfall, "fel");
    assert.match(fel.text, /535|Authentication|Invalid login/i);
  } finally {
    await bra.stang();
    await dalig.stang();
    k.anvandBeroenden(null);
  }
});

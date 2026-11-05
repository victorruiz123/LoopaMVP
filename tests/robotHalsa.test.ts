// ─── Robotarnas hälsokontroll ────────────────────────────────────────────────
//
// Kontrollen ska säga sanningen om robotarna en gång om dagen, och fyra saker måste hålla — alla
// prövade utan webbläsare, för det är bedömningen och schemat som är farliga, inte Chromium:
//
// DATAN FÅNGAR DET SESSIONEN INTE SER. En publicering som föll senaste dygnet, en som fastnat, en
// annons som tagits ner för omläggning och aldrig kom upp — fel även när inloggningen gäller.
//
// GAMLA FEL ÄR INTE NYA. Ett fel från förra veckan larmar inte i dag; torrkörningar är inga fel.
//
// BREVET GÅR NÄR NÅGOT INTE ÄR GRÖNT, och en gång till när det blivit grönt igen. Inte varje dag.
//
// SCHEMAT FÖLJER SVENSK TID och kör en gång per dag, även över omstarter.

import { test } from "node:test";
import assert from "node:assert/strict";

const { arDags, bedomFacebook, bedomKanal, bedomStatistik, brevFor, korRobotHalsa, sammanvag, skaMejla } = await import("../server/src/robotHalsa.js");
import type { Kontroll, RobotRapport } from "../server/src/robotHalsa.js";
import type { ConditionJob } from "../server/src/types.js";

const NU = new Date("2026-10-29T06:00:00.000Z");
const timmarSedan = (h: number) => new Date(NU.getTime() - h * 3_600_000).toISOString();

function jobb(id: string, falt: Partial<ConditionJob>): ConditionJob {
  return { id, ...falt } as ConditionJob;
}

function utfallFor(kontroller: Kontroll[], namn: string) {
  return kontroller.find((k) => k.namn === namn)?.utfall;
}

test("utan fel i datan är allt grönt, och senaste publiceringen står med", () => {
  const k = bedomKanal("blocket", [jobb("a", { blocket: { status: "published", publishedAt: timmarSedan(5), startedAt: timmarSedan(5) } as never })], NU);
  assert.equal(sammanvag(k.map((x) => x.utfall)), "ok");
  assert.notEqual(k.find((x) => x.namn === "Senast publicerad")?.text, "Ingen annons publicerad ännu.");
});

test("en publicering som föll senaste dygnet är ett fel, med jobbet och felet i texten", () => {
  const k = bedomKanal("tradera", [jobb("j1", { tradera: { status: "error", error: "Tradera svarade 401", startedAt: timmarSedan(3) } as never })], NU);
  assert.equal(utfallFor(k, "Publiceringar"), "fel");
  assert.match(k[0].text, /j1: Tradera svarade 401/);
});

test("ett fel från förra veckan larmar inte i dag", () => {
  const k = bedomKanal("tradera", [jobb("j1", { tradera: { status: "error", error: "gammalt", startedAt: timmarSedan(24 * 7) } as never })], NU);
  assert.equal(utfallFor(k, "Publiceringar"), "ok");
});

test("en torrkörning är inget fel", () => {
  const k = bedomKanal("blocket", [jobb("j1", { blocket: { status: "dry-run", dryRun: true, startedAt: timmarSedan(1) } as never })], NU);
  assert.equal(sammanvag(k.map((x) => x.utfall)), "ok");
});

test("en körning som stått på publishing i över två timmar har fastnat", () => {
  const fast = bedomKanal("blocket", [jobb("j1", { blocket: { status: "publishing", startedAt: timmarSedan(3) } as never })], NU);
  const pagar = bedomKanal("blocket", [jobb("j2", { blocket: { status: "publishing", startedAt: timmarSedan(0.5) } as never })], NU);
  assert.equal(utfallFor(fast, "Fastnade körningar"), "fel");
  assert.equal(utfallFor(pagar, "Fastnade körningar"), "ok", "en pågående körning är inte fastnad");
});

test("en annons nere för omläggning i över ett dygn är ett fel — men inte om den gamla fick ligga kvar", () => {
  const nere = jobb("j1", { priceLadder: { omlaggning: { blocket: { nedtagenAt: timmarSedan(30), fel: "rubrikvakten stoppade" } } } as never });
  const kvar = jobb("j2", { priceLadder: { omlaggning: { blocket: { nedtagenAt: timmarSedan(30), gamlaKvar: true } } } as never });
  const farsk = jobb("j3", { priceLadder: { omlaggning: { blocket: { nedtagenAt: timmarSedan(2) } } } as never });
  assert.equal(utfallFor(bedomKanal("blocket", [nere], NU), "Omläggningar"), "fel");
  assert.match(bedomKanal("blocket", [nere], NU)[2].text, /rubrikvakten stoppade/);
  assert.equal(utfallFor(bedomKanal("blocket", [kvar], NU), "Omläggningar"), "ok", "möbeln är ute via den gamla annonsen");
  assert.equal(utfallFor(bedomKanal("blocket", [farsk], NU), "Omläggningar"), "ok", "omläggningen hinner försöka igen");
  assert.equal(utfallFor(bedomKanal("tradera", [nere], NU), "Omläggningar"), "ok", "kanalerna blandas inte");
});

test("Facebook: färska fel är fel, öppna åtgärder och en stillastående kö är varningar", () => {
  const k = bedomFacebook(
    {
      marketplace: [{ listingId: "LP1", status: "FAILED", updatedAt: timmarSedan(2), failureReason: "Publicera-knappen hittades inte", queuedAt: timmarSedan(3) } as never],
      grupper: [{ listingId: "LP2", groupId: "g1", status: "QUEUED", queuedAt: timmarSedan(40), attemptedAt: null } as never],
      atgarder: [
        { kind: "CHECKPOINT", reason: "Facebook vill verifiera kontot", resolvedAt: null } as never,
        { kind: "OTHER", reason: "löst", resolvedAt: timmarSedan(1) } as never,
      ],
    },
    NU,
  );
  assert.equal(utfallFor(k, "Publiceringar"), "fel");
  assert.match(k[0].text, /Publicera-knappen hittades inte/);
  assert.equal(utfallFor(k, "Kräver en människa"), "varning");
  assert.match(k[1].text, /^1 öppna/, "lösta åtgärder räknas inte");
  assert.equal(utfallFor(k, "Kön"), "varning");
});

test("sammanvägningen: värsta vinner, och bara avstängt blir av", () => {
  assert.equal(sammanvag(["ok", "varning", "av"]), "varning");
  assert.equal(sammanvag(["ok", "fel", "varning"]), "fel");
  assert.equal(sammanvag(["av", "av"]), "av");
  assert.equal(sammanvag(["av", "ok"]), "ok");
});

function rapport(utfall: RobotRapport["utfall"]): RobotRapport {
  return { kordAt: NU.toISOString(), sekunder: 1, utfall, robotar: [] };
}

test("brevet går vid fel och varning, vid återhämtning, och annars inte", () => {
  assert.equal(skaMejla(rapport("fel"), null), true);
  assert.equal(skaMejla(rapport("varning"), rapport("varning")), true, "ett kvarstående fel påminns om en gång per dag");
  assert.equal(skaMejla(rapport("ok"), rapport("fel")), true, "återhämtningen meddelas");
  assert.equal(skaMejla(rapport("ok"), rapport("ok")), false);
  assert.equal(skaMejla(rapport("ok"), null), false);
  assert.equal(skaMejla(rapport("ok"), rapport("ok"), true), true, "ROBOT_HALSA_BREV=alltid");
});

test("brevets ämne räknar fel och varningar, och felen står först", () => {
  const r: RobotRapport = {
    ...rapport("fel"),
    robotar: [
      {
        robot: "blocket",
        utfall: "fel",
        kontroller: [
          { namn: "Senast publicerad", utfall: "ok", text: "i går" },
          { namn: "Inloggningen", utfall: "fel", text: "Sessionen gäller inte" },
          { namn: "Kön", utfall: "varning", text: "står still" },
        ],
      },
    ],
  };
  const { subject, body } = brevFor(r);
  assert.equal(subject, "Robotarna: 1 fel, 1 varning");
  assert.ok(body.indexOf("Inloggningen") < body.indexOf("Kön") && body.indexOf("Kön") < body.indexOf("Senast"));
  assert.equal(brevFor(rapport("ok")).subject, "Robotarna: allt fungerar igen");
});

test("schemat: efter klockslaget i svensk tid, en gång per dag", () => {
  // 06:00Z = 07:00 i Stockholm vintertid (29 oktober 2026, efter omställningen).
  assert.equal(arDags(new Date("2026-10-29T05:59:00Z"), "07:00", null), false, "före sju");
  assert.equal(arDags(new Date("2026-10-29T06:00:00Z"), "07:00", null), true);
  assert.equal(arDags(new Date("2026-10-29T12:00:00Z"), "07:00", "2026-10-29T06:01:00Z"), false, "redan körd i dag");
  assert.equal(arDags(new Date("2026-10-29T12:00:00Z"), "07:00", "2026-10-28T06:01:00Z"), true, "omstart efter sju kör ikapp");
  // 23:30Z den 28:e är redan den 29:e i Stockholm — dagen räknas i svensk tid, inte UTC.
  assert.equal(arDags(new Date("2026-10-29T06:30:00Z"), "07:00", "2026-10-28T23:30:00Z"), false);
});

test("ett helt varv: prövningarna körs, en som kastar blir ett fel, och avstängd Facebook läser ingen data", async () => {
  let fbLast = false;
  const r = await korRobotHalsa({
    jobb: async () => [],
    blocketSession: async () => ({ namn: "Inloggningen", utfall: "ok", text: "Sessionen gäller." }),
    traderaApi: async () => {
      throw new Error("nätverket");
    },
    traderaInkorg: async () => ({ namn: "Inkorgen", utfall: "av", text: "ingen session" }),
    traderaPost: async () => ({ namn: "Gmail-bevakaren", utfall: "ok", text: "läste nyss" }),
    facebookSession: async () => ({ namn: "Inloggningen", utfall: "av", text: "av" }),
    facebookUnderlag: async () => {
      fbLast = true;
      return { marketplace: [], grupper: [], atgarder: [] };
    },
    statistikSvep: async () => ({ svep: null, timmar: 3 }),
    nu: () => NU,
  });
  assert.equal(r.utfall, "fel");
  const tradera = r.robotar.find((b) => b.robot === "tradera")!;
  assert.equal(tradera.utfall, "fel");
  assert.match(tradera.kontroller[0].text, /Kontrollen själv föll: nätverket/);
  assert.equal(r.robotar.find((b) => b.robot === "blocket")!.utfall, "ok");
  const fb = r.robotar.find((b) => b.robot === "facebook")!;
  assert.equal(fb.utfall, "av");
  assert.equal(fb.kontroller.length, 1);
  assert.equal(fbLast, false);
});

test("säljarnas statistik: föll, gammalt svep och avstängt syns; ett färskt svep är grönt", () => {
  const svep = (h: number, tradera: "klar" | "fel" | "av", blocket: "klar" | "senare" = "klar") => ({
    at: timmarSedan(h),
    tradera: { status: tradera, lasta: 3, detalj: tradera === "fel" ? "Tradera-sessionen har gått ut." : "23 annonser i Traderas lista, 3 möbler bokförda." },
    blocket: { status: blocket, lasta: 2, detalj: "2 av 2 Blocket-annonser lästa." },
  });
  assert.equal(bedomStatistik("tradera", svep(1, "klar"), 3, NU).utfall, "ok");
  assert.equal(bedomStatistik("tradera", svep(1, "fel"), 3, NU).utfall, "fel");
  assert.match(bedomStatistik("tradera", svep(1, "fel"), 3, NU).text, /sessionen har gått ut/);
  assert.equal(bedomStatistik("blocket", svep(10, "klar"), 3, NU).utfall, "fel", "tre missade svep i rad");
  assert.equal(bedomStatistik("blocket", svep(1, "klar", "senare"), 3, NU).utfall, "ok", "ett svep som lämnade plats åt en publicering är inget fel");
  assert.equal(bedomStatistik("tradera", svep(1, "av"), 3, NU).utfall, "av");
  assert.equal(bedomStatistik("tradera", null, 3, NU).utfall, "ok", "servern har nyss startat");
  assert.equal(bedomStatistik("tradera", svep(100, "fel"), 0, NU).utfall, "av", "svepet avstängt");
});

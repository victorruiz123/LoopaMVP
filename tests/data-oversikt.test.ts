// ─── data/oversikt: hur det går för Loopa ────────────────────────────────────
//
// Översikten är det första en admin läser. Räknar den fel är felet TYST: ett tal som ser rimligt ut.
// Testet vaktar de tre reglerna som är lättast att bryta — adminer räknas aldrig, förra perioden
// jämförs på rätt fönster, och en förra period som inte mättes blir null och inte en nolla.

import { test } from "node:test";
import assert from "node:assert/strict";

const { oversikt } = await import("../server/src/data/oversikt.js");

const NU = new Date("2026-10-20T12:00:00Z");
const dagarSedan = (d: number) => new Date(NU.getTime() - d * 86_400_000).toISOString();

function konto(id: string, signedUpAt: string | null, extra: Record<string, unknown> = {}) {
  return {
    id, email: `${id}@x.se`, name: id, avatarUrl: null, isAdmin: false, jobCount: 0, cardCount: 0,
    totalValue: 0, lastActivity: null, telefon: null, signedUpAt, signupApproximate: false, ...extra,
  };
}

test("översikten: nya konton, jämförelse, aktivering och att adminer inte räknas", () => {
  const svar = oversikt({
    konton: [
      konto("anna", dagarSedan(2), { jobCount: 1, cardCount: 1 }),
      konto("bo", dagarSedan(5), { jobCount: 1 }),
      konto("cia", dagarSedan(10)),
      konto("dan", dagarSedan(40)), // förra perioden
      konto("admin", dagarSedan(1), { isAdmin: true, jobCount: 3, cardCount: 3 }),
    ],
    jobb: [
      { ownerId: "anna", createdAt: dagarSedan(1), fardig: true },
      { ownerId: "bo", createdAt: dagarSedan(4), fardig: false },
      { ownerId: "admin", createdAt: dagarSedan(1), fardig: true },
    ],
    butiksLagen: ["live", "reserved", "sold", "draft"],
    ordrar: [
      { status: "paid", priceSek: 1200, createdAt: dagarSedan(3) },
      { status: "cancelled", priceSek: 900, createdAt: dagarSedan(3) },
      { status: "delivered", priceSek: 500, createdAt: dagarSedan(35) },
    ] as never,
    besok: [],
    floden: [],
    inbjudningar: [
      { id: "1", at: dagarSedan(2), event: "invite_link_copied", userId: "anna", referralCode: null, props: {} },
      { id: "2", at: dagarSedan(2), event: "referred_signup", userId: "bo", referralCode: null, props: {} },
    ],
    dagar: 30,
    nu: NU,
  });

  assert.equal(svar.konton.totalt, 4, "adminen är inget konto i översikten");
  assert.deepEqual(svar.konton.nya, { nu: 3, forra: 1 });
  assert.equal(svar.konton.nyaBorjade, 2);
  assert.equal(svar.konton.nyaMedAnnons, 1);
  assert.equal(svar.konton.medianDygnTillForstaAnnons, 1);
  // Ingen besöks- eller flödesmätning fanns förra perioden: ingen jämförelse, inte en nolla.
  assert.equal(svar.konton.aktiva.forra, null);
  assert.equal(svar.konton.aktiva.nu, 2);

  assert.deepEqual(svar.affar.kop, { nu: 1, forra: 1 });
  assert.deepEqual(svar.affar.varde, { nu: 1200, forra: 500 });
  assert.equal(svar.affar.uteNu, 2);
  assert.equal(svar.affar.nyaAnnonser.nu, 1, "adminens annons räknas inte");

  assert.equal(svar.inbjudningar.lankarDelade.nu, 1);
  assert.equal(svar.inbjudningar.registrerade.nu, 1);

  // Utan besök vet vi inte varifrån de kom.
  assert.deepEqual(svar.kanaler.map((k) => k.kanal), ["Okänd"]);
  assert.equal(svar.nyaKontonLista[0].id, "anna");
  assert.equal(svar.nyaKontonLista[0].status, "annons");
  assert.equal(svar.nyaKontonLista.find((r) => r.id === "cia")?.status, "inget");
  assert.equal(svar.perVecka.length, 12);
});

test("översikten: kohorter räknar bara kända datum, grupperna sorterar varje konto rätt", () => {
  const svar = oversikt({
    konton: [
      // Registrerad för 20 dagar sedan, första annonsen dagen efter, sedan en till.
      konto("eva", dagarSedan(20), { jobCount: 2, cardCount: 2 }),
      // Filmade men fick aldrig en annons.
      konto("fia", dagarSedan(20), { jobCount: 1 }),
      // Ny, inget gjort.
      konto("gun", dagarSedan(3)),
      // Gammal, aldrig gjort något.
      konto("hans", dagarSedan(60)),
      // Säljare som inte synts på länge.
      konto("ida", dagarSedan(90), { jobCount: 1, cardCount: 1 }),
      // Gissat datum: får inte ingå i någon kohort.
      konto("jon", dagarSedan(10), { signupApproximate: true, jobCount: 1, cardCount: 1 }),
    ],
    jobb: [
      { ownerId: "eva", createdAt: dagarSedan(19), fardig: true },
      { ownerId: "eva", createdAt: dagarSedan(5), fardig: true },
      { ownerId: "fia", createdAt: dagarSedan(19), fardig: false },
      { ownerId: "ida", createdAt: dagarSedan(80), fardig: true },
      { ownerId: "jon", createdAt: dagarSedan(10), fardig: true },
    ],
    butiksLagen: [],
    ordrar: [{ status: "paid", priceSek: 100, createdAt: dagarSedan(1) }] as never,
    besok: [],
    floden: [],
    inbjudningar: [],
    dagar: 30,
    nu: NU,
  });

  const grupp = (n: string) => svar.grupper.find((g) => g.nyckel === n)!.medlemmar.map((m) => m.id).sort();
  assert.deepEqual(grupp("aktiva"), ["eva", "jon"]);
  assert.deepEqual(grupp("fastnade"), ["fia"]);
  assert.deepEqual(grupp("nya"), ["gun"]);
  assert.deepEqual(grupp("aldrig"), ["hans"]);
  assert.deepEqual(grupp("sovande"), ["ida"]);

  assert.equal(svar.kohorterUtanDatum, 1);
  const k = svar.kohorter.find((r) => r.konton === 2)!;
  assert.ok(k, "eva och fia registrerades samma vecka");
  assert.deepEqual({ inom1: k.inom1, inom7: k.inom7, inom30: k.inom30, flera: k.flera }, { inom1: 1, inom7: 1, inom30: 1, flera: 1 });
  assert.equal(k.klar7, true);
  assert.equal(k.klar30, false, "en kohort som är 20 dagar gammal har inte haft 30 dagar på sig");
  assert.equal(svar.kohorter.reduce((n, r) => n + r.konton, 0), 3, "jon (gissat datum) och hans/ida (för gamla) ingår inte");

  const veckan = svar.perVecka.at(-1)!;
  assert.equal(veckan.salda, 1);
  assert.equal(svar.perVecka.reduce((n, v) => n + v.nyaSaljare, 0), 2, "eva och jon blev säljare inom tolv veckor, ida för länge sedan");
});

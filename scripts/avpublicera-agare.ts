/**
 * Tar en säljares möbler ur butiken.
 *
 *   npx tsx scripts/avpublicera-agare.ts nagon@exempel.se          # TORRKÖRNING — listar bara
 *   npx tsx scripts/avpublicera-agare.ts nagon@exempel.se --kor    # gör det på riktigt
 *
 * AVPUBLICERING, INTE RADERING. Möbeln går från `live` till `draft`: den försvinner ur rutnätet,
 * sökningen och kategorierna, men besiktningen, bildrutorna, annonstexten och det publika kortet
 * ligger kvar orörda. Ångrar man sig publicerar man om från adminpanelen. Det finns ingen väg i
 * koden som raderar ett jobb, och det här skriptet bygger ingen.
 *
 * TORRKÖRNING ÄR STANDARD, med flit. Skriptet körs i produktion mot ett konto man pekat ut med en
 * e-postadress — och e-post till ägar-id är en uppslagning som kan gå fel på ett sätt som inte syns
 * förrän en annan säljares lager är borta. Listan först, `--kor` sedan.
 *
 * BARA LIVE RÖRS. En möbel som är reserverad eller såld står mitt i någon annans affär, och att
 * dra undan den under en köpare är inte att städa upp ett lager. De räknas upp separat och lämnas
 * i fred.
 *
 * KRÄVER SUPABASE_SERVICE_ROLE_KEY. Ägaren står som ett Supabase-UUID på jobbet, aldrig som en
 * adress, så uppslagningen måste gå via Auth. Utan nyckeln vet skriptet inte vem någon är och
 * vägrar hellre än gissar.
 */

process.loadEnvFile(new URL("../server/.env", import.meta.url));

const { listJobs, ownerIdOf } = await import("../server/src/jobStore.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");
const { store, unpublish } = await import("../server/src/butik/store.js");
const { invalidate } = await import("../server/src/butik/inventory.js");
const { supabaseUrl } = await import("../server/src/supabaseAuth.js");

const argv = process.argv.slice(2);
const kor = argv.includes("--kor");
const epost = argv.find((a) => !a.startsWith("--"))?.trim().toLowerCase();

if (!epost) {
  console.error("Ange e-postadressen: npx tsx scripts/avpublicera-agare.ts nagon@exempel.se [--kor]");
  process.exit(1);
}

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!serviceKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY saknas i server/.env — utan den går e-post inte att slå upp.");
  process.exit(1);
}

/**
 * Ägar-id:t bakom adressen.
 *
 * Sidas igenom med tak, som adminpanelen gör: ett konto som ligger bortom taket är ett konto som
 * inte hittas, och det är ett bättre fel än en tyst halv lista. Jämförelsen är skiftlägesokänslig —
 * Auth lagrar adressen som den skrevs in.
 */
async function slaUppAgare(adress: string): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; page <= 20; page += 1) {
    const url = `${supabaseUrl()}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
    const res = await fetch(url, { headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` } });
    if (!res.ok) {
      console.error(`Auth svarade ${res.status} på sida ${page}.`);
      return null;
    }
    const body = (await res.json()) as { users?: Array<{ id?: string; email?: string | null }> };
    const users = body.users ?? [];
    const träff = users.find((u) => u.email?.trim().toLowerCase() === adress);
    if (träff?.id) return träff.id;
    if (users.length < perPage) return null;
  }
  return null;
}

const agarId = await slaUppAgare(epost);
if (!agarId) {
  console.error(`Hittade inget konto med adressen ${epost}.`);
  process.exit(1);
}
console.log(`${epost} → ${agarId}`);

/** Jobben ägaren står på, som Loopa-ID. Ett jobb utan ägare är inte hans — se ownerIdOf. */
const jobb = (await listJobs()).filter((j) => ownerIdOf(j) === agarId);
const mina = new Map(jobb.map((j) => [loopaIdFor(j.id), j]));
console.log(`${jobb.length} besiktigade jobb tillhör kontot.`);

const poster = (await store().all()).filter((r) => mina.has(r.id));
const live = poster.filter((r) => r.state === "live");
const ovriga = poster.filter((r) => r.state !== "live");

const namn = (id: string) => {
  const j = mina.get(id);
  const i = j?.identity ?? j?.selected ?? null;
  return [i?.brand, i?.model].filter(Boolean).join(" ") || "(namnlös)";
};

console.log(`\nLigger LIVE i butiken och skulle avpubliceras (${live.length}):`);
for (const r of live) console.log(`  ${r.id}  ${namn(r.id)}`);

if (ovriga.length) {
  console.log(`\nRörs INTE — mitt i en affär eller redan ute (${ovriga.length}):`);
  for (const r of ovriga) console.log(`  ${r.id}  ${r.state.padEnd(10)} ${namn(r.id)}`);
}

if (!kor) {
  console.log(`\nTorrkörning. Inget är ändrat. Lägg till --kor för att avpublicera de ${live.length} ovan.`);
  process.exit(0);
}

let gjorda = 0;
let missade = 0;
for (const r of live) {
  // Aktören är skriptet och inte en människa som tryckt på något. Huvudboken ska kunna läsas i
  // efterhand av någon som undrar varför trettio möbler försvann samma sekund.
  const efter = await unpublish(r.id, { kind: "system", job: `avpublicera-agare:${epost}` });
  if (efter) gjorda += 1;
  else {
    missade += 1;
    console.warn(`  ${r.id} kunde inte avpubliceras — tillståndet hann ändras.`);
  }
}

invalidate();
console.log(`\nAvpublicerade ${gjorda} möbler.${missade ? ` ${missade} missades.` : ""}`);

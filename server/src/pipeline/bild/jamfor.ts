/**
 * Benchmarken. Fyra modeller, samma bilder, en sida att titta på.
 *
 * VARFÖR DEN FINNS: modellvalet gick inte att göra på publicerade siffror. Varje
 * bakgrundsborttagningsmodell rapporterar sina mått på DIS5K eller COCO — datamängder fulla av
 * djur, människor och produkter mot rena bakgrunder. Loopa får mobilfoton av en soffa i ett stökigt
 * vardagsrum, och den enda mätning som betyder något är den på just de bilderna. De ligger redan i
 * server/data/jobs, tusen stycken, tagna av riktiga säljare.
 *
 * VAD DEN SKRIVER UT: en HTML-sida med fyra kolumner per bild — original, mask, transparent mot
 * rutmönster, och den färdiga vita produktbilden — plus varje mått från kvalitet.ts och tiden det
 * tog. Rutmönstret bakom den transparenta är inte pynt: det är det enda sättet att se en halvdålig
 * alfakanal. Mot vitt ser en kant som bär rummets färg nästan rätt ut.
 *
 * Körs via scripts/bild-bench.ts, som bara läser argumenten:
 *
 *   npx tsx scripts/bild-bench.ts                          # 10 bilder, alla modeller
 *   npx tsx scripts/bild-bench.ts --antal 20               # fler bilder
 *   npx tsx scripts/bild-bench.ts --modeller birefnet-general,isnet-general-use
 *   npx tsx scripts/bild-bench.ts --bild <sökväg>          # en utpekad bild, upprepas
 *   npx tsx scripts/bild-bench.ts --ut bench               # var sidan hamnar
 *
 * Kör med PRODUKTBILD_TRADAR=4 (eller antalet kärnor) — benchmarken har ingen server att vara
 * hänsynsfull mot.
 *
 * LIGGER I server/src OCH INTE I scripts/ av ett trist skäl som är värt en rad: ett skript i
 * scripts/ kan inte importera sharp eller onnxruntime, som bor i server/node_modules. Att flytta hit
 * har dessutom en poäng — jämförelsen kör exakt samma kod som driften, inte en kopia av den.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MODELLER } from "./modeller.js";
import { medModell, type Produktbild } from "./produktbild.js";
import { slappModeller } from "./segmentera.js";

const JOBB = path.resolve(import.meta.dirname, "..", "..", "..", "data", "jobs");

/** Vad benchmarken ska köra. Skriptet läser argumenten; modulen tar emot ett objekt. */
export interface Val {
  antal?: number;
  modeller?: string[];
  bild?: string | null;
  ut?: string;
}

/**
 * Testbilderna: en bildruta från varje av N OLIKA jobb, inte N bildrutor ur ett.
 *
 * Sex bildrutor ur samma inspelning är sex bilder av samma möbel i samma rum i samma ljus, och en
 * modell som klarar den ena klarar de andra. Det som ska mätas är spridningen — soffor, stolar med
 * tunna ben, bord, hyllor, möbler mot väggar i samma färg, stökiga rum — och den finns mellan
 * jobben.
 *
 * `img_2` med flit: de första bildrutorna i ett videovarv är ofta kameran innan den exponerat (mätt:
 * helt svart i fyra av 28 jobb), och de sista är närbilder på skador. Mitten är helbilden.
 */
async function valjBilder(antal: number, utpekad: string | null): Promise<string[]> {
  if (utpekad) return [utpekad];

  const jobb = (await readdir(JOBB, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  // Jämnt fördelat över hela listan i stället för de N första: jobbmapparna är sorterade på uuid,
  // men de N första är ändå N grannar, och en godtycklig granne till en soffa är ofta en soffa till.
  const steg = Math.max(1, Math.floor(jobb.length / antal));
  const ut: string[] = [];
  for (let i = 0; i < jobb.length && ut.length < antal; i += steg) {
    const dir = path.join(JOBB, jobb[i], "originals");
    try {
      const filer = (await readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
      if (filer.length === 0) continue;
      ut.push(path.join(dir, filer[Math.min(2, filer.length - 1)]));
    } catch {
      // Ett jobb utan bilder är inget fel — bara inget att mäta på.
    }
  }
  return ut;
}

/** En bild till en data-URI, nedskalad. Sidan ska gå att skicka som EN fil. */
async function uri(buf: Buffer, bredd = 380): Promise<string> {
  const liten = await sharp(buf).resize({ width: bredd, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  return `data:image/webp;base64,${liten.toString("base64")}`;
}

/** Transparent PNG mot rutmönster — annars går en dålig alfakanal inte att se. */
async function motRutor(png: Buffer, bredd = 380): Promise<string> {
  const skalad = await sharp(png).resize({ width: bredd, withoutEnlargement: true }).png().toBuffer();
  const { width = bredd, height = bredd } = await sharp(skalad).metadata();
  const ruta = 12;
  const bricka = await sharp({
    create: { width: ruta * 2, height: ruta * 2, channels: 3, background: { r: 222, g: 222, b: 226 } },
  })
    .composite([
      { input: await enfarg(ruta, { r: 255, g: 255, b: 255 }), left: 0, top: 0 },
      { input: await enfarg(ruta, { r: 255, g: 255, b: 255 }), left: ruta, top: ruta },
    ])
    .png()
    .toBuffer();
  const botten = await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: bricka, tile: true, blend: "over", left: 0, top: 0 }])
    .png()
    .toBuffer();
  const ut = await sharp(botten).composite([{ input: skalad }]).webp({ quality: 84 }).toBuffer();
  return `data:image/webp;base64,${ut.toString("base64")}`;
}

async function enfarg(sida: number, f: { r: number; g: number; b: number }): Promise<Buffer> {
  return await sharp({ create: { width: sida, height: sida, channels: 3, background: f } }).png().toBuffer();
}

interface Rad {
  bild: string;
  modell: string;
  res: Produktbild | null;
  ms: number;
}

export async function jamfor(val: Val = {}): Promise<void> {
  const antal = val.antal ?? 10;
  const valda = val.modeller?.length ? val.modeller : Object.keys(MODELLER);
  const utDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", val.ut ?? "bench");
  const bilder = await valjBilder(antal, val.bild ?? null);

  console.log(`${bilder.length} bilder × ${valda.length} modeller\n`);

  const rader: Rad[] = [];
  for (const bild of bilder) {
    const kort = path.basename(path.dirname(path.dirname(bild))).slice(0, 8) + "/" + path.basename(bild);
    for (const namn of valda) {
      const m = MODELLER[namn];
      if (!m) { console.log(`  okänd modell ${namn}`); continue; }
      const t0 = Date.now();
      let res: Produktbild | null = null;
      try {
        res = await medModell(bild, m);
      } catch (e) {
        console.log(`  ${kort} ${namn}: FEL ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      }
      const ms = Date.now() - t0;
      rader.push({ bild, modell: namn, res, ms });
      const k = res?.metadata.kvalitet;
      console.log(
        `  ${kort.padEnd(46)} ${namn.padEnd(20)} ${String(ms).padStart(6)} ms ` +
          (k
            ? `poäng=${k.poang.toFixed(2)} ${res?.needsReview ? "GRANSKA" : "ok     "} ${k.anmarkningar.map((a) => a.kod).join(",")}`
            : "INGEN BILD"),
      );
    }
  }

  await skrivRapport(rader, valda, utDir);
  await slappModeller();
}

/**
 * Sammanfattningen per modell.
 *
 * MEDIANTID OCH INTE MEDELTID: en enda bild som råkade köras medan modellen laddades drar upp ett
 * medelvärde med tiotals sekunder och gör två modeller ojämförbara. Medianen säger vad en bild
 * faktiskt kostar.
 */
function sammanfatta(rader: Rad[], modell: string) {
  const mina = rader.filter((r) => r.modell === modell);
  const lyckade = mina.filter((r) => r.res);
  const tider = mina.map((r) => r.ms).sort((a, b) => a - b);
  const median = tider.length ? tider[Math.floor(tider.length / 2)] : 0;
  const poang = lyckade.map((r) => r.res!.qualityScore);
  return {
    modell,
    bilder: mina.length,
    byggda: lyckade.length,
    granskning: lyckade.filter((r) => r.res!.needsReview).length,
    medianMs: median,
    medelpoang: poang.length ? poang.reduce((a, b) => a + b, 0) / poang.length : 0,
    medelBenforlust: snitt(lyckade.map((r) => r.res!.metadata.kvalitet.matt.benforlust)),
    medelBandandel: snitt(lyckade.map((r) => r.res!.metadata.kvalitet.matt.bandandel)),
    invariantbrott: lyckade.filter(
      (r) => r.res!.metadata.kvalitet.matt.fargdrift > 0 || r.res!.metadata.kvalitet.matt.inreOrord < 1,
    ).length,
  };
}

function snitt(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

async function skrivRapport(rader: Rad[], modeller: string[], utDir: string): Promise<void> {
  await mkdir(utDir, { recursive: true });

  const sammanfattning = modeller.map((m) => sammanfatta(rader, m));
  console.log("\n" + "=".repeat(104));
  console.log(
    "modell".padEnd(22) + "byggda".padStart(8) + "granska".padStart(9) + "median".padStart(9) +
    "poäng".padStart(8) + "benförl".padStart(9) + "band".padStart(8) + "invariantbrott".padStart(16),
  );
  for (const s of sammanfattning) {
    console.log(
      s.modell.padEnd(22) +
        `${s.byggda}/${s.bilder}`.padStart(8) +
        String(s.granskning).padStart(9) +
        `${(s.medianMs / 1000).toFixed(1)}s`.padStart(9) +
        s.medelpoang.toFixed(2).padStart(8) +
        s.medelBenforlust.toFixed(2).padStart(9) +
        s.medelBandandel.toFixed(2).padStart(8) +
        String(s.invariantbrott).padStart(16),
    );
  }
  console.log("=".repeat(104));

  const bilder = [...new Set(rader.map((r) => r.bild))];
  const delar: string[] = [];
  for (const bild of bilder) {
    const kort = path.basename(path.dirname(path.dirname(bild))).slice(0, 8) + " / " + path.basename(bild);
    const original = await uri(await sharp(bild).rotate().jpeg().toBuffer());
    const rutor: string[] = [];
    for (const modell of modeller) {
      const r = rader.find((x) => x.bild === bild && x.modell === modell);
      if (!r?.res) {
        rutor.push(`<div class="cell tom"><h4>${modell}</h4><p>ingen produktbild</p></div>`);
        continue;
      }
      const k = r.res.metadata.kvalitet;
      const flaggor = k.anmarkningar.map((a) => `<li>${a.kod}: ${a.text}</li>`).join("");
      rutor.push(`<div class="cell${r.res.needsReview ? " granska" : ""}">
        <h4>${modell} <span class="ms">${(r.ms / 1000).toFixed(1)}s</span> <span class="poang">${k.poang.toFixed(2)}</span></h4>
        <div class="trio">
          <figure><img src="${await uri(r.res.mask, 240)}" alt="mask"><figcaption>mask</figcaption></figure>
          <figure><img src="${await motRutor(r.res.transparent, 240)}" alt="transparent"><figcaption>transparent</figcaption></figure>
          <figure><img src="${await uri(r.res.processedImage, 240)}" alt="produktbild"><figcaption>vit</figcaption></figure>
        </div>
        <table>
          <tr><td>täckning</td><td>${k.matt.tackning.toFixed(3)}</td><td>beskuren</td><td>${k.matt.beskuren.toFixed(3)}</td></tr>
          <tr><td>band</td><td>${k.matt.bandandel.toFixed(3)}</td><td>fragment</td><td>${k.matt.fragment.toFixed(3)}</td></tr>
          <tr><td>benförlust</td><td>${k.matt.benforlust.toFixed(3)}</td><td>inre orörd</td><td>${(k.matt.inreOrord * 100).toFixed(2)}%</td></tr>
        </table>
        ${flaggor ? `<ul class="anm">${flaggor}</ul>` : ""}
      </div>`);
    }
    delar.push(`<section><h3>${kort}</h3><div class="rad"><div class="cell orig"><h4>original</h4><img src="${original}" alt="original"></div>${rutor.join("")}</div></section>`);
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Loopa produktbild — modelljämförelse</title>
<style>
 body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f6f5f2;color:#1b1a18}
 h1{font-size:20px;margin:0 0 4px} .lede{color:#6b6862;margin:0 0 24px;max-width:70ch}
 table.topp{border-collapse:collapse;margin-bottom:32px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}
 table.topp th,table.topp td{padding:7px 12px;border-bottom:1px solid #eceae5;text-align:right}
 table.topp th:first-child,table.topp td:first-child{text-align:left;font-weight:600}
 section{margin-bottom:36px} h3{font-size:13px;font-family:ui-monospace,Menlo,monospace;color:#6b6862;margin:0 0 8px}
 .rad{display:flex;gap:12px;align-items:flex-start;overflow-x:auto;padding-bottom:8px}
 .cell{background:#fff;border-radius:10px;padding:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);flex:0 0 auto}
 .cell.orig{max-width:280px} .cell.orig img{width:100%;border-radius:6px;display:block}
 .cell.granska{outline:2px solid #d94a02;outline-offset:-2px}
 .cell.tom{color:#a09c94;min-width:200px}
 h4{margin:0 0 8px;font-size:12px;display:flex;gap:8px;align-items:baseline}
 .ms{color:#8d8880;font-weight:400} .poang{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600}
 .trio{display:flex;gap:6px} figure{margin:0} figure img{width:150px;display:block;border-radius:5px;background:#fff}
 figcaption{font-size:10px;color:#8d8880;text-align:center;margin-top:2px}
 .cell table{border-collapse:collapse;margin-top:8px;font-size:11px;width:100%}
 .cell table td{padding:1px 6px 1px 0;color:#6b6862} .cell table td:nth-child(2),.cell table td:nth-child(4){color:#1b1a18;font-variant-numeric:tabular-nums}
 ul.anm{margin:8px 0 0;padding-left:16px;font-size:11px;color:#a33c02;max-width:420px}
</style>
<h1>Produktbild — modelljämförelse</h1>
<p class="lede">Fyra segmenteringsmodeller över samma riktiga säljarfoton ur server/data/jobs. Orange ram = kvalitetskontrollen ville ha mänsklig granskning. Den transparenta ligger mot rutmönster med flit: mot vitt ser en kant som bär rummets färg nästan rätt ut.</p>
<table class="topp"><tr><th>modell</th><th>byggda</th><th>granskning</th><th>median</th><th>poäng</th><th>benförlust</th><th>band</th><th>invariantbrott</th></tr>
${sammanfattning.map((s) => `<tr><td>${s.modell}</td><td>${s.byggda}/${s.bilder}</td><td>${s.granskning}</td><td>${(s.medianMs / 1000).toFixed(1)}s</td><td>${s.medelpoang.toFixed(2)}</td><td>${s.medelBenforlust.toFixed(2)}</td><td>${s.medelBandandel.toFixed(2)}</td><td>${s.invariantbrott}</td></tr>`).join("")}
</table>
${delar.join("\n")}`;

  const fil = path.join(utDir, "index.html");
  await writeFile(fil, html, "utf8");
  console.log(`\nSidan: ${fil}`);
}

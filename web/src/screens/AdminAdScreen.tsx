import { useEffect, useState } from "react";
import { getAnnons, patchAnnons } from "../api";
import { ArrowLeftIcon, CardIcon } from "../components/icons";
import { formatSek } from "../lib/price";
import { usePageTitle } from "../lib/pageTitle";
import type { AdminAnnonsDetalj, AnnonsAndring, AnnonsOverstyrning } from "../types";

/**
 * En annons, hela vägen ner — och vägen att ändra den.
 *
 * TVÅ KOLUMNER MED OLIKA SANNINGSANSPRÅK. Vänster är vad vi VET: besiktningen, mätningen,
 * huvudboken, ordrarna. Höger är vad vi BESTÄMT: rättelserna, priset, läget. Att blanda dem hade
 * gjort det omöjligt att se skillnad på ett mått vi läst ur en katalog och ett någon skrivit in.
 *
 * VARJE FÄLT VISAR DET HÄRLEDDA VÄRDET SOM PLACEHOLDER. Ett tomt fält betyder därför "använd det
 * maskinen kom fram till", och den som rättar ser vad de rättar ifrån utan att först behöva leta.
 */
const KATEGORIER = [
  ["soffor", "Soffor"],
  ["fatoljer", "Fåtöljer"],
  ["bord", "Bord"],
  ["stolar", "Stolar"],
  ["forvaring", "Förvaring"],
  ["sangar", "Sängar"],
  ["skrivbord-kontor", "Skrivbord & kontor"],
  ["belysning", "Belysning"],
  ["ovrigt", "Övrigt"],
] as const;

/** Fälten formuläret redigerar, i den ordning de står. */
const TEXTFALT = [
  ["title", "Rubrik", "text"],
  ["brand", "Märke", "text"],
  ["model", "Modell", "text"],
  ["color", "Färg", "text"],
  ["material", "Material", "text"],
  ["widthMm", "Bredd (mm)", "number"],
  ["depthMm", "Djup (mm)", "number"],
  ["heightMm", "Höjd (mm)", "number"],
  ["seatHeightMm", "Sitthöjd (mm)", "number"],
  ["retailPriceSek", "Nypris (kr)", "number"],
  ["imageUrl", "Bild-URL", "text"],
] as const;

export default function AdminAdScreen({ loopaId, onBack }: { loopaId: string; onBack: () => void }) {
  const [annons, setAnnons] = useState<AdminAnnonsDetalj | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [sparar, setSparar] = useState(false);
  const [utkast, setUtkast] = useState<Record<string, string>>({});
  const [kvitto, setKvitto] = useState<string | null>(null);
  usePageTitle("Annons");

  const ladda = (a: AdminAnnonsDetalj) => {
    setAnnons(a);
    setUtkast(utkastAv(a.overstyrning));
  };

  useEffect(() => {
    getAnnons(loopaId)
      .then(ladda)
      .catch((err: unknown) => setFel(err instanceof Error ? err.message : "Kunde inte hämta annonsen."));
  }, [loopaId]);

  /** Skickar en ändring och byter ut hela annonsen mot serverns svar. Servern är facit, inte formuläret. */
  const skicka = async (andring: AnnonsAndring, kvittotext: string) => {
    setSparar(true);
    setFel(null);
    setKvitto(null);
    try {
      ladda(await patchAnnons(loopaId, andring));
      setKvitto(kvittotext);
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Ändringen gick inte igenom.");
    } finally {
      setSparar(false);
    }
  };

  if (fel && !annons) return <p className="public-card-error">{fel}</p>;
  if (!annons) {
    return (
      <div className="profile-loading">
        <div className="spinner" />
      </div>
    );
  }

  const h = annons.harlett;
  const s = annons.statistik;

  return (
    <div className="screen screen-light profile admin annons-detalj">
      <button className="btn btn-text btn-back" onClick={onBack}>
        <ArrowLeftIcon /> Alla annonser
      </button>

      <header className="annons-topp">
        <span className="annons-bild stor" aria-hidden>
          {annons.imageUrl ? <img src={annons.imageUrl} alt="" /> : <CardIcon size={22} />}
        </span>
        <div>
          <h1 className="profile-name">{annons.titel}</h1>
          <p className="admin-lede">
            {annons.id} · {annons.lage}
            {annons.grade ? ` · betyg ${annons.grade}` : ""}
            {annons.ownerId ? ` · säljare ${annons.ownerId.slice(0, 8)}` : ""}
          </p>
          {annons.saknas.length > 0 && (
            <p className="admin-note">Saknar {annons.saknas.join(", ")} — kan inte ligga i butiken förrän det är ifyllt.</p>
          )}
          {annons.error && <p className="public-card-error">{annons.error}</p>}
        </div>
      </header>

      {kvitto && <p className="annons-kvitto">{kvitto}</p>}
      {fel && <p className="public-card-error">{fel}</p>}

      {/* ---------------- Mätningen ---------------- */}
      <h2 className="profile-section-title">Mätning</h2>
      <section className="profile-stats admin-stats-wide">
        <Tal etikett="Sidvisningar" varde={s.visningar} />
        <Tal etikett="Unika" varde={s.unikaVisningar} />
        <Tal etikett="I listor" varde={s.listvisningar} />
        <Tal etikett="Klick" varde={s.klick} />
        <Tal etikett="CTR" varde={annons.ctr === null ? "—" : `${(annons.ctr * 100).toFixed(1)} %`} />
        <Tal etikett="Kassor" varde={s.kassor} />
        <Tal etikett="Köp" varde={s.kop} />
        <Tal etikett="Till Tradera" varde={s.utgaende} />
      </section>
      {s.senaste ? (
        <p className="admin-note">
          Först mätt {datum(s.forsta)}, senast {datum(s.senaste)}.
          {Object.keys(s.perHandelse).length > 0 && ` Händelser: ${Object.entries(s.perHandelse).map(([k, v]) => `${k} ${v}`).join(", ")}.`}
        </p>
      ) : (
        <p className="admin-note">Inget mätt än. Mätningen började när panelen byggdes — äldre trafik finns inte sparad.</p>
      )}

      {/* ---------------- Tid och pris ---------------- */}
      <h2 className="profile-section-title">Tid och pris</h2>
      <section className="profile-stats admin-stats-wide">
        <Tal etikett="Filmad" varde={datum(annons.createdAt)} />
        <Tal etikett="I butiken" varde={datum(annons.listedAt)} />
        <Tal etikett="Dygn uppe" varde={annons.dagarUppe ?? "—"} />
        <Tal etikett="Såld" varde={annons.soldAt ? `${datum(annons.soldAt)} (${annons.soldChannel})` : "—"} />
        <Tal etikett="Startpris" varde={annons.prisStart === null ? "—" : formatSek(annons.prisStart)} />
        <Tal etikett="Pris nu" varde={annons.prisNu === null ? "—" : formatSek(annons.prisNu)} />
        <Tal etikett="Golv" varde={annons.prisGolv === null ? "—" : formatSek(annons.prisGolv)} />
        <Tal etikett="Motorns förslag" varde={annons.prisForslag === null ? "—" : formatSek(annons.prisForslag)} />
      </section>
      {annons.ladder && (
        <p className="admin-note">
          {annons.sankningar} sänkning{annons.sankningar === 1 ? "" : "ar"} gjorda, {Math.round(annons.ladder.weeklyDropPct * 100)} % i veckan.
          {annons.nextDropAt ? ` Nästa ${datum(annons.nextDropAt)}.` : annons.ladder.floorReachedAt ? " Golvet är nått." : " Stegen är inte startad."}
          {annons.ladder.lastError ? ` Senaste felet: ${annons.ladder.lastError}` : ""}
        </p>
      )}

      <PrisForm annons={annons} sparar={sparar} skicka={skicka} />

      {/* ---------------- Godkännandet ---------------- */}
      {/*
        Kön. Säljaren har tryckt "Sälj med Loopa" och väntar på oss. Knappen gör båda kanalerna i ett
        tryck — butiken direkt, Tradera i bakgrunden — och står överst i sin egen ruta: det är den
        enda åtgärden på sidan som någon annan väntar på.
      */}
      {(annons.traderaStatus === "pending" || annons.traderaStatus === "error") && (
        <section className="card-block annons-godkann">
          <h2 className="profile-section-title">
            {annons.traderaStatus === "pending" ? "Väntar på godkännande" : "Tradera avvisade annonsen"}
          </h2>
          <p className="admin-note">
            {annons.traderaStatus === "pending"
              ? `Säljaren tryckte "Sälj med Loopa" ${datum(annons.begardAt)}. Godkänn så går möbeln upp i butiken och på Tradera i samma tryck.`
              : `Godkänd ${datum(annons.tradera?.approvedAt ?? null)}, men Tradera sa nej: ${annons.tradera?.error ?? "okänt fel"}. Möbeln ligger kvar i butiken. Rätta och försök igen.`}
          </p>
          {annons.saknas.length > 0 && (
            <p className="public-card-error">Kan inte godkännas än — saknar {annons.saknas.join(", ")}. Fyll i under Innehåll nedan.</p>
          )}
          <button
            className="btn btn-primary"
            disabled={sparar || annons.saknas.length > 0}
            onClick={() => skicka({ lage: "godkann" }, "Godkänd. Möbeln ligger i butiken; Tradera köar annonsen, det tar oftast under en minut.")}
          >
            {annons.traderaStatus === "pending" ? "Godkänn och lägg ut" : "Försök Tradera igen"}
          </button>
        </section>
      )}
      {annons.traderaStatus === "publishing" && (
        <p className="admin-note">Tradera köar annonsen just nu. Ladda om sidan om en minut.</p>
      )}
      {annons.traderaStatus === "published" && annons.tradera?.url && (
        <p className="admin-note">
          Ligger på Tradera sedan {datum(annons.tradera.publishedAt)}:{" "}
          <a href={annons.tradera.url} target="_blank" rel="noreferrer">
            {annons.tradera.url}
          </a>
        </p>
      )}

      {/* ---------------- Läget ---------------- */}
      <h2 className="profile-section-title">Läge</h2>
      <div className="annons-knappar">
        <Lagesknapp lage="publicera" text="Publicera i butiken" sparar={sparar} skicka={skicka} />
        <Lagesknapp lage="ta-ner" text="Ta ner" sparar={sparar} skicka={skicka} />
        <Lagesknapp lage="sald" kanal="butik" text="Såld i butiken" sparar={sparar} skicka={skicka} />
        <Lagesknapp lage="sald" kanal="tradera" text="Såld på Tradera" sparar={sparar} skicka={skicka} />
        <Lagesknapp lage="levererad" text="Levererad" sparar={sparar} skicka={skicka} />
        <Lagesknapp lage="returnerad" text="Returnerad" sparar={sparar} skicka={skicka} />
        <Lagesknapp lage="slapp" text="Släpp reservationen" sparar={sparar} skicka={skicka} />
      </div>
      <p className="admin-note">
        Övergångarna går genom butikens tillståndsmaskin. En som inte är tillåten från nuvarande läge
        avvisas med sitt eget besked — panelen tar sig inte förbi skyddet mot dubbelförsäljning.
      </p>

      {/* ---------------- Innehållet ---------------- */}
      <h2 className="profile-section-title">Innehåll</h2>
      <p className="admin-note">
        Tre lägen per fält, inte två. Tomt fält med grå text = besiktningens värde används. Skriver du
        något går det före. Tömmer du ett fält du rättat blir det uttryckligen tomt — annonsen visar
        då ingenting där, vilket är ett eget beslut. ↺ tar tillbaka just det fältet till besiktningen.
      </p>
      <div className="annons-form">
        {TEXTFALT.map(([falt, etikett, typ]) => (
          <label key={falt} className="annons-falt">
            <span>
              {etikett}
              <FaltAterstall falt={falt} etikett={etikett} annons={annons} sparar={sparar} skicka={skicka} />
            </span>
            <input
              type={typ}
              value={utkast[falt] ?? ""}
              placeholder={platshallare(annons, h, falt)}
              onChange={(e) => setUtkast({ ...utkast, [falt]: e.target.value })}
            />
          </label>
        ))}
        <label className="annons-falt">
          <span>
            Kategori
            <FaltAterstall falt="categorySlug" etikett="Kategori" annons={annons} sparar={sparar} skicka={skicka} />
          </span>
          <select value={utkast.categorySlug ?? ""} onChange={(e) => setUtkast({ ...utkast, categorySlug: e.target.value })}>
            <option value="">Härledd: {h?.categorySlug ?? "—"}</option>
            {KATEGORIER.map(([slug, etikett]) => (
              <option key={slug} value={slug}>
                {etikett}
              </option>
            ))}
          </select>
        </label>
        <label className="annons-falt annons-falt-bred">
          <span>
            Annonstext
            <FaltAterstall falt="description" etikett="Annonstext" annons={annons} sparar={sparar} skicka={skicka} />
          </span>
          <textarea
            rows={6}
            value={utkast.description ?? ""}
            onChange={(e) => setUtkast({ ...utkast, description: e.target.value })}
            placeholder={platshallare(annons, h, "description")}
          />
        </label>
        <label className="annons-falt annons-falt-bred">
          <span>Anteckning</span>
          <input
            value={utkast.note ?? ""}
            onChange={(e) => setUtkast({ ...utkast, note: e.target.value })}
            placeholder="Varför ser annonsen ut som den gör?"
          />
        </label>
      </div>
      <div className="annons-knappar">
        <button
          className="btn"
          disabled={sparar}
          onClick={() => skicka({ falt: faltUr(utkast) }, "Rättelserna sparade.")}
        >
          Spara rättelser
        </button>
        {annons.overstyrning && (
          <button
            className="btn btn-outline"
            disabled={sparar}
            onClick={() => skicka({ aterstall: true }, "Rättelserna borttagna — annonsen följer besiktningen igen.")}
          >
            Återställ till besiktningen
          </button>
        )}
      </div>
      {annons.overstyrning && (
        <p className="admin-note">
          Senast rättad {datum(annons.overstyrning.updatedAt)}
          {annons.overstyrning.updatedBy ? ` av ${annons.overstyrning.updatedBy.slice(0, 8)}` : ""}.
          {annons.overstyrning.note ? ` "${annons.overstyrning.note}"` : ""}
        </p>
      )}

      {/* ---------------- Historiken ---------------- */}
      <h2 className="profile-section-title">Huvudbok</h2>
      {annons.handelser.length === 0 ? (
        <p className="admin-note">Möbeln har aldrig varit i butiken.</p>
      ) : (
        <ul className="annons-logg">
          {annons.handelser.map((h) => (
            <li key={h.id}>
              <span className="annons-logg-tid">{datum(h.at)}</span>
              <span>
                {h.from ?? "—"} → {h.to} · {h.actor.kind}
                {h.note ? ` · ${h.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {annons.ordrarRader.length > 0 && (
        <>
          <h2 className="profile-section-title">Ordrar</h2>
          <ul className="annons-logg">
            {annons.ordrarRader.map((o) => (
              <li key={o.id}>
                <span className="annons-logg-tid">{datum(o.createdAt)}</span>
                <span>
                  {o.reference} · {o.status} · {formatSek(o.priceSek + o.deliveryFeeSek)}
                  {o.email ? ` · ${o.email}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {annons.matningar.length > 0 && (
        <>
          <h2 className="profile-section-title">Senaste händelserna</h2>
          <ul className="annons-logg">
            {annons.matningar.slice(0, 40).map((m, i) => (
              <li key={`${m.at}-${i}`}>
                <span className="annons-logg-tid">{datum(m.at)}</span>
                <span>
                  {m.event}
                  {Object.keys(m.props).length ? ` · ${JSON.stringify(m.props)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Tal({ etikett, varde }: { etikett: string; varde: string | number }) {
  return (
    <div className="profile-stat">
      <div className="profile-stat-value">{varde}</div>
      <div className="profile-stat-label">{etikett}</div>
    </div>
  );
}

function Lagesknapp({
  lage,
  kanal,
  text,
  sparar,
  skicka,
}: {
  lage: NonNullable<AnnonsAndring["lage"]>;
  kanal?: "butik" | "tradera";
  text: string;
  sparar: boolean;
  skicka: (a: AnnonsAndring, kvitto: string) => void;
}) {
  return (
    <button className="btn btn-outline btn-small" disabled={sparar} onClick={() => skicka({ lage, kanal }, `${text} — klart.`)}>
      {text}
    </button>
  );
}

/**
 * Priset och spannet.
 *
 * Två skilda knappar med flit: att sätta priset NU och att flytta spannet är två olika beslut. Den
 * första säger "just den här möbeln ska kosta det här", den andra "sänkningen ska gå från X till Y".
 * En knapp som gjorde båda hade tvingat den som bara vill sänka ett pris att också ta ställning till
 * golvet.
 */
function PrisForm({
  annons,
  sparar,
  skicka,
}: {
  annons: AdminAnnonsDetalj;
  sparar: boolean;
  skicka: (a: AnnonsAndring, kvitto: string) => void;
}) {
  const [pris, setPris] = useState("");
  const [start, setStart] = useState("");
  const [golv, setGolv] = useState("");
  const [takt, setTakt] = useState("");

  useEffect(() => {
    setPris(annons.prisNu === null ? "" : String(annons.prisNu));
    setStart(annons.prisStart === null ? "" : String(annons.prisStart));
    setGolv(annons.prisGolv === null ? "" : String(annons.prisGolv));
    setTakt(annons.ladder ? String(Math.round(annons.ladder.weeklyDropPct * 100)) : "15");
  }, [annons]);

  return (
    <div className="annons-form">
      <label className="annons-falt">
        <span>Pris nu (kr)</span>
        <input type="number" value={pris} onChange={(e) => setPris(e.target.value)} />
      </label>
      <div className="annons-falt annons-falt-knapp">
        <button
          className="btn btn-small"
          disabled={sparar || !pris}
          onClick={() => skicka({ prisNu: Number(pris) }, "Priset satt. Ligger annonsen på Tradera skrivs det dit också.")}
        >
          Sätt priset
        </button>
      </div>
      <label className="annons-falt">
        <span>Startpris (kr)</span>
        <input type="number" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="annons-falt">
        <span>Golv (kr)</span>
        <input type="number" value={golv} onChange={(e) => setGolv(e.target.value)} />
      </label>
      <label className="annons-falt">
        <span>Sänkning (% / vecka)</span>
        <input type="number" value={takt} onChange={(e) => setTakt(e.target.value)} />
      </label>
      <div className="annons-falt annons-falt-knapp">
        <button
          className="btn btn-outline btn-small"
          disabled={sparar || !start || !golv}
          onClick={() =>
            skicka(
              { ladder: { startPrice: Number(start), floorPrice: Number(golv), weeklyDropPct: Number(takt) / 100 } },
              "Prisstegen uppdaterad. Priset som ligger uppe rördes inte.",
            )
          }
        >
          Spara spannet
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formuläret <-> överstyrningen
// ---------------------------------------------------------------------------

/**
 * Överstyrningen som formulärvärden.
 *
 * Osatta och uttryckligen tomma fält blir båda ett tomt inmatningsfält — det finns inget tredje sätt
 * att se ut som ett tomt fält. Skillnaden bärs i stället av platshållaren (`platshallare`) och av att
 * ↺ bara syns på fält som faktiskt är rättade. Ett fält som inte finns här skickas heller inte vid
 * spara, så ett uttryckligen tomt fält står kvar tills någon rör det.
 */
function utkastAv(o: AnnonsOverstyrning | null): Record<string, string> {
  const ut: Record<string, string> = {};
  if (!o) return ut;
  for (const [k, v] of Object.entries(o)) {
    if (k === "id" || k === "updatedAt" || k === "updatedBy") continue;
    if (v === null || v === undefined) continue;
    ut[k] = String(v);
  }
  return ut;
}

/**
 * Formuläret som en patch.
 *
 * Ett tomt fält skickas som `null` — "uttryckligen tomt" — och inte som utelämnat. Det är rätt här:
 * den som tömmer ett fält i panelen har gjort något, och alternativet (utelämna) hade gjort tömning
 * omöjlig. Vill man i stället tillbaka till besiktningens värde finns "Återställ".
 */
function faltUr(utkast: Record<string, string>): Record<string, string | number | null> {
  const ut: Record<string, string | number | null> = {};
  const tal = new Set(["widthMm", "depthMm", "heightMm", "seatHeightMm", "retailPriceSek"]);
  for (const [k, v] of Object.entries(utkast)) {
    const rensat = v.trim();
    if (!rensat) ut[k] = null;
    else if (tal.has(k)) ut[k] = Number(rensat);
    else ut[k] = rensat;
  }
  return ut;
}

/** Sant när fältet är satt till UTTRYCKLIGEN TOMT — ett beslut, inte en avsaknad av beslut. */
function uttryckligenTom(o: AnnonsOverstyrning | null, falt: string): boolean {
  return !!o && falt in o && (o as unknown as Record<string, unknown>)[falt] === null;
}

/** Sant när fältet över huvud taget är rättat, tomt eller ifyllt. Styr om ↺ ska synas. */
function arRattat(o: AnnonsOverstyrning | null, falt: string): boolean {
  return !!o && falt in o && (o as unknown as Record<string, unknown>)[falt] !== undefined;
}

/**
 * Den grå texten i ett tomt fält — och därmed det enda stället skillnaden mellan de tre lägena syns.
 *
 * Ett fält som är uttryckligen tomt såg tidigare ut precis som ett osatt: tomt, med besiktningens
 * värde i grått. Panelen påstod alltså att annonsen visar "Ekbrun" när den i själva verket inte
 * visar någon färg alls.
 */
function platshallare(annons: AdminAnnonsDetalj, h: AdminAnnonsDetalj["harlett"], falt: string): string {
  if (uttryckligenTom(annons.overstyrning, falt)) return "tomt med flit — annonsen visar ingenting";
  if (falt === "description") return "Generatorns text";
  return harlettVarde(h, falt) ?? "—";
}

/**
 * ↺ på ett enskilt fält.
 *
 * Syns bara på fält som är rättade, för det är de enda som har något att återvända FRÅN. Utan den
 * var "Återställ till besiktningen" enda vägen ut, och den kastar varje annan rättelse på annonsen.
 */
function FaltAterstall({
  falt,
  etikett,
  annons,
  sparar,
  skicka,
}: {
  falt: string;
  etikett: string;
  annons: AdminAnnonsDetalj;
  sparar: boolean;
  skicka: (a: AnnonsAndring, kvitto: string) => void;
}) {
  if (!arRattat(annons.overstyrning, falt)) return null;
  return (
    <button
      type="button"
      className="annons-falt-aterstall"
      disabled={sparar}
      title={`Ta bort rättelsen på ${etikett.toLowerCase()} — fältet följer besiktningen igen`}
      aria-label={`Återställ ${etikett}`}
      onClick={() => skicka({ aterstallFalt: [falt] }, `${etikett} följer besiktningen igen.`)}
    >
      ↺
    </button>
  );
}

/** Det härledda värdet som placeholder, så den som rättar ser vad de rättar ifrån. */
function harlettVarde(h: AdminAnnonsDetalj["harlett"], falt: string): string | null {
  if (!h) return null;
  switch (falt) {
    case "title": return h.title;
    case "brand": return h.brand;
    case "model": return h.model;
    case "color": return h.color;
    case "material": return h.material;
    case "widthMm": return h.dimensions.widthMm === null ? null : String(h.dimensions.widthMm);
    case "depthMm": return h.dimensions.depthMm === null ? null : String(h.dimensions.depthMm);
    case "heightMm": return h.dimensions.heightMm === null ? null : String(h.dimensions.heightMm);
    case "seatHeightMm": return h.dimensions.seatHeightMm === null ? null : String(h.dimensions.seatHeightMm);
    case "retailPriceSek": return h.retailPriceSek === null ? null : String(h.retailPriceSek);
    case "imageUrl": return h.imageUrl;
    default: return null;
  }
}

function datum(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

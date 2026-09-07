import { useEffect, useState } from "react";
import { ProductStrip } from "../butik/components/ProductGrid";
import BrandTiles from "../butik/components/BrandTiles";
import TypeTiles from "../butik/components/TypeTiles";
import AiSearch from "../butik/components/AiSearch";
import { track } from "../butik/components/Bits";
import { fetchBrands, fetchTypes } from "../butik/api";
import type { BrandFacet, FurnitureType } from "../butik/types";
import { BUTIK_ROOT } from "../butik/router";
import { useT } from "../lib/i18n";
import "../butik/butik.css";
import "./marknad.css";

/**
 * MARKNADSPLATSTESTET — köp och sälj på samma startsida.
 *
 * Loopa har hittills varit två produkter med var sin ingång: säljverktyget på `/` och köpsidan på
 * `/kop`. Det här är ett test av motsatsen — att startsidan är en marknadsplats där man både lämnar
 * in en möbel och hittar en att köpa, utan att behöva veta att de två är olika delar av huset.
 *
 * ALLT NYTT LIGGER I DEN HÄR MAPPEN, och det är avsiktligt. Testet ska gå att ångra genom att ta
 * bort tre rader i HomeScreen.tsx och radera mappen — ingen befintlig komponent är ändrad, ingen
 * route är flyttad, ingenting i servern är rört. `MARKNADSPLATS` nedan är strömbrytaren för den som
 * bara vill se sidan utan testet en stund.
 *
 * INGET ÄR BYGGT NYTT SOM REDAN FINNS. Rutnätet är butikens `ProductStrip`, sökningen dess
 * `AiSearch`,
 * brickorna dess `BrandTiles`, hämtningen dess `browse`/`fetchBrands`, och varje
 * länk går in i butikens egna adresser. Klicket byter app utan omladdning: butikens `navigate`
 * pushar adressen och App.tsx byter till ButikApp på popstate, precis som från köpsidan.
 *
 * ORDNINGEN PÅ SIDAN, och varför:
 *
 *   1. Sälj-heron överst. Det är fortfarande det Loopa ber om först.
 *   2. Märkeslistan, som är säljandets första handling.
 *   3. Köphalvan sist: först när man sagt nej till att sälja är man en köpare.
 *
 * TEXTERNA ÄR OMSKRIVNA FÖR TVÅ HALVOR. Rubrikerna är parallella ("Sälj din möbel" /
 * "Köp en begagnad möbel") så att sidan säger på en blick att den är båda. Se SaljHero för varför
 * frågan om märket blev en uppmaning på andra raden.
 */
export const MARKNADSPLATS = true;

/**
 * Sälj-heron, omskriven för en marknadsplats.
 *
 * "VILKET MÄRKE ÄR MÖBELN?" VAR EN FRÅGA I ETT FLÖDE. Den var rätt så länge hela sidan var ett steg
 * i säljverktyget: man kom hit för att filma, och frågan var det första som skulle besvaras. På en
 * startsida som också är en butik läser den som en gåta — den säger ingenting om vad Loopa gör, och
 * den som kom för att köpa förstår inte varför sidan frågar om deras möbel.
 *
 * NU SÄGER RUBRIKEN VAD MAN KAN, och andra raden pekar vidare in i märkeslistan. Två rader, samma
 * form som förut — påstående i svart, det som bjuder in i accent.
 *
 * PARALLELLA RUBRIKER ÄR HELA POÄNGEN. "Sälj din möbel" över den ena halvan och "Köp en begagnad
 * möbel" över den andra säger på en blick att sidan är två saker. Vore den ena "Upptäck möbler" och
 * den andra en fråga vore de två olika sorters sidor som råkat hamna under varandra.
 *
 * ANDRA RADEN ÄR EN UPPMANING, INTE EN FRÅGA. "Vilket märke är den?" lät som något att svara på i
 * huvudet; "Välj märke →" pekar på märkeslistan som står direkt under. Pilen hör till raden — den är
 * det som gör rubriken till en väg vidare och inte en etikett.
 *
 * INGRESSEN SÄGER INSATSEN OCH INVÄNDNINGEN. Först vad man gör (filma ett varv) och vad som händer
 * (AI:n säljer), sedan det som annars stoppar folk: att aldrig behöva träffa köparen.
 */
export function SaljHero() {
  const t = useT();
  return (
    <header className="home-header">
      <span className="brand-pill">
        <span className="brand-dot" /> {t("SÄLJ MED LOOPA")}
      </span>
      <h1 className="home-title">
        {t("Sälj din möbel")}
        <br />
        <span className="accent">{t("Välj märke →")}</span>
      </h1>
      <p className="home-lede">
        {t("Filma ett varv runt möbeln, och låt AI sälja den åt dig! Du behöver aldrig träffa köparen.")}
      </p>
      <ol className="home-steps desktop-only">
        <li>{t("Filma ett varv")}</li>
        <li>{t("AI:n sätter skick och pris")}</li>
        <li>{t("Vi säljer den åt dig")}</li>
      </ol>
    </header>
  );
}

/**
 * Köphalvan av startsidan: en flödesruta att bläddra i, och märkena som väg vidare.
 *
 * "FÖR DIG" ÄR EN PLATS, INTE EN MODELL. Ordningen är nyinkommet — det finns ingen personalisering i
 * produkten, och att låtsas om en är att lova något vi inte gör. Rubriken står som den gör för att
 * testa formen; den dagen det finns en rankning byts sorteringen ut och rubriken blir sann. Skriv
 * inte om den här kommentaren utan att ändra det ena eller det andra.
 */
export default function Upptack() {
  const t = useT();
  const [brands, setBrands] = useState<BrandFacet[] | null>(null);
  const [types, setTypes] = useState<FurnitureType[] | null>(null);

  useEffect(() => {
    fetchBrands().then((r) => setBrands(r.brands)).catch(() => setBrands([]));
    fetchTypes().then((r) => setTypes(r.types)).catch(() => setTypes([]));
    // Måttet på om testet landar: hur många som ens ser köphalvan, jämfört med hur många som
    // klickar vidare in i butiken. Samma spår som `buy_cta_click` från topplisten.
    track("view_item_list", { list: "startsidan" });
  }, []);

  return (
    <section className="marknad" aria-labelledby="marknad-rubrik">
      <header className="marknad-head">
        <span className="brand-pill">
          <span className="brand-dot" /> {t("KÖP MED LOOPA")}
        </span>
        {/* Parallellt med "Sälj din möbel". Samma mening, andra riktningen — se SaljHero. */}
        <h2 id="marknad-rubrik">{t("Köp en begagnad möbel")}</h2>
        <p>{t("Varje möbel är granskad av samma AI, prissatt efter skick och hemkörd. Du ser alla skador innan du köper.")}</p>
      </header>

      {/*
        SÖKNINGEN ÖVER FLÖDET. Butikens egen ruta, oförändrad: den tar en hel MENING och låter
        servern översätta den till ett filter, till skillnad från topplistens ordmatchning. Den
        lämnar startsidan och landar på sökskärmen med filtren — en sökning ÄR en ny sida, och att
        filtrera flödet på plats hade gett två sökbegrepp i produkten som betyder olika saker.
      */}
      <AiSearch />

      {/*
        FYRA SKARPA, OCH EN RAD TILL SOM SKYMTAR.
        Rutnätet med sidladdning gjorde startsidan till en butik: man kunde bläddra i hela lagret
        utan att lämna den, och märkena hamnade utom synhåll bakom en knapp som alltid gav mer. Ett
        smakprov gör motsatsen — det tar slut, och då är nästa steg synligt.
        Men ett flöde som bara SLUTAR ser ut som ett lager på fyra möbler. Därför fortsätter det, ur
        fokus, och märkeslistan lägger sig över det: raden säger "det finns mer", märkena säger
        "härifrån". Två strips och inte ett rutnät med åtta, för då är beskärningen ETT tal på ett
        ställe i stället för höjdmatematik på ett kort vars höjd beror på bildens.
      */}
      <h3 className="marknad-rubrik">{t("För dig")}</h3>
      <ProductStrip query={{ sortering: "nyinkommet" }} limit={4} />

      {/*
        Skymten. `inert` och inte bara `pointer-events: none`: en suddig länk som inte går att klicka
        på men går att tabba till är värre än ingen alls — den tar emot fokus och leder ingenstans.
        `fran: 4` gör att det är NÄSTA fyra som skymtar, inte samma fyra en gång till.
      */}
      <div
        className="marknad-skymt"
        aria-hidden="true"
        {...({ inert: "" } as Record<string, string>)}
      >
        <ProductStrip query={{ sortering: "nyinkommet", fran: 4 }} limit={4} />
      </div>

      <h3 className="marknad-rubrik">{t("Bläddra bland märken")}</h3>
      <BrandTiles brands={brands ?? []} />

      {/*
        MÖBELTYPERNA UNDER MÄRKENA. Märket är ingången för den som vet vad de vill ha; typen för den
        som vet vad de behöver — "en soffa", "ett matbord". Varje bricka leder till en egen sida
        (/butik/mobel/soffor) med rubriken "Begagnad soffa i Stockholm": det är den sidan som ska
        svara på sökningen, och brickan här är vägen dit från startsidan. Bara typer med varor visas.
      */}
      <h3 className="marknad-rubrik">{t("Bläddra bland möbeltyper")}</h3>
      <TypeTiles types={types ?? []} />

      {/*
        Vägen in i butiken i sin helhet. Ett vanligt <a> med en riktig adress: den byter app och ska
        gå att öppna i en ny flik — samma resonemang som "Köp" i topplisten.
      */}
      <a
        className="marknad-alla"
        href={`${BUTIK_ROOT}/sok`}
        onClick={() => track("buy_cta_click", { from: "startsidan_alla" })}
      >
        {t("Se hela lagret")}
      </a>
    </section>
  );
}

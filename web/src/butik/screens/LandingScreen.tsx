import { useEffect, useState } from "react";
import type { BrandFacet, Category } from "../types";
import { fetchBrands, fetchCategories } from "../api";
import { ProductStrip } from "../components/ProductGrid";
import { Link, SellCta } from "../components/Bits";
import AiSearch from "../components/AiSearch";
import BuySomewhereElse from "../components/BuySomewhereElse";
import LinkHero from "../components/LinkHero";
import HowItWorks from "../components/HowItWorks";
import BrandTiles from "../components/BrandTiles";

/**
 * Butikens förstasida.
 *
 * ORDNINGEN ÄR ETT ARGUMENT, inte en layout — och argumentet har bytt ordning.
 *
 * Sidan öppnade förut med ett motto och två sätt att bläddra i vårt eget lager; rutan för en möbel
 * man hittat någon annanstans låg som ett inslag längre ned. Det var baklänges. Loopas lager är
 * hundratals möbler, Blockets är hundratusentals, och den som letar en soffa har oftast redan hittat
 * en — det de saknar är någon som kan säga om den är värd pengarna och sedan bära hem den. Det är
 * vad Loopa gör, och det ska stå först.
 *
 * Därför:
 *
 *   1. LinkHero      fältet, ensamt överst. Sidans hela ärende i en mening och en ruta.
 *   2. HowItWorks    hela resan, inklusive granskningen och hemleveransen — den halva som förut
 *                    inte stod någonstans, trots att den är vad man betalar oss för.
 *   3. Lagret        "eller köp något vi redan granskat": AI-sökning, märken, nyinkommet, kategorier.
 *   4. LinkHero igen som en smal rad sist, för den som scrollat hela vägen och kommit på att de
 *      hade en annons i en flik hela tiden.
 *
 * Lagret ligger efter förklaringen och inte före: den som förstått vad granskningen är läser
 * "Loopa-granskad" på ett kort som ett löfte i stället för en etikett.
 */
export default function LandingScreen() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [brands, setBrands] = useState<BrandFacet[] | null>(null);

  useEffect(() => {
    fetchCategories().then((r) => setCategories(r.categories)).catch(() => setCategories([]));
    fetchBrands().then((r) => setBrands(r.brands)).catch(() => setBrands([]));
  }, []);

  return (
    <>
      {/* Sidans ärende: en annons du hittat, granskad och hemkörd. Allt annat kommer efter. */}
      <LinkHero />

      <HowItWorks />

      {/* ── Vårt eget lager ──────────────────────────────────────────────────
          Andra vägen in, och den är inte mindre värd — bara mindre vanlig. Den som redan vet vad
          de vill ha börjar här; den som har en annons i en flik började ovanför. */}
      <section className="shelf-intro">
        <h2>Eller köp något vi redan granskat</h2>
        <p>
          Möbler som står hos oss just nu — filmade, genomgångna och prissatta efter skick. Samma
          hemleverans, och du ser varje skada innan du trycker på köp.
        </p>
      </section>

      <AiSearch />

      <section className="butik-section" style={{ marginTop: 0 }}>
        <div className="butik-section-head">
          <h2>Handla efter märke</h2>
        </div>
        <BrandTiles brands={brands ?? []} />
      </section>

      <section className="butik-section">
        <div className="butik-section-head">
          <h2>Eller efter kategori</h2>
        </div>
      </section>

      <nav className="butik-tiles" aria-label="Kategorier" style={{ marginTop: 0 }}>
        {(categories ?? []).map((c) => (
          <Link key={c.slug} to={{ name: "category", slug: c.slug }} className={`butik-tile ${c.count === 0 ? "butik-tile-empty" : ""}`}>
            <span className="butik-tile-name">{c.label}</span>
            <span className="butik-tile-count">{c.count > 0 ? `${c.count} st` : "Inget just nu"}</span>
          </Link>
        ))}
      </nav>

      <section className="butik-section">
        <div className="butik-section-head">
          <h2>Nyinkommet</h2>
          <Link to={{ name: "search", q: "" }}>Visa allt →</Link>
        </div>
        <ProductStrip query={{ sortering: "nyinkommet" }} limit={8} />
      </section>

      {/*
        Andra remsan sorterar på PRIS och inte på datum.
        Den visade förut `onlyLoopa` sorterat på nyinkommet — vilket är samma fråga som remsan
        ovanför ställer, och lagret är nästan bara Loopa-möbler. Resultatet var två rader med exakt
        samma fyra möbler under två rubriker. Billigast först är en annan fråga och ger andra svar.
      */}
      <section className="butik-section">
        <div className="butik-section-head">
          <h2>Billigast just nu</h2>
          <Link to={{ name: "search", q: "" }}>Visa allt →</Link>
        </div>
        <ProductStrip query={{ sortering: "pris_upp" }} limit={4} />
      </section>

      {/* Förklaringen som stod här är uppgången i HowItWorks längre upp: den beskrev bara
          besiktningen, och sidan behövde hela resan — granskning, betalning och hemleverans. */}
      <LinkHero compact />

      <SellCta />
    </>
  );
}

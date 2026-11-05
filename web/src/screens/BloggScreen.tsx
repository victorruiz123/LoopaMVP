import { ArrowLeftIcon } from "../components/icons";
import { usePageTitle } from "../lib/pageTitle";
import { BLOGG_BESKRIVNING, BLOGG_RUBRIK, delarAvText, INLAGG, inlaggFor, type BloggInlagg } from "../lib/blogg";

/**
 * Bloggen: /blogg och /blogg/<slug>.
 *
 * Texten kommer ur lib/blogg.ts, samma fil som servern skickar färdig till sökmotorerna (se
 * server/src/butik/seo.ts, bloggSida). Sidan är bara svenska — guiderna är skrivna för svenska
 * sökningar, och en maskinöversättning av dem vore en sämre text på ett språk ingen sökt på.
 *
 * Länkarna är vanliga <a>: appen har ingen router (se App.tsx), och ett inlägg är en egen sida.
 */
export default function BloggScreen({ slug }: { slug: string | null }) {
  const inlagg = slug ? inlaggFor(slug) : null;
  usePageTitle(slug ? (inlagg?.titel ?? "Guiden finns inte") : BLOGG_RUBRIK);

  return (
    <div className="screen screen-light legal blogg">
      <a className="btn btn-text btn-back" href={slug ? "/blogg" : "/"}>
        <ArrowLeftIcon /> {slug ? "Alla guider" : "Till Loopa"}
      </a>

      {!slug ? <Lista /> : inlagg ? <Inlagg inlagg={inlagg} /> : <Saknas />}

      <a className="btn btn-primary blogg-cta" href="/">
        Sälj din möbel med Loopa
      </a>
    </div>
  );
}

function Lista() {
  return (
    <>
      <header className="legal-head">
        <h1 className="legal-title">{BLOGG_RUBRIK}</h1>
        <p className="blogg-ingress">{BLOGG_BESKRIVNING}</p>
      </header>
      <ul className="blogg-lista">
        {INLAGG.map((i) => (
          <li key={i.slug}>
            <a href={`/blogg/${i.slug}`}>
              <strong>{i.titel}</strong>
              <span>{i.beskrivning}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

function Inlagg({ inlagg: i }: { inlagg: BloggInlagg }) {
  const andra = INLAGG.filter((x) => x.slug !== i.slug);
  return (
    <>
      <header className="legal-head">
        <h1 className="legal-title">{i.titel}</h1>
        <p className="legal-updated">
          {new Date(i.uppdaterad).toLocaleDateString("sv-SE", { day: "numeric", month: "long", year: "numeric" })}
        </p>
      </header>
      <article className="legal-body blogg-text">
        <p className="blogg-ingress">
          <Text text={i.ingress} />
        </p>
        {i.delar.map((d) => (
          <section key={d.rubrik}>
            <h2>{d.rubrik}</h2>
            {d.stycken.map((p, n) => (
              <p key={n}>
                <Text text={p} />
              </p>
            ))}
            {d.punkter && (
              <ul>
                {d.punkter.map((p, n) => (
                  <li key={n}>
                    <Text text={p} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {i.fragor.length > 0 && (
          <section>
            <h2>Vanliga frågor</h2>
            {i.fragor.map((f) => (
              <div key={f.q}>
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </div>
            ))}
          </section>
        )}
      </article>
      <nav className="blogg-fler" aria-label="Fler guider">
        <h2>Fler guider</h2>
        <ul>
          {andra.map((x) => (
            <li key={x.slug}>
              <a href={`/blogg/${x.slug}`}>{x.titel}</a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

function Saknas() {
  return (
    <header className="legal-head">
      <h1 className="legal-title">Guiden finns inte</h1>
      <p className="blogg-ingress">
        <a href="/blogg">Se alla guider om att sälja möbler</a>
      </p>
    </header>
  );
}

/** Text med [länk](/adress), ritad som text och länkar. */
function Text({ text }: { text: string }) {
  return (
    <>
      {delarAvText(text).map((d, n) =>
        d.href ? (
          <a key={n} href={d.href}>
            {d.text}
          </a>
        ) : (
          <span key={n}>{d.text}</span>
        ),
      )}
    </>
  );
}

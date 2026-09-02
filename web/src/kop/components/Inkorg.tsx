import { useEffect, useState } from "react";
import { inkorg, markeraLast, type Notice } from "../api";
import { track } from "../../butik/components/Bits";

/**
 * Inkorgen: notiserna, i appen.
 *
 * PRIMÄR KANAL och inte ett komplement till brevet. Den når mottagaren oavsett om en
 * e-postleverantör är vald, ligger kvar, går att läsa om, och pekar rakt in i den efterlysning som
 * orsakade den. Brevet är en påminnelse om den här listan.
 *
 * KLICKET MÄTS HÄR. `notification_sent` skrivs på servern när brevet går; motsvarande klick finns
 * bara i en webbläsare, och utan båda halvorna går det inte att säga om notiserna är värda något.
 */
export default function Inkorg() {
  const [notiser, setNotiser] = useState<Notice[] | null>(null);

  useEffect(() => {
    inkorg().then((r) => setNotiser(r.notiser)).catch(() => setNotiser([]));
  }, []);

  if (!notiser || notiser.length === 0) return null;
  const olasta = notiser.filter((n) => !n.readAt);

  return (
    <section className="inkorg">
      <div className="inkorg-head">
        <h2>Från oss</h2>
        {olasta.length > 0 && (
          <button
            type="button"
            className="inkorg-alla"
            onClick={() => {
              void markeraLast(olasta.map((n) => n.id));
              setNotiser(notiser.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
            }}
          >
            Markera alla som lästa
          </button>
        )}
      </div>
      <ul className="inkorg-lista">
        {notiser.map((n) => (
          <li key={n.id} className={n.readAt ? "inkorg-post" : "inkorg-post inkorg-olast"}>
            <a
              href={n.href}
              onClick={() => {
                track(n.kind === "deadline" ? "deadline_valve_clicked" : "notification_clicked", {
                  kind: n.kind, source: n.source,
                });
                void markeraLast([n.id]);
              }}
            >
              <span className="inkorg-titel">{n.title}</span>
              <span className="inkorg-tid">{new Date(n.createdAt).toLocaleDateString("sv-SE")}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

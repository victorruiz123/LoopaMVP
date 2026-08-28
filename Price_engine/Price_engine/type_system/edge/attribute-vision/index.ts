// Tunn proxy: attributfrågor om en möbelbild via Lovable AI Gateway.
//
// Finns för att prismotorns L3-lager ska kunna mätas utan att LOVABLE_API_KEY
// lämnar servern. Nyckeln injiceras av Lovable Cloud och kan inte läsas ut;
// därför måste anropet ske här och inte i mätskriptet.
//
// Till skillnad från classify-shot-images och validate-single-shot har den här
// funktionen INGEN egen uppfattning om möbeln. Den vidarebefordrar de frågor
// anroparen skickar och returnerar svaren strukturerat. Det är avsiktligt: ska
// L3 mätas måste det vara L3:s frågor som ställs, inte appens.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

// Delad hemlighet. Funktionen är JWT-fri för att kunna anropas från ett
// fristående mätskript, och en öppen endpoint som bränner AI-krediter är en
// risk för projektet — inte för den som anropar den. Utan satt hemlighet
// vägrar funktionen svara: hellre obrukbar än öppen.
const SHARED_SECRET = Deno.env.get("ATTRIBUTE_VISION_TOKEN");
const TIMEOUT_MS = 20000;
const MAX_IMAGES = 4;
const MAX_QUESTIONS = 6;

interface Question {
  id: string;          // attributnamn, t.ex. "corner"
  text: string;        // frågan som ställs
  answers: string[];   // tillåtna svar; allt annat förkastas
}

interface ReqBody {
  images: string[];    // data-URL:er eller publika URL:er
  questions: Question[];
  hint?: string;       // annonstext, redan blindad av anroparen
  model?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (!SHARED_SECRET) {
    return json({ error: "ATTRIBUTE_VISION_TOKEN är inte satt" }, 503);
  }
  if (req.headers.get("x-attribute-vision-token") !== SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "ogiltig JSON" }, 400);
  }

  const images = (body.images ?? []).slice(0, MAX_IMAGES);
  const questions = (body.questions ?? []).slice(0, MAX_QUESTIONS);
  if (!images.length || !questions.length) {
    return json({ error: "images och questions krävs" }, 400);
  }
  if (!LOVABLE_API_KEY) {
    // Samma hållning som resten av appen: saknad nyckel är inte ett krasch-
    // läge utan ett tomt svar. Anroparen faller tillbaka på sina egna lager.
    return json({ answers: {}, note: "LOVABLE_API_KEY saknas" });
  }

  const lines = [
    "Du tittar på foton av en enda möbel som ska prissättas.",
    "Svara utifrån vad du FAKTISKT SER. Om bilderna inte visar det, svara",
    "'gar_inte_se'. Det svaret är alltid bättre än en gissning — ett felaktigt",
    "ja flyttar priset åt fel håll.",
    "",
  ];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. [${q.id}] ${q.text}`);
    lines.push(`   Tillåtna svar: ${q.answers.join(", ")}`);
  });
  if (body.hint) {
    lines.push("", `Annonstexten säger: ${JSON.stringify(body.hint)}.`,
      "Använd den som ledtråd men låt den aldrig överrida vad du ser.");
  }
  // Ett KONKRET exempel med de faktiska nycklarna, inte en mall med <id>.
  // Mallformen gjorde att modellen utelämnade nyckeln i 15 av 18 anrop — den
  // fick gissa vad platshållaren skulle bli, och gissade fel.
  const example = Object.fromEntries(questions.map((q) => [
    q.id,
    { value: q.answers[0], confidence: "hog", evidence: "kort motivering" },
  ]));
  lines.push(
    "",
    "Svara ENBART med ett JSON-objekt med EXAKT dessa nycklar: " +
      questions.map((q) => `"${q.id}"`).join(", ") + ".",
    "Format (värdena är exempel, svara med dina egna):",
    JSON.stringify(example),
  );

  const userContent: unknown[] = [{ type: "text", text: lines.join("\n") }];
  for (const img of images) {
    userContent.push({ type: "image_url", image_url: { url: img } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: body.model ?? "google/gemini-2.5-flash",
        messages: [{ role: "user", content: userContent }],
        response_format: { type: "json_object" },
      }),
    });
    clearTimeout(timer);

    if (!resp.ok) {
      // 429 och 402 vidarebefordras med status, så mätskriptet kan skilja
      // "slut på kvot" från "modellen kunde inte svara" — de betyder olika
      // saker och ska inte hamna i samma hink.
      const text = await resp.text();
      return json({ error: "ai_error", status: resp.status, detail: text.slice(0, 400) },
        resp.status === 429 || resp.status === 402 ? resp.status : 502);
    }

    const data = await resp.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: Record<string, { value?: string; confidence?: string; evidence?: string }> = {};
    try {
      parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      return json({ answers: {}, note: "kunde inte tolka svaret", raw: raw.slice(0, 300) });
    }

    // Validera mot svarsrymden. Utan strikt schema kan modellen svara vad som
    // helst, och ett värde utanför listan är brus — inte ett svar.
    //
    // Talsvar måste tvingas till sträng först. Frågan "hur många stolar" har
    // svarsrymden ["0".."8"], och modellen svarar ibland med JSON-talet 4 i
    // stället för strängen "4". Ett typkrav på string kastade då bort ett
    // korrekt svar — tyst, vilket var det värsta med det.
    const answers: Record<string, unknown> = {};
    const dropped: Array<{ id: string; value: unknown }> = [];
    for (const q of questions) {
      const item = parsed[q.id];
      if (!item || item.value === undefined || item.value === null) {
        dropped.push({ id: q.id, value: item === undefined ? "<saknas>" : null });
        continue;
      }
      const value = String(item.value).trim();
      if (q.answers.includes(value)) {
        answers[q.id] = {
          value,
          confidence: String(item.confidence ?? "lag"),
          evidence: String(item.evidence ?? "").slice(0, 200),
        };
      } else {
        // Underkända svar redovisas i stället för att försvinna. En tom
        // svarsmängd utan förklaring är omöjlig att felsöka, och kostade en
        // hel mätomgång innan detta fanns.
        dropped.push({ id: q.id, value: value.slice(0, 60) });
      }
    }
    // Validerade inget alls? Skicka med modellens råa svar. Utan det blir
    // felsökningen en gissningslek, och varje gissning kostar en omdeploy.
    const payload: Record<string, unknown> = {
      answers, dropped,
      model: body.model ?? "google/gemini-2.5-flash",
      usage: data?.usage ?? null,
    };
    if (Object.keys(answers).length === 0) payload.raw = raw.slice(0, 400);
    return json(payload);
  } catch (err) {
    clearTimeout(timer);
    return json({ error: "fetch_failed", detail: String(err).slice(0, 200) }, 502);
  }
});

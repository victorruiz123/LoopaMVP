/**
 * Prompter och svarsscheman för produktforskningen.
 *
 * TVÅ ANROP, två scheman. Identifieringen svarar med kandidater; specsökningen med mått och material
 * för EN bekräftad modell. Scheman är JSON Schema (response_format.schema i Interactions API), inte
 * det äldre OpenAPI-formatet — Gemini 3 tillåter strukturerad utdata tillsammans med Google Search
 * och URL context, vilket är hela skälet till att svaret kan vara JSON utan att sökningen stängs av.
 *
 * SCHEMAT ÄR DYNAMISKT DÄR DET SPELAR ROLL. Måtten är en lista av {type, label, value, unit} och
 * materialen en lista av {component, material} — ingen fast uppsättning fält, så ett bord får
 * diameter och skivtjocklek, en lampa skärmdiameter och kabellängd, utan att schemat vet om det i
 * förväg. Det som är fast är formen på ett påstående, inte vilka påståenden som finns.
 */

const str = { type: "string" } as const;
const nullStr = { type: ["string", "null"] } as const;
const nullBool = { type: ["boolean", "null"] } as const;
const nullNum = { type: ["number", "null"] } as const;
const strList = { type: "array", items: str } as const;

export const IDENTIFY_SCHEMA = {
  type: "object",
  properties: {
    category: { ...nullStr, description: "Product type in Swedish, e.g. 'matstol', 'soffa', 'golvlampa'." },
    observations: {
      ...strList,
      description:
        "The concrete construction details visible in the photographs that guided the identification (back, legs, seat, upholstery, finish, fittings, labels).",
    },
    candidates: {
      type: "array",
      minItems: 0,
      maxItems: 4,
      description: "Zero to four models, strongest first. Only models the evidence supports; never padding.",
      items: {
        type: "object",
        properties: {
          brand: str,
          model: { ...str, description: "The model name exactly as the manufacturer spells it, without the brand and without a colour." },
          variant: {
            ...nullStr,
            description: "Only a CONFIRMED variant designation (e.g. '3-sits', 'hög rygg'). Never a guessed colour or an invented article number.",
          },
          productType: nullStr,
          confidence: {
            type: "string",
            enum: ["strong", "likely", "possible"],
            description: "strong = a source documents an appearance that matches the photographs in the details you compared; likely = most details match; possible = could not be excluded.",
          },
          evidence: {
            ...strList,
            description:
              "Concrete details visible in the photographs that match this model's documented appearance, and where you read that documentation (listing title, product page, catalogue). Not generic words like 'white chair'.",
          },
          distinguishingDetail: { ...nullStr, description: "Short, in Swedish: what separates it from the other candidates." },
          sourceUrl: {
            ...nullStr,
            description: "A page about exactly this model that you actually saw in search results or opened (product page, catalogue, or a used-furniture listing). Otherwise null.",
          },
          productPages: {
            ...strList,
            description:
              "Up to 3 pages you actually saw that show a product photograph of exactly this model: the manufacturer's page, a retailer's page, an old catalogue page. Never a used-furniture listing (Blocket, Tradera, Facebook, eBay). Empty array when you saw none.",
          },
          discontinued: nullBool,
        },
        required: ["brand", "model", "variant", "productType", "confidence", "evidence", "distinguishingDetail", "sourceUrl", "productPages", "discontinued"],
      },
    },
    exactMatch: {
      type: "boolean",
      description:
        "True only when the FIRST candidate is the exact model: a source you found documents an appearance that matches the photographs in the construction details you compared, and no other model fits equally well. False in every other case, including when you only found a plausible family.",
    },
    uncertaintyNote: { ...nullStr, description: "What is still unresolved or missing, in Swedish. Null when the identification is solid." },
    summary: {
      ...str,
      description: "Short plain account in Swedish: what you searched, what you compared, why you landed where you did. Name the sources.",
    },
  },
  required: ["category", "observations", "candidates", "exactMatch", "uncertaintyNote", "summary"],
} as const;

export const SPEC_SCHEMA = {
  type: "object",
  properties: {
    identity: {
      type: "object",
      properties: {
        brand: str,
        model: str,
        variant: nullStr,
        category: nullStr,
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        matchesPhotos: { ...nullBool, description: "Stämmer produkten du hittade online överens med bilderna? null om du inte kunde jämföra." },
        note: nullStr,
        discontinued: nullBool,
      },
      required: ["brand", "model", "variant", "category", "confidence", "matchesPhotos", "note", "discontinued"],
    },
    variants: {
      type: "array",
      description:
        "De utföranden produkten säljs eller såldes i som har OLIKA MÅTT (olika sitthöjd, bredd, antal sitsar …). Tom lista när det bara finns ett utförande. Färger och klädslar är inga varianter här.",
      items: {
        type: "object",
        properties: {
          label: { ...str, description: "Kort beteckning som källan använder: '63 cm', '74 cm', '2-sits', 'Utdragen'." },
          differsBy: { ...nullStr, description: "Vilket mått som skiljer: 'sitthöjd', 'bredd' …" },
          sourceUrl: nullStr,
        },
        required: ["label", "differsBy", "sourceUrl"],
      },
    },
    dimensions: {
      type: "array",
      description:
        "ALLA mått du fann dokumenterade, för VARJE utförande i variants (en rad per mått och utförande när värdena skiljer sig; en rad med appliesTo=null när värdet är detsamma). Inga uppskattningar.",
      items: {
        type: "object",
        properties: {
          type: {
            ...str,
            description:
              "Kanonisk typ i snake_case på engelska, t.ex. overall_width, overall_depth, overall_height, length, diameter, seat_width, seat_depth, seat_height, backrest_height, armrest_height, armrest_width, leg_height, clearance_under, tabletop_thickness, extension_length, shade_diameter, shade_height, base_diameter, cable_length, chaise_depth, weight, max_load. Hitta på en passande typ om ingen finns.",
          },
          label: { ...str, description: "Svensk etikett som visas för säljaren, t.ex. 'Bredd', 'Sitthöjd', 'Skärmdiameter'." },
          value: { type: "number" },
          valueMax: { ...nullNum, description: "Övre värde när källan anger ett spann (t.ex. justerbar höjd 65–85). Annars null." },
          unit: { type: "string", enum: ["cm", "mm", "m", "in", "ft", "kg", "g", "lb"] },
          appliesTo: {
            ...nullStr,
            description:
              "Exakt samma beteckning som i variants[].label när måttet bara gäller en variant (t.ex. '63 cm'). Null när måttet är detsamma för alla varianter. ALDRIG en färg och aldrig en etikett som 'Sitthöjd 74 cm' — beteckningen ska vara kort och stå i variants.",
          },
          sourceUrl: { ...nullStr, description: "Adressen till sidan där måttet står. Bara adresser du faktiskt såg eller hämtade." },
          quote: { ...nullStr, description: "Ordagrant citat ur källan som innehåller måttet — högst 12 ord. Kort: svaret skrivs ut token för token och varje onödigt ord kostar tid." },
        },
        required: ["type", "label", "value", "valueMax", "unit", "appliesTo", "sourceUrl", "quote"],
      },
    },
    materials: {
      type: "array",
      description: "ALLA material- och konstruktionsuppgifter per komponent. Inga gissningar ur utseendet.",
      items: {
        type: "object",
        properties: {
          component: { ...str, description: "Delen på svenska: 'Stomme', 'Klädsel', 'Sits', 'Rygg', 'Ben', 'Bordsskiva', 'Stoppning', 'Skärm', 'Ytbehandling'." },
          material: { ...str, description: "Materialet exakt som källan anger, med procent när de finns: 'Massiv björk', '85 % polyester, 15 % bomull'." },
          detail: { ...nullStr, description: "Precisering: ytbehandling, skumtäthet, fanér/massivt, återvunnen andel." },
          appliesTo: { ...nullStr, description: "Bara när materialet skiljer sig mellan varianter eller färger (t.ex. en viss klädselfärg). Annars null." },
          sourceUrl: nullStr,
          quote: { ...nullStr, description: "Ordagrant citat ur källan, högst 12 ord." },
        },
        required: ["component", "material", "detail", "appliesTo", "sourceUrl", "quote"],
      },
    },
    otherFacts: {
      type: "array",
      description: "Andra belagda produktfakta: designer, lanseringsår, artikelnummer som står i källan, max belastning, färgalternativ.",
      items: {
        type: "object",
        properties: {
          label: { ...str, description: "Ren etikett, t.ex. Artikelnummer. Aldrig variant eller färg i etiketten." },
          value: str,
          appliesTo: { ...nullStr, description: "Samma beteckning som i variants[].label när uppgiften bara gäller ett utförande (ett artikelnummer per sitthöjd). Annars null." },
          sourceUrl: nullStr,
        },
        required: ["label", "value", "appliesTo", "sourceUrl"],
      },
    },
    retailPriceSek: { ...nullNum, description: "Nypris i SEK från tillverkare eller återförsäljare (aktuellt eller sista kända). Aldrig från begagnatsajter." },
    retailPriceSourceUrl: nullStr,
    conflicts: { ...strList, description: "Källor som motsäger varandra, med båda värdena och adresserna." },
    missing: { ...strList, description: "Uppgifter du sökte efter men inte kunde belägga." },
    productPages: {
      ...strList,
      description: "Upp till 3 sidor du såg med en produktbild av exakt den här modellen (tillverkare, återförsäljare, katalog). Aldrig begagnatannonser.",
    },
    sourcesUsed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: str,
          title: nullStr,
          kind: { type: "string", enum: ["manufacturer", "manual", "catalog", "retailer", "archive", "other"] },
        },
        required: ["url", "title", "kind"],
      },
    },
    summary: { ...str, description: "Kort redogörelse på svenska för vad du sökte och vilka sidor du läste." },
  },
  required: ["identity", "variants", "dimensions", "materials", "otherFacts", "retailPriceSek", "retailPriceSourceUrl", "conflicts", "missing", "productPages", "sourcesUsed", "summary"],
} as const;



# Edge-funktionen `attribute-vision`

Ligger här, i prismotorns repo, och **inte** i Vips app-repo. Skälet är att den
hör ihop med `type_system/vision_layer.py` som anropar den — ändras frågorna på
ena sidan måste den andra följa med. Den kopieras till Vips-projektet vid deploy.

## Vad den gör

Vidarebefordrar L3:s attributfrågor till Lovable AI Gateway och returnerar
svaren strukturerat. Den finns för att `LOVABLE_API_KEY` är write-only i Lovable
Cloud och alltså inte kan läsas ut till ett fristående mätskript — anropet måste
ske på servern.

Till skillnad från appens övriga bildfunktioner har den **ingen egen uppfattning
om möbeln**. Frågorna kommer från anroparen. Ska L3 mätas måste det vara L3:s
frågor som ställs, inte appens.

## Deploy

1. Kopiera katalogen till `supabase/functions/attribute-vision/` i Vips-projektet.
2. `verify_jwt = false` — den skyddas av en delad hemlighet i stället, se nedan.
3. Sätt hemligheten `ATTRIBUTE_VISION_TOKEN` i projektets secrets.

Funktionen **vägrar svara** om hemligheten inte är satt. Hellre obrukbar än
öppen: en JWT-fri endpoint som bränner AI-krediter är en risk för projektet.

## Anrop från prismotorn

```
VISION_EDGE_URL=https://<ref>.supabase.co/functions/v1/attribute-vision
VISION_EDGE_TOKEN=<samma som ATTRIBUTE_VISION_TOKEN>
VISION_EDGE_MODEL=google/gemini-2.5-flash
```

Sätts de används edge-vägen. Lämnas de tomma ändras ingenting — motorn går mot
OpenAI eller den gateway `AI_BASE_URL` pekar på.

## Påverkan på appen

Ingen. Funktionen är additiv, rör ingen befintlig kod, och kan raderas när
mätningen är klar. Den delar AI-krediter med appen — det är hela poängen — men
förbrukar inget när den inte anropas.

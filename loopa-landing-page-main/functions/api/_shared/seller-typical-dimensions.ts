// Uppskattade mått — sista utvägen när ingen källa gav några.
//
// "Passar den i hallen?" är den vanligaste frågan om en begagnad möbel, och den går inte att svara på
// med bilder. Sökningen hittar måtten för det mesta och sidskörden fyller på med det produktsidan
// skriver, men när båda kommer tomma tillbaka stod annonsen förut helt utan mått — och säljaren fick
// en rad som sa "delvis belagt" utan ett enda tal att gå på.
//
// Därför den här tabellen: standardmått per möbeltyp, satta för att ge RÄTT STORLEKSORDNING, aldrig
// exakthet. En matstol är omkring 45 cm bred; vilken matstol som helst.
//
// Uppskattningen är inte ett belägg och räknas aldrig som ett. Varje attribut härifrån bär
// `estimated: true`, skrivs med "ca" och följs av en not som säger vad det är. `deriveMissingFields`
// ser fortfarande måtten som saknade, statusen står kvar på "delvis belagt", och första riktiga mått
// som dyker upp — ur struktureringen, ur MÅTT-raderna eller ur sidskörden — ersätter uppskattningen.

import type { ProductAttribute } from '../../../src/features/generator/schema'

interface Kind {
  /** Vad möbeln kallas i noten säljaren läser, med obestämd artikel: "en matstol". */
  name: string
  re: RegExp
  /** [bredd, djup, höjd] i cm — eller [längd, bredd, höjd] när `lengthFirst`. Höjd null när möbeln knappt har någon. */
  dims: [number, number, number | null]
  /** Bord och sängar mäts längd × bredd, samma ordning som parseDimensions i web/src/lib/furnitureModel.ts. */
  lengthFirst?: boolean
  /** Sittmöbler får en sitthöjd också — det är måttet som avgör om stolen går till bordet. */
  seatHeight?: number
}

/**
 * Möbeltyperna, SPECIFIKA FÖRST.
 *
 * Ordningen är hela tabellens logik: "kontorsstol" innehåller "stol", "matbord" innehåller "bord",
 * och en kontorsstol som får en matstols mått är sämre än ingen uppskattning alls. Den sista raden
 * matchar allt och finns för att listan aldrig får sluta tomhänt.
 */
const KINDS: Kind[] = [
  { name: 'en hörnsoffa', re: /hörnsoffa|divansoffa|schäslong|soffgrupp/i, dims: [260, 170, 82], seatHeight: 45 },
  { name: 'en bäddsoffa', re: /bäddsoffa|sovsoffa/i, dims: [200, 95, 85], seatHeight: 45 },
  { name: 'en 3-sitssoffa', re: /3-?\s?sits|tresits|tresitsig/i, dims: [210, 90, 82], seatHeight: 45 },
  { name: 'en 2-sitssoffa', re: /2-?\s?sits|tvåsits|tvåsitsig/i, dims: [160, 90, 82], seatHeight: 45 },
  { name: 'en soffa', re: /soffa|sofa|divan/i, dims: [200, 90, 82], seatHeight: 45 },
  { name: 'en kontorsstol', re: /kontorsstol|skrivbordsstol|arbetsstol|gamingstol|office chair/i, dims: [65, 65, 110], seatHeight: 48 },
  { name: 'en barstol', re: /barstol|barpall|counter stool|bar stool/i, dims: [40, 45, 100], seatHeight: 65 },
  { name: 'en matstol', re: /matstol|köksstol|matsalsstol|dining chair/i, dims: [45, 52, 88], seatHeight: 45 },
  { name: 'en fåtölj', re: /fåtölj|öronlapp|loungestol|armchair|lounge chair/i, dims: [75, 80, 85], seatHeight: 42 },
  { name: 'en pall', re: /\bpall\b|puff|sittpuff|fotpall|ottoman/i, dims: [40, 40, 45], seatHeight: 45 },
  { name: 'en stol', re: /stol|chair/i, dims: [47, 53, 85], seatHeight: 45 },
  { name: 'ett matbord', re: /matbord|matsalsbord|köksbord|dining table/i, dims: [160, 90, 75], lengthFirst: true },
  { name: 'ett soffbord', re: /soffbord|salongsbord|coffee table/i, dims: [110, 60, 45], lengthFirst: true },
  { name: 'ett skrivbord', re: /skrivbord|arbetsbord|desk/i, dims: [140, 70, 75], lengthFirst: true },
  { name: 'ett sängbord', re: /sängbord|nattduksbord|nattygsbord|nightstand/i, dims: [40, 35, 55] },
  { name: 'ett sidobord', re: /sidobord|avlastningsbord|hallbord|konsolbord|side table/i, dims: [45, 45, 55] },
  { name: 'ett bord', re: /bord|table/i, dims: [120, 70, 75], lengthFirst: true },
  { name: 'en bokhylla', re: /bokhylla|regal|bookcase/i, dims: [80, 30, 180] },
  { name: 'en vägghylla', re: /vägghylla|hylla|shelf/i, dims: [80, 25, 30] },
  { name: 'en garderob', re: /garderob|klädskåp|wardrobe/i, dims: [100, 60, 200] },
  { name: 'ett vitrinskåp', re: /vitrin/i, dims: [90, 40, 180] },
  { name: 'en tv-bänk', re: /tv-?\s?bänk|mediabänk|tv unit/i, dims: [150, 40, 45] },
  { name: 'en sideboard', re: /sideboard|skänk|buffé/i, dims: [160, 45, 80] },
  { name: 'en byrå', re: /byrå|kommod|hurts|dresser/i, dims: [100, 45, 80] },
  { name: 'ett skåp', re: /skåp|förvaring|cabinet/i, dims: [80, 40, 180] },
  { name: 'en dubbelsäng', re: /dubbelsäng|kontinentalsäng|resårsäng|double bed/i, dims: [200, 160, 60], lengthFirst: true },
  { name: 'en enkelsäng', re: /enkelsäng|single bed/i, dims: [200, 90, 60], lengthFirst: true },
  { name: 'en säng', re: /säng|madrass|bed/i, dims: [200, 140, 60], lengthFirst: true },
  { name: 'en spegel', re: /spegel|mirror/i, dims: [60, 4, 160] },
  { name: 'en golvlampa', re: /golvlampa|floor lamp/i, dims: [40, 40, 150] },
  { name: 'en bordslampa', re: /bordslampa|table lamp/i, dims: [25, 25, 45] },
  { name: 'en matta', re: /matta|rug/i, dims: [230, 160, null], lengthFirst: true },
  { name: 'en möbel av den här typen', re: /./, dims: [80, 50, 80] },
]

/** "ca 45 cm" — ordet står i värdet självt, så uppskattningen syns även där flaggan inte följer med. */
const cm = (n: number) => `ca ${n} cm`

export interface TypicalDimensions {
  attributes: ProductAttribute[]
  /** Vad uppskattningen utgår från, i klartext: "en matstol". */
  basis: string
}

/**
 * Typiska mått för den möbel texten beskriver.
 *
 * Läser kategori, modellnamn, rubrik och säljarens egen anteckning — möbeltypen står sällan i
 * kategorifältet ensamt, men "NORDVIKEN barstol" i rubriken räcker.
 */
export function typicalDimensions(context: Array<string | null | undefined>): TypicalDimensions {
  const text = context.filter(Boolean).join(' ')
  const kind = KINDS.find((k) => k.re.test(text)) ?? KINDS[KINDS.length - 1]
  const [primary, secondary, height] = kind.dims
  const rows: Array<[string, string, number]> = kind.lengthFirst
    ? [['langd', 'Längd', primary], ['bredd', 'Bredd', secondary]]
    : [['bredd', 'Bredd', primary], ['djup', 'Djup', secondary]]
  if (height !== null) rows.push(['hojd', 'Höjd', height])
  if (kind.seatHeight) rows.push(['sitthojd', 'Sitthöjd', kind.seatHeight])
  return {
    basis: kind.name,
    attributes: rows.map(([key, label, value]) => ({ key, label, value: cm(value), sourceUrl: null, estimated: true })),
  }
}

/** Noten som följer med uppskattningen. Samma mening överallt: annonsen, kortet och chatten. */
export function estimatedDimensionsNote(basis: string): string {
  return `Måtten kunde inte beläggas mot någon källa. De som visas är uppskattade utifrån typiska mått för ${basis} — kontrollera dem med tumstock innan du publicerar.`
}

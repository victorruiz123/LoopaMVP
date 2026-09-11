import { useId, useMemo } from "react";
import { buildFaces, fitPoints, project, type Vec3, type View } from "../lib/render3d";
import { buildModel, type Archetype, type Dimensions, type ModelContext } from "../lib/furnitureModel";
import ShadedFaces from "./ShadedFaces";

/**
 * Tre möbler i ett rum under löftet. Bara på datorn, och de står stilla.
 *
 * VARFÖR DE FINNS. Datorvyns vänsterspalt säger sitt på fyra rader och lämnade sedan en halv skärm
 * tom ned till foten. Tomrummet var inte lugnt utan oavslutat: sidan såg ut att ha tagit slut mitt
 * i. Det som fyller det ska varken tävla med märkeslistan om trycket eller vara dekor — och möbler
 * som vrider sig är precis vad tjänsten GÖR: den ser en möbel från alla håll.
 *
 * DE ÄR INTE BILDER. Samma 3D-motor som ritar möbeln på annonskortet och i varvguiden ritar dem här
 * (render3d + furnitureModel), med samma ljus och samma ytor. Alltså inga foton att ladda, ingen
 * transparent PNG som ser fel ut mot en annan bakgrund, och möbler som per definition ser ut som
 * appens egna. Bakgrunden är ingen: sidans krämvita lyser igenom, och det enda som ligger under
 * varje möbel är dess egen kontaktskugga — utan den svävar de.
 *
 * DE STÅR STILLA. Här låg först en vaggning per möbel och sedan en långsam kamera som gled över hela
 * uppställningen. Båda gjorde samma sak fast olika mycket: de drog blicken. En sida vars enda
 * handling är att välja märke i listan bredvid har inte råd med en rörelse i ögonvrån, hur långsam
 * den än är — och en möbel som står still är dessutom det ärligaste den kan göra.
 *
 * Att den är statisk är därför en FORMGIVNING och inte något som blev över: ingen klocka, inget
 * requestAnimationFrame, inget att pausa när rutan rullas ur bild. Vinkeln nedan ÄR bilden.
 */

interface Pjas {
  archetype: Archetype;
  dims: [number, number, number];
  ctx: ModelContext;
  /** Rutans mått i bildpunkter. Bara ritytan — storleken på sidan bestäms av `bredd` nedan. */
  w: number;
  h: number;
  /** Andel av ytans bredd. Det här är möbelns STORLEK, och skalan är avståndet. */
  bredd: number;
  /** Var den står, i andel av ytan. `vanster` från vänsterkanten, `golv` från underkanten. */
  vanster: number;
  golv: number;
  /** Längre bort = svagare. Luften mellan möblerna, sagd med opacitet i stället för med dimma. */
  dis: number;
}

/**
 * Uppställningen är ett RUM, inte en rad.
 *
 * Ordningen i listan är målningsordningen: längst bort först, närmast sist, så en soffa som skjuter
 * fram över bordet bakom den gör just det. Det som står högt upp i ytan står längre bort och är
 * därför mindre och svagare — samma tre knep som varje rumsbild använder, och de är det som gör att
 * fyra möbler på en tom yta läser som ett rum i stället för som fyra ikoner.
 *
 * Talen är andelar och inte bildpunkter: ytan är en spalt som växer med fönstret, och en komposition
 * i pixlar hade fallit isär vid varje annan bredd.
 */
const PJASER: Pjas[] = [
  // Fåtöljen står nu där byrån stod: en bit in i rummet, mitt emellan soffan och högerkanten. Den
  // är den andra möbeln man ser efter soffan, och därför den största av de två som inte är soffan.
  { archetype: "chair", dims: [76, 80, 90], ctx: { title: "fåtölj", variant: "mörkgrön" },
    w: 170, h: 210, bredd: 0.4, vanster: 0.38, golv: 0.42, dis: 0.9 },
  // Byrån längst till höger, i samma djup som soffan.
  { archetype: "cabinet", dims: [116, 46, 84], ctx: { title: "byrå", variant: "valnöt" },
    w: 190, h: 170, bredd: 0.3, vanster: 0.69, golv: 0.0, dis: 0.94 },
  // Och närmast: soffan. Störst med marginal, längst ned till vänster — den möbel folk kommer hit
  // med, och den enda som får ta halva ytan.
  { archetype: "sofa", dims: [212, 90, 76], ctx: { title: "3-sits soffa", variant: "linne" },
    w: 340, h: 210, bredd: 0.62, vanster: 0, golv: 0, dis: 1 },
];

/** Vinkeln möblerna vilar i: snett framifrån, en aning ovanifrån — samma vy som annonskortets. */
const BAS_YAW = -0.62;
const PITCH = 0.24;
/** Golvlinjens höjd över rutans underkant. Samma för alla tre — se `gyRatt` nedan. */
const GOLV_FRAN_BOTTEN = 16;

export default function MobelParad() {
  return (
    // Ren utsmyckning: ingenting här bär information som inte redan står i texten ovanför.
    <div className="mobel-parad" aria-hidden="true">
      {PJASER.map((p) => (
        <Mobel key={p.archetype} pjas={p} />
      ))}
    </div>
  );
}

function Mobel({ pjas }: { pjas: Pjas }) {
  const uid = useId().replace(/:/g, "");
  const [bredd, djup, hojd] = pjas.dims;

  const model = useMemo(() => {
    const dims: Dimensions = { width: bredd, depth: djup, height: hojd, assumed: [] };
    return buildModel(pjas.archetype, dims, [], pjas.ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pjas.archetype]);

  // Samma regel som på kortet: avståndet skalas med möbeln, annars får soffan vidvinkel och bordet
  // teleobjektiv.
  const distance = Math.max(bredd, djup, hojd) * 3.8;

  /** Passningen mäts över ett helt varv och är därför oberoende av vaggningen — se fitPoints. */
  const fit = useMemo(() => {
    const points: Vec3[] = [];
    for (const b of model.boxes) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            points.push({
              x: b.center.x + (sx * b.size.x) / 2,
              y: b.center.y + (sy * b.size.y) / 2,
              z: b.center.z + (sz * b.size.z) / 2,
            });
          }
        }
      }
    }
    return fitPoints(points, PITCH, distance, pjas.w, pjas.h, 10);
  }, [model, distance, pjas.w, pjas.h]);

  const yaw = BAS_YAW;

  /**
   * ALLA TRE STÅR PÅ SAMMA GOLV, och det är hela skillnaden mellan tre möbler i ett rum och tre
   * ikoner på rad.
   *
   * `fitPoints` centrerar varje möbel i sin egen ruta, så en hög fåtölj och ett lågt bord får sina
   * golvlinjer på olika höjd — bottenställda bredvid varandra ser de ut att sväva olika mycket.
   * Golvet flyttas därför till en fast höjd över rutans underkant, lika för alla tre. Det som
   * hamnar utanför rutan uppåt ritas ändå (`overflow: visible` i CSS:en).
   */
  const gyRatt = pjas.h - GOLV_FRAN_BOTTEN;
  const gyNu = project({ x: 0, y: 0, z: 0 }, { yaw, pitch: PITCH, distance, ...fit }).at(1) as number;
  const view: View = { yaw, pitch: PITCH, distance, ...fit, cy: fit.cy + (gyRatt - gyNu) };
  const faces = buildFaces(model.boxes, view, model.palette);

  // Kontaktskuggan: en mjuk oval på golvet under möbeln. Den ligger i samma svg och vrids med
  // vyn, så den följer möbelns fotavtryck i stället för att vara en fläck som råkar ligga där.
  const [sx, sy] = project({ x: 0, y: 0, z: 0 }, view);
  const rx = (bredd / 2) * fit.scale * 1.02;
  const ry = (djup / 2) * fit.scale * PITCH * 1.5;

  return (
    <svg
      className="mobel-parad-pjas"
      viewBox={`0 0 ${pjas.w} ${pjas.h}`}
      style={{
        width: `${pjas.bredd * 100}%`,
        left: `${pjas.vanster * 100}%`,
        bottom: `${pjas.golv * 100}%`,
        opacity: pjas.dis,
      }}
    >
      <defs>
        <radialGradient id={`${uid}skugga`}>
          <stop offset="0" stopColor="rgb(58 42 26 / 0.24)" />
          <stop offset="0.6" stopColor="rgb(58 42 26 / 0.1)" />
          <stop offset="1" stopColor="rgb(58 42 26 / 0)" />
        </radialGradient>
      </defs>
      <ellipse cx={sx} cy={sy} rx={rx} ry={Math.max(4, ry)} fill={`url(#${uid}skugga)`} />
      <ShadedFaces faces={faces} />
    </svg>
  );
}

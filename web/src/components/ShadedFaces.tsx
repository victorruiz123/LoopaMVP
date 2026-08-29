import { useId } from "react";
import { LIGHT_GRADIENT, type Face } from "../lib/render3d";

/**
 * Ytorna ur render3d, utritade.
 *
 * Egen komponent för att BÅDA ställen som ritar möbler använder den — truth-cardets modell och
 * varvguiden på inspelningsskärmen. En toning som ritas på två håll blir förr eller senare två
 * utseenden, och då ritar appen möbler på två sätt igen.
 *
 * Varje yta får sin egen toning i stället för en platt fyllning. Det är skillnaden mellan en yta som
 * ser gjuten ut och en som ser ut att vara belyst: riktningen är densamma för alla (ljuset står
 * stilla, se render3d), bara ändpunkternas ton skiljer.
 */
export default function ShadedFaces({ faces }: { faces: Face[] }) {
  // useId ger kolon, som inte får stå i en url(#…)-hänvisning i alla motorer.
  const uid = useId().replace(/:/g, "");
  return (
    <>
      <defs>
        {faces.map((f, i) => (
          <linearGradient key={i} id={`${uid}f${i}`} {...LIGHT_GRADIENT}>
            <stop offset="0" stopColor={f.light} />
            <stop offset="1" stopColor={f.dark} />
          </linearGradient>
        ))}
      </defs>
      {faces.map((f, i) => (
        <path key={i} d={f.path} fill={`url(#${uid}f${i})`} />
      ))}
    </>
  );
}

// Utvecklingsvy: renderar möbelmodellen utan att gå genom inloggningen. Ingår inte i appen.
import { createRoot } from "react-dom/client";
import FurnitureRender from "../components/FurnitureRender";
import { archetypeFor, buildModel, parseDimensions } from "../lib/furnitureModel";

const attrs = [
  { key: "w", label: "Bredd", value: "81 cm" },
  { key: "d", label: "Djup", value: "92 cm" },
  { key: "h", label: "Höjd", value: "80–82 cm" },
  { key: "s", label: "Sitthöjd", value: "44 cm" },
  { key: "m", label: "Klädsel", value: "Tyg, mörkgrå" },
];
const title = "Fåtölj i mörkgrått tyg";
const archetype = archetypeFor("Fåtölj", title);
const model = buildModel(archetype, parseDimensions(attrs, archetype)!, attrs, {
  category: "Fåtölj",
  title,
  variant: "Mörkgrå",
});

const el = document.getElementById("root")!;
el.style.cssText = "max-width:390px;margin:0 auto;padding:16px";
createRoot(el).render(<FurnitureRender model={model} />);

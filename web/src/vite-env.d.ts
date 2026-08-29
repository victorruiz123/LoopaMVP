/// <reference types="vite/client" />

// Vites klienttyper, som ger `import.meta.env`. Utan den här filen är `import.meta` bara ES-standardens
// tomma objekt, och varje `import.meta.env.VITE_*` blir ett typfel — vilket det blev när
// inloggningskoden lades till.

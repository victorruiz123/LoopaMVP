// Skriver talfilen som voice-tour-e2e.mjs använder som mikrofon.
//
//   node tests/voice-tour-audio.mjs            -> tests/voice-tour-tal.wav
//
// Windows egen talsyntes (SAPI via PowerShell). Ingen nedladdning, ingen nyckel, inget beroende.
//
// Rösten är ENGELSK — Windows har sällan en svensk installerad — och läser ändå svensk text. Det
// låter fel, men Avalon hörde igenom det första gången det provades:
//
//   "Det har är ett soffbord i ekfrän IKEA har på kantinfins en repa ungefär fem centimeter lang"
//
// Både "IKEA" och "repa" kom fram, alltså precis de två orden testet hänger på: märkesdetekteringen
// och skadeordlistan. Ett dåligt uttal är dessutom ett ÄRLIGARE test än en perfekt röst — säljare
// pratar otydligt, i rum med eko, medan de går.
//
// Texten är medvetet skriven utan å/ä/ö där det går: den engelska rösten läser dem som engelska
// bokstäver och gör transkriptet sämre än en svensk talare skulle.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const OUT = process.argv[2] ?? new URL("./voice-tour-tal.wav", import.meta.url).pathname.slice(1);
const RAW = path.join(mkdtempSync(path.join(tmpdir(), "vt-")), "sapi.wav");

const LINES = [
  "Det har ar ett soffbord i ek fran IKEA.",
  "Har pa kanten finns en repa, ungefar fem centimeter lang.",
  "Annars ar bordet i fint skick.",
];

const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile(${JSON.stringify(RAW)}, $fmt)
$s.Rate = -2
${LINES.map((l) => `$s.Speak(${JSON.stringify(l)})`).join("\n")}
$s.SetOutputToNull(); $s.Dispose()
`;
execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "ignore", "inherit"] });

/**
 * SAPI skriver ett fmt-block på 18 byte (med cbSize-tillägg). Skriv om filen kanoniskt — en strikt
 * läsare längre fram ska aldrig kunna fälla testet på en headerdetalj som inte har med saken att göra.
 */
const raw = readFileSync(RAW);
let off = 12;
let pcm = null;
while (off < raw.length) {
  const id = raw.toString("ascii", off, off + 4);
  const size = raw.readUInt32LE(off + 4);
  if (id === "data") {
    pcm = raw.subarray(off + 8, off + 8 + size);
    break;
  }
  off += 8 + size + (size % 2);
}
if (!pcm) throw new Error("hittade ingen data-chunk i SAPI-filen");

const SR = 16000;
const head = Buffer.alloc(44);
head.write("RIFF", 0);
head.writeUInt32LE(36 + pcm.length, 4);
head.write("WAVEfmt ", 8);
head.writeUInt32LE(16, 16);
head.writeUInt16LE(1, 20);
head.writeUInt16LE(1, 22);
head.writeUInt32LE(SR, 24);
head.writeUInt32LE(SR * 2, 28);
head.writeUInt16LE(2, 32);
head.writeUInt16LE(16, 34);
head.write("data", 36);
head.writeUInt32LE(pcm.length, 40);

writeFileSync(OUT, Buffer.concat([head, pcm]));
console.info(`${OUT} — ${(pcm.length / (SR * 2)).toFixed(1)} s tal, 16 kHz mono`);

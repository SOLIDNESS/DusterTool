/**
 * Buduje pliki logo z siatki pikseli assets/logo/duster-logo.txt (96x96):
 *   . tlo   # pylek   o bialko oka   X zrenica
 *
 *   npx tsx scripts/dev/make-logo.ts
 *
 * Wynik w assets/logo: SVG i PNG z zoltym tlem (ikona tokena) oraz sama postac na przezroczystym tle.
 * Do tego ikona strony (web/public/favicon.svg, uzywana tez w naglowku): to samo logo przyciete
 * ciasniej wokol postaci, zeby bylo czytelne w malym rozmiarze, oraz sama postac jako modul
 * web/src/lib/mascot.ts (strona rysuje ja na monecie).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const DIR = "assets/logo";
const COLORS: Record<string, [number, number, number]> = {
  ".": [0xff, 0xcc, 0x00],
  "#": [0x17, 0x0c, 0x21],
  o: [0xff, 0xff, 0xff],
  X: [0x00, 0x00, 0x00],
};
const hex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

const grid = readFileSync(`${DIR}/duster-logo.txt`, "utf8").trim().split("\n");
const N = grid.length;
if (grid.some((r) => r.length !== N)) throw new Error("siatka musi byc kwadratowa");

/** Prostokaty: ciagi jednakowych pikseli w wierszu. */
function runs(skip: string) {
  const out: { x: number; y: number; w: number; ch: string }[] = [];
  grid.forEach((row, y) => {
    for (let x = 0; x < N; ) {
      let e = x;
      while (e < N && row[e] === row[x]) e++;
      if (!skip.includes(row[x])) out.push({ x, y, w: e - x, ch: row[x] });
      x = e;
    }
  });
  return out;
}

interface Box {
  x: number;
  y: number;
  size: number;
}
const FULL: Box = { x: 0, y: 0, size: N };

/** Kwadrat wokol postaci z marginesem `margin` pikseli siatki. */
function cropBox(margin: number): Box {
  const all = runs(".");
  const x0 = Math.min(...all.map((r) => r.x));
  const x1 = Math.max(...all.map((r) => r.x + r.w));
  const y0 = Math.min(...all.map((r) => r.y));
  const y1 = Math.max(...all.map((r) => r.y + 1));
  const size = Math.min(N, Math.max(x1 - x0, y1 - y0) + 2 * margin);
  const clamp = (v: number) => Math.max(0, Math.min(N - size, v));
  return { x: clamp(Math.round((x0 + x1 - size) / 2)), y: clamp(Math.round((y0 + y1 - size) / 2)), size };
}

function svg(background: boolean, box: Box = FULL) {
  const rects = runs(".").map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${hex(COLORS[r.ch])}"/>`);
  const bg = background ? `<rect x="${box.x}" y="${box.y}" width="${box.size}" height="${box.size}" fill="${hex(COLORS["."])}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.size} ${box.size}" shape-rendering="crispEdges">${bg}${rects.join("")}</svg>\n`;
}

/** Postac dla strony (moneta w naglowku i w okienku): wiersze siatki przyciete do postaci i ich polozenie. */
function mascotModule() {
  const all = runs(".");
  const x0 = Math.min(...all.map((r) => r.x));
  const x1 = Math.max(...all.map((r) => r.x + r.w));
  const y0 = Math.min(...all.map((r) => r.y));
  const y1 = Math.max(...all.map((r) => r.y + 1));
  const rows = grid.slice(y0, y1).map((r) => r.slice(x0, x1));
  return [
    "// Plik generowany przez scripts/dev/make-logo.ts - nie edytuj recznie.",
    "// Postac z logo: # pylek, o bialko oka, X zrenica, . puste. `x`, `y` to polozenie w siatce `size` x `size`.",
    `export const MASCOT = { size: ${N}, x: ${x0}, y: ${y0}, rows: ${JSON.stringify(rows, null, 2)} };`,
    "",
  ].join("\n");
}

// --- PNG bez zaleznosci ---
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type: string, body: Buffer) {
  const data = Buffer.concat([Buffer.from(type, "ascii"), body]);
  let c = 0xffffffff;
  for (const b of data) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, data, crc]);
}
function png(size: number, background: boolean) {
  const scale = size / N;
  if (!Number.isInteger(scale)) throw new Error(`rozmiar ${size} nie jest wielokrotnoscia ${N}`);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = grid[Math.floor(y / scale)];
    for (let x = 0; x < size; x++) {
      const ch = row[Math.floor(x / scale)];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const [r, g, b] = COLORS[ch];
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = ch === "." && !background ? 0 : 255;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(`${DIR}/duster-logo.svg`, svg(true));
writeFileSync(`${DIR}/duster-mascot.svg`, svg(false));
writeFileSync("web/public/favicon.svg", svg(true, cropBox(5)));
writeFileSync("web/src/lib/mascot.ts", mascotModule());
writeFileSync(`${DIR}/duster-logo-960.png`, png(960, true));
writeFileSync(`${DIR}/duster-logo-480.png`, png(480, true));
writeFileSync(`${DIR}/duster-mascot-480.png`, png(480, false));
console.log(`logo zapisane w ${DIR} (siatka ${N}x${N})`);

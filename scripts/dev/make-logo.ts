/**
 * Buduje pliki logo z siatki pikseli assets/logo/duster-logo.txt (96x96):
 *   . tlo   # pylek   o bialko oka   X zrenica
 *
 *   npx tsx scripts/dev/make-logo.ts
 *
 * Wynik w assets/logo: SVG i PNG z zoltym tlem (ikona tokena) oraz sama postac na przezroczystym tle.
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

function svg(background: boolean) {
  const rects = runs(".").map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${hex(COLORS[r.ch])}"/>`);
  const bg = background ? `<rect width="${N}" height="${N}" fill="${hex(COLORS["."])}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">${bg}${rects.join("")}</svg>\n`;
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
writeFileSync(`${DIR}/duster-logo-960.png`, png(960, true));
writeFileSync(`${DIR}/duster-logo-480.png`, png(480, true));
writeFileSync(`${DIR}/duster-mascot-480.png`, png(480, false));
console.log(`logo zapisane w ${DIR} (siatka ${N}x${N})`);

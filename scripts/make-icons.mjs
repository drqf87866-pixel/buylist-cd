/**
 * Erzeugt die PWA-Icons (icon-192.png, icon-512.png) als einfache PNGs –
 * warmes Papier als Hintergrund, grünes Häkchen. Kein Canvas nötig:
 * PNG wird per Hand kodiert (zlib ist in Node eingebaut).
 *
 * Ausführen: node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "public");

// Farben (entsprechen dem CSS der App)
const BG = [247, 243, 234]; // --bg (warmes Papier)
const LEAF = [30, 122, 70]; // --leaf
const WHITE = [255, 253, 247];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, pixelFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 3));
  let off = 0;
  for (let y = 0; y < height; y++) {
    raw[off++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[off++] = r;
      raw[off++] = g;
      raw[off++] = b;
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Häkchen-Segmente in normalisierten Koordinaten (0..1, y nach unten):
 * zwei dicke Linien, 45°-Strich von unten links und Haken nach oben rechts.
 */
function checkmarkAlpha(x01, y01, thickness01) {
  // Punkt A (links unten) → B (Mitte) → C (rechts oben)
  const ax = 0.28, ay = 0.55;
  const bx = 0.44, by = 0.71;
  const cx = 0.74, cy = 0.34;
  const distToSeg = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx, qy = y1 + t * dy;
    return Math.hypot(px - qx, py - qy);
  };
  const d1 = distToSeg(x01, y01, ax, ay, bx, by);
  const d2 = distToSeg(x01, y01, bx, by, cx, cy);
  return Math.min(d1, d2) <= thickness01 ? 1 : 0;
}

function makeIcon(size) {
  const leafRadius = size * 0.5; // grüner Kreis
  const center = size / 2;
  const thick = size * 0.09;
  return encodePng(size, size, (x, y) => {
    const dx = x + 0.5 - center;
    const dy = y + 0.5 - center;
    const inLeaf = Math.hypot(dx, dy) <= leafRadius;
    if (!inLeaf) return BG;
    const onCheck = checkmarkAlpha((x + 0.5) / size, (y + 0.5) / size, thick / size) === 1;
    return onCheck ? WHITE : LEAF;
  });
}

for (const size of [192, 512]) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), makeIcon(size));
  console.log(`icon-${size}.png geschrieben (${size}x${size})`);
}

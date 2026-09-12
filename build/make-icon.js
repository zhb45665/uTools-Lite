// Minimal PNG encoder to generate app/tray icons without external deps.
// Produces a rounded-square "uTools-lite" style glyph (blue rounded square).
// Outputs: icon.png (256x256, exe/taskbar) and tray-icon.png (32x32, system tray).
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

let crcTable;
function makeCrcTable() {
  crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
}
function crc32(buf) {
  if (!crcTable) makeCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makePNG(width, height, pixelFn) {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = (y * width + x) * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 4 + 1)] = 0; // filter: none
    raw.copy(
      scanlines,
      y * (width * 4 + 1) + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }
  const idat = zlib.deflateSync(scanlines);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Render the icon at the given size; all geometry is relative to S. */
function renderIcon(S) {
  const cx = S / 2,
    cy = S / 2;
  const corner = S * 0.22; // corner radius

  function inRoundedSquare(x, y) {
    const m = S * 0.04; // margin
    const x0 = m,
      y0 = m,
      x1 = S - m,
      y1 = S - m;
    const r = corner;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    // check corner regions
    const ccx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
    const ccy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
    const dx = x - ccx,
      dy = y - ccy;
    // if in a corner box, require within radius
    const inCornerBox =
      (x < x0 + r || x > x1 - r) && (y < y0 + r || y > y1 - r);
    if (inCornerBox) return dx * dx + dy * dy <= r * r;
    return true;
  }

  // Simple "u" glyph: two vertical bars joined by a bottom arc.
  function inGlyph(x, y) {
    const gw = S * 0.42; // glyph width
    const gh = S * 0.5; // glyph height
    const left = cx - gw / 2;
    const top = cy - gh / 2 + S * 0.04;
    const bar = S * 0.09; // bar thickness
    const bottom = top + gh;
    // left bar
    if (x >= left && x <= left + bar && y >= top && y <= bottom) return true;
    // right bar
    if (x >= left + gw - bar && x <= left + gw && y >= top && y <= bottom)
      return true;
    // bottom arc (U curve)
    const arcCx = cx;
    const arcCy = bottom - gh * 0.0; // center near bottom
    const outerR = gw / 2;
    const innerR = gw / 2 - bar;
    const dx = x - arcCx;
    const dy = y - (bottom - bar / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (
      y >= bottom - bar * 1.5 &&
      d <= outerR &&
      d >= innerR &&
      y >= arcCy - outerR
    ) {
      // only bottom half of the ring
      if (y >= arcCy) return true;
    }
    return false;
  }

  return makePNG(S, S, (x, y) => {
    if (!inRoundedSquare(x, y)) return [0, 0, 0, 0];
    if (inGlyph(x, y)) return [255, 255, 255, 255];
    // blue fill with slight vertical gradient
    const t = y / S;
    return [
      Math.round(37 + t * 20),
      Math.round(99 + t * 30),
      Math.round(235 - t * 20),
      255,
    ];
  });
}

const outDir = path.join(__dirname);
const iconPath = path.join(outDir, "icon.png");
const trayPath = path.join(outDir, "tray-icon.png");
fs.writeFileSync(iconPath, renderIcon(256));
fs.writeFileSync(trayPath, renderIcon(32));
console.log("wrote", iconPath, fs.statSync(iconPath).size, "bytes");
console.log("wrote", trayPath, fs.statSync(trayPath).size, "bytes");

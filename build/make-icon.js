// Minimal PNG encoder to generate app/tray icons without external deps.
// Produces a simple quick-launch glyph: one bold bolt.
// Outputs: icon.png (256x256, exe/taskbar) and tray-icon.png (32x32, system tray).
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

// Preserve the approved AI-designed assets on later builds. The procedural
// renderer below is only a fallback when a checkout is missing either file.
const approvedIcon = path.join(__dirname, "icon.png");
const approvedTray = path.join(__dirname, "tray-icon.png");
if (fs.existsSync(approvedIcon) && fs.existsSync(approvedTray)) {
  console.log("using approved icon assets");
  process.exit(0);
}

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

  // A single bold quick-action bolt. Broad geometry stays crisp at 16px.
  function inGlyph(x, y) {
    const px = x / S, py = y / S;
    const bolt = [[.58,.20],[.32,.55],[.50,.55],[.42,.82],[.72,.43],[.54,.43]];
    let inside = false;
    for (let i = 0, j = bolt.length - 1; i < bolt.length; j = i++) {
      const [xi, yi] = bolt[i], [xj, yj] = bolt[j];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  return makePNG(S, S, (x, y) => {
    if (!inRoundedSquare(x, y)) return [0, 0, 0, 0];
    if (inGlyph(x, y)) return [255, 255, 255, 255];
    // Deep indigo-to-blue gradient, aligned with the launcher's accent.
    const t = y / S;
    return [
      Math.round(38 + t * 18),
      Math.round(67 + t * 45),
      Math.round(184 + t * 48),
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

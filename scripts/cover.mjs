// Generates cover.png (800x534) for gladys-energi-data-service: plain Node, no
// dependency. A power pylon with its lines, the 24 hourly prices of a Danish
// grid tariff (the 17-21 peak in red) and a day/night price band, on a
// red-to-dark gradient (no logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.7 + (y / H) * 0.3;
  return [150 - 100 * t, 30 + 10 * t, 50 + 40 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

const grey = [190, 198, 212];
const amber = [245, 180, 60];
const blue = [120, 190, 250];

disc(400, 270, 260, white, 0.05);

// A pylon: two legs, cross braces, three arms and the lines leaving it.
line(150, 470, 210, 120, 8, grey);
line(270, 470, 210, 120, 8, grey);
for (let k = 0; k < 5; k += 1) {
  const y0 = 440 - k * 62;
  const y1 = y0 - 62;
  const w = (y) => 60 * ((y - 120) / 350);
  line(210 - w(y0), y0, 210 + w(y1), y1, 4, grey);
  line(210 + w(y0), y0, 210 - w(y1), y1, 4, grey);
}
for (const [y, half] of [
  [150, 90],
  [200, 110],
  [250, 80],
]) {
  line(210 - half, y, 210 + half, y, 7, grey);
  line(210 + half, y + 4, 560, y + 60, 2, white);
}

// The hourly tariff: night low, day middle, the 17-21 peak in red.
const red = [235, 60, 70];
for (let h = 0; h < 24; h += 1) {
  const peak = h >= 17 && h < 21;
  const height = h < 6 ? 50 : peak ? 240 : 100;
  const x = 474 + h * 12;
  box(x, 440 - height, x + 9, 440, 3, peak ? red : white, peak ? 1 : 0.85);
}
line(470, 446, 760, 446, 4, white);

// The price of the day: a band, night cheap (blue), day dear (amber).
box(470, 70, 760, 110, 12, dark, 0.6);
box(478, 78, 560, 102, 8, blue);
box(556, 78, 704, 102, 2, amber);
box(700, 78, 752, 102, 8, blue);
// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');

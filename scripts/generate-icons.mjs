import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, '..', 'icons');

/**
 * Compute standard CRC32 for PNG chunks.
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lengthBytes, typeBytes, data, crcBytes]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function clamp(v, min = 0, max = 255) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

function blendPixel(buf, idx, r, g, b, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const inv = 1 - a;
  buf[idx] = clamp(buf[idx] * inv + r * a);
  buf[idx + 1] = clamp(buf[idx + 1] * inv + g * a);
  buf[idx + 2] = clamp(buf[idx + 2] * inv + b * a);
  buf[idx + 3] = clamp(Math.max(buf[idx + 3], a * 255));
}

function signedDistanceRoundedRect(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;

  const denom = dot00 * dot11 - dot01 * dot01;
  if (denom === 0) return false;
  const invDenom = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
  return u >= 0 && v >= 0 && u + v <= 1;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const half = size * 0.46;
  const radius = size * 0.22;

  // Spark center (top-left quadrant)
  const sx = size * 0.37;
  const sy = size * 0.36;
  const sparkRadius = size * 0.19;

  // Cursor polygon vertices (bottom-right quadrant)
  const p1 = [size * 0.50, size * 0.44];
  const p2 = [size * 0.50, size * 0.79];
  const p3 = [size * 0.61, size * 0.69];
  const p4 = [size * 0.74, size * 0.80];
  const p5 = [size * 0.80, size * 0.73];
  const p6 = [size * 0.67, size * 0.62];
  const p7 = [size * 0.80, size * 0.58];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const idx = (y * size + x) * 4;

      const dist = signedDistanceRoundedRect(px, py, center, center, half, half, radius);
      if (dist > 1) {
        continue;
      }

      const bgAlpha = dist <= 0 ? 1 : Math.max(0, 1 - dist);
      const t = (px + py) / (2 * size);
      // Indigo -> Blue -> Cyan gradient
      const bgR = 37 + (14 - 37) * t;
      const bgG = 99 + (165 - 99) * t;
      const bgB = 235 + (233 - 235) * t;

      rgba[idx] = clamp(bgR);
      rgba[idx + 1] = clamp(bgG);
      rgba[idx + 2] = clamp(bgB);
      rgba[idx + 3] = clamp(bgAlpha * 255);

      // Subtle inner highlight ring near top-left
      const glow = Math.max(0, 1 - Math.hypot(px - size * 0.3, py - size * 0.25) / (size * 0.65));
      blendPixel(rgba, idx, 186, 230, 253, glow * 0.24 * bgAlpha);

      // 4-point Gemini spark
      const dx = Math.abs(px - sx) / sparkRadius;
      const dy = Math.abs(py - sy) / sparkRadius;
      const sparkMetric = Math.pow(dx, 0.55) + Math.pow(dy, 0.55);
      if (sparkMetric <= 1.05) {
        const sparkAlpha = sparkMetric <= 0.9 ? 1 : (1.05 - sparkMetric) / 0.15;
        blendPixel(rgba, idx, 255, 255, 255, sparkAlpha * bgAlpha);
      }

      // Pointer cursor arrow
      const inCursorBody =
        pointInTriangle(px, py, ...p1, ...p2, ...p3) ||
        pointInTriangle(px, py, ...p1, ...p3, ...p7) ||
        pointInTriangle(px, py, ...p3, ...p6, ...p7) ||
        pointInTriangle(px, py, ...p3, ...p4, ...p5) ||
        pointInTriangle(px, py, ...p3, ...p5, ...p6);

      if (inCursorBody) {
        blendPixel(rgba, idx, 254, 240, 138, 0.98 * bgAlpha);
      }
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = renderIcon(size);
  writeFileSync(resolve(iconsDir, `icon${size}.png`), png);
}
console.log('Generated icons: icon16.png, icon48.png, icon128.png');

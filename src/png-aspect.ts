/**
 * Post-process a PNG written by WinUAE's `screenshot` monitor command.
 *
 * Upstream's screenshot is the raw frame buffer: one pixel per lores,
 * hires or superhires pixel horizontally (gfx_resolution 0/1/2) against
 * one line per field or frame vertically (gfx_vresolution 0/1/2). For the
 * aspect the display shows, X is scaled by 2^(vresolution - resolution),
 * which the server reports under `capabilities.display`.
 *
 * The alpha channel carries the genlock key when genlock_alpha is on;
 * it is made opaque unless the caller wants to keep it.
 */

import { inflateSync } from 'zlib';
import { encodePngRgba } from './bitmap-decode.js';

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG. Returns null for anything else. */
export function decodePngRgba(png: Buffer): DecodedPng | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 33 || !png.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    return null;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) return null;

  const pixels = Buffer.alloc(stride * height);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y ? pixels.subarray((y - 1) * stride, y * stride) : prev;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = up[x];
      const c = x >= channels ? up[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: return null;
      }
      out[x] = v & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/**
 * Scale X by a power of two: 2^shift. A negative shift averages 2^-shift
 * neighbouring pixels (raw superhires to the displayed width); a positive
 * one repeats pixels. Rows are untouched.
 */
export function scaleX(img: DecodedPng, shift: number): DecodedPng {
  if (!shift) return img;
  const { width, height, rgba } = img;
  if (shift < 0) {
    const n = 1 << -shift;
    const w = Math.max(1, Math.floor(width / n));
    const out = Buffer.alloc(w * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < w; x++) {
        for (let ch = 0; ch < 4; ch++) {
          let sum = 0;
          for (let k = 0; k < n; k++) sum += rgba[(y * width + x * n + k) * 4 + ch];
          out[(y * w + x) * 4 + ch] = Math.round(sum / n);
        }
      }
    }
    return { width: w, height, rgba: out };
  }
  const n = 1 << shift;
  const w = width * n;
  const out = Buffer.alloc(w * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      for (let k = 0; k < n; k++) rgba.copy(out, (y * w + x * n + k) * 4, src, src + 4);
    }
  }
  return { width: w, height, rgba: out };
}

export interface ScreenshotFixResult {
  png: Buffer;
  rawWidth: number;
  rawHeight: number;
  width: number;
  height: number;
  xShift: number;
  alphaKept: boolean;
  processed: boolean;
}

/**
 * Correct a raw WinUAE screenshot to display aspect and, unless keepAlpha,
 * make it opaque. A PNG this cannot decode is returned unchanged.
 */
export function fixScreenshotPng(
  png: Buffer,
  resolution: number,
  vresolution: number,
  options: { aspect: boolean; keepAlpha: boolean },
): ScreenshotFixResult {
  const decoded = decodePngRgba(png);
  if (!decoded) {
    return { png, rawWidth: 0, rawHeight: 0, width: 0, height: 0, xShift: 0, alphaKept: true, processed: false };
  }
  const xShift = options.aspect ? vresolution - resolution : 0;
  const scaled = scaleX(decoded, xShift);
  if (!options.keepAlpha) {
    for (let i = 3; i < scaled.rgba.length; i += 4) scaled.rgba[i] = 255;
  }
  return {
    png: encodePngRgba(scaled.width, scaled.height, scaled.rgba),
    rawWidth: decoded.width,
    rawHeight: decoded.height,
    width: scaled.width,
    height: scaled.height,
    xShift,
    alphaKept: options.keepAlpha,
    processed: true,
  };
}

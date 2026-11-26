import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';

export interface Raster { width: number; height: number; data: Uint8Array }
export interface Rect { x: number; y: number; width: number; height: number }
export function sha256(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }
export function validSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16777216) throw new Error('RASTER_SIZE_INVALID: 图像尺寸超出范围');
}
export function blank(width: number, height: number): Raster {
  validSize(width, height); return { width, height, data: new Uint8Array(width * height * 4) };
}
export function assertRaster(image: Raster): void {
  validSize(image.width, image.height);
  if (!(image.data instanceof Uint8Array) || image.data.length !== image.width * image.height * 4) throw new Error('RGBA8_INVALID: 需要完整 RGBA8 像素');
}
export function decodePng(bytes: Buffer): Raster {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG_INVALID: PNG 文件头无效');
  validSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (bytes[24] !== 8 || bytes[25] !== 6) throw new Error('PNG_FORMAT_UNSUPPORTED: 仅接受规范化后的 RGBA8 PNG');
  const image = PNG.sync.read(bytes, { checkCRC: true }); assertRaster(image); return image;
}
export function encodePng(image: Raster): Buffer {
  assertRaster(image);
  return PNG.sync.write({ width: image.width, height: image.height, data: Buffer.from(image.data) } as PNG,
    { colorType: 6, inputColorType: 6, inputHasAlpha: true, bitDepth: 8 });
}
export function alphaInfo(image: Raster) {
  assertRaster(image);
  let left = image.width, top = image.height, right = -1, bottom = -1, nonTransparentPixels = 0, partialAlphaPixels = 0;
  for (let p = 0; p < image.width * image.height; p++) if (image.data[p * 4 + 3]! > 0) {
    const x = p % image.width, y = Math.floor(p / image.width);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    nonTransparentPixels++; if (image.data[p * 4 + 3]! < 255) partialAlphaPixels++;
  }
  const bounds: Rect | null = nonTransparentPixels ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null;
  return { bounds, nonTransparentPixels, partialAlphaPixels };
}
export function alphaHash(image: Raster): string {
  return sha256(Uint8Array.from({ length: image.width * image.height }, (_, p) => image.data[p * 4 + 3]!));
}
/** Matches the accepted normalizer: bottom-to-top, straight RGBA8 source-over, round each layer. */
export function composite(width: number, height: number, layers: { image: Raster; x: number; y: number; hidden: boolean }[]): Raster {
  const out = blank(width, height);
  for (const layer of layers) {
    assertRaster(layer.image);
    if (!Number.isInteger(layer.x) || !Number.isInteger(layer.y)) throw new Error('POSITION_INVALID');
    if (layer.hidden) continue;
    const src = layer.image;
    for (let y = Math.max(0, -layer.y); y < Math.min(src.height, height - layer.y); y++) for (let x = Math.max(0, -layer.x); x < Math.min(src.width, width - layer.x); x++) {
      const s = (y * src.width + x) * 4, d = ((y + layer.y) * width + x + layer.x) * 4, sa = src.data[s + 3]!, da = out.data[d + 3]!;
      if (!sa) continue;
      if (sa === 255 || da === 0) { out.data.set(src.data.subarray(s, s + 4), d); continue; }
      const n = sa * 255 + da * (255 - sa);
      for (let c = 0; c < 3; c++) out.data[d + c] = Math.round((src.data[s + c]! * sa * 255 + out.data[d + c]! * da * (255 - sa)) / n);
      out.data[d + 3] = Math.round(n / 255);
    }
  }
  return out;
}
export function checkerboard(image: Raster): Raster {
  const bg = blank(image.width, image.height);
  for (let y = 0; y < bg.height; y++) for (let x = 0; x < bg.width; x++) {
    const v = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 ? 218 : 242;
    bg.data.set([v, v, v, 255], (y * bg.width + x) * 4);
  }
  return composite(bg.width, bg.height, [{ image: bg, x: 0, y: 0, hidden: false }, { image, x: 0, y: 0, hidden: false }]);
}
export function sideBySide(left: Raster, right: Raster): Raster {
  if (left.width !== right.width || left.height !== right.height) throw new Error('COMPARE_SIZE_MISMATCH');
  const out = blank(left.width * 2, left.height);
  for (let y = 0; y < left.height; y++) {
    out.data.set(left.data.subarray(y * left.width * 4, (y + 1) * left.width * 4), y * out.width * 4);
    out.data.set(right.data.subarray(y * right.width * 4, (y + 1) * right.width * 4), (y * out.width + left.width) * 4);
  }
  return out;
}
export function pixelDiff(a: Raster, b: Raster, allowed?: (x: number, y: number) => boolean) {
  assertRaster(a); assertRaster(b);
  if (a.width !== b.width || a.height !== b.height) throw new Error('COMPARE_SIZE_MISMATCH');
  let changedPixels = 0, alphaChangedPixels = 0, outsideAllowedChangedPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i + 3] !== b.data[i + 3]) alphaChangedPixels++;
    if ([0, 1, 2, 3].some(c => a.data[i + c] !== b.data[i + c])) {
      changedPixels++;
      if (allowed && !allowed((i / 4) % a.width, Math.floor(i / 4 / a.width))) outsideAllowedChangedPixels++;
    }
  }
  return { changedPixels, alphaChangedPixels, outsideAllowedChangedPixels };
}

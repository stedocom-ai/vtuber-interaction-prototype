import { assertRaster, blank } from '../../vtuber-controlled-recolor/src/pixels.ts';
import type { Raster } from '../../vtuber-controlled-recolor/src/pixels.ts';
import { parseColor } from '../../vtuber-controlled-recolor/src/recolor.ts';

export function recolorWithinMask(input: Raster, mask: Uint8Array, hex: string) {
  assertRaster(input);
  if (mask.length !== input.width * input.height || !mask.every(v => v === 0 || v === 1)) throw new Error('MASK_INVALID');
  const color = parseColor(hex), output: Raster = { ...input, data: new Uint8Array(input.data) };
  let changedPixels = 0, allowedVisiblePixels = 0, preservedTransparentMaskPixels = 0;
  const colors = new Map<string, number>();
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    if (!input.data[i + 3]) { preservedTransparentMaskPixels++; continue; }
    allowedVisiblePixels++;
    const old = '#' + Buffer.from(input.data.subarray(i, i + 3)).toString('hex').toUpperCase(); colors.set(old, (colors.get(old) ?? 0) + 1);
    if (color.rgb.some((v, c) => v !== input.data[i + c])) changedPixels++;
    output.data.set(color.rgb, i);
  }
  return { image: output, changedPixels, allowedVisiblePixels, preservedTransparentMaskPixels, newColor: color.hex,
    originalColors: [...colors].sort(([a], [b]) => a.localeCompare(b)).map(([hex, pixels]) => ({ hex, pixels })) };
}
export function differencePreview(before: Raster, after: Raster): Raster {
  if (before.width !== after.width || before.height !== after.height) throw new Error('COMPARE_SIZE_MISMATCH');
  const out = blank(before.width, before.height);
  for (let i = 0; i < before.data.length; i += 4) out.data.set([0, 1, 2, 3].some(c => before.data[i + c] !== after.data[i + c]) ? [255, 0, 255, 255] : [0, 0, 0, 255], i);
  return out;
}

import { assertRaster } from './pixels.ts';
import type { Raster } from './pixels.ts';

export interface Rule {
  id: string; targetLayerId: string; expectedLayerName: 'Outfit';
  operation: 'replace-rgb'; allowedRegion: 'alpha-nonzero'; maskPath: null;
}
export function parseColor(value: unknown): { hex: string; rgb: [number, number, number] } {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('INVALID_COLOR: 颜色必须是 #RRGGBB 格式，例如 #7A5AF8；不接受 Alpha、简写或空格');
  return { hex: value.toUpperCase(), rgb: [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)] };
}
export function validateRule(value: unknown): Rule {
  if (!value || typeof value !== 'object') throw new Error('RULE_INVALID: 缺少换色规则');
  const r = value as Record<string, unknown>;
  if (r.maskPath !== null) throw new Error('MASK_NOT_SUPPORTED: maskPath 本轮必须显式为 null；局部蒙版暂未实现，不会忽略此设置');
  const keys = ['id', 'targetLayerId', 'expectedLayerName', 'operation', 'allowedRegion', 'maskPath'];
  if (Object.keys(r).some(k => !keys.includes(k)) || typeof r.id !== 'string' || !r.id || typeof r.targetLayerId !== 'string' || !r.targetLayerId ||
      r.expectedLayerName !== 'Outfit' || r.operation !== 'replace-rgb' || r.allowedRegion !== 'alpha-nonzero') throw new Error('RULE_INVALID: 本轮仅支持 Outfit / replace-rgb / alpha-nonzero 规则');
  return r as unknown as Rule;
}
export function recolor(image: Raster, color: string) {
  assertRaster(image);
  const parsed = parseColor(color), result: Raster = { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  const histogram = new Map<string, number>();
  let allowedPixels = 0, changedPixels = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    // Keep *all four bytes* of alpha=0 pixels, including invisible RGB, intact.
    if (!image.data[i + 3]) continue;
    allowedPixels++;
    const original = '#' + Buffer.from(image.data.subarray(i, i + 3)).toString('hex').toUpperCase();
    histogram.set(original, (histogram.get(original) ?? 0) + 1);
    if (parsed.rgb.some((v, c) => v !== image.data[i + c])) changedPixels++;
    result.data.set(parsed.rgb, i);
  }
  return { image: result, color: parsed.hex, allowedPixels, changedPixels,
    originalColors: [...histogram].sort(([a], [b]) => a.localeCompare(b)).map(([hex, pixels]) => ({ hex, pixels })) };
}

import { blank, validSize } from '../../vtuber-controlled-recolor/src/pixels.ts';
import type { Raster } from '../../vtuber-controlled-recolor/src/pixels.ts';
import type { Drawable, Inventory } from './core-reader.ts';

export type Point = [number, number];
export const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
export function validateMesh(d: Drawable, textures: { width: number; height: number }[]) {
  if (!Number.isInteger(d.textureIndex) || !textures[d.textureIndex]) throw new Error('TEXTURE_INDEX_INVALID: ' + d.id);
  if (d.vertexUvs.length < 6 || d.vertexUvs.length % 2 || d.vertexPositions.length !== d.vertexUvs.length || d.vertexUvs.length > 131070) throw new Error('VERTEX_DATA_INVALID: ' + d.id);
  if (!d.vertexUvs.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || !d.vertexPositions.every(Number.isFinite)) throw new Error('UV_OUT_OF_RANGE: 不允许猜测 wrap/clamp 行为 ' + d.id);
  if (!d.triangleIndices.length || d.triangleIndices.length % 3 || d.triangleIndices.length > 300000 || !d.triangleIndices.every(i => Number.isInteger(i) && i >= 0 && i < d.vertexUvs.length / 2)) throw new Error('TRIANGLE_INDICES_INVALID: ' + d.id);
}
/** UV origin bottom-left -> PNG origin top-left; coordinates are pixel edges, not centers. */
export function uvPoints(d: Drawable, width: number, height: number): Point[] {
  return Array.from({ length: d.vertexUvs.length / 2 }, (_, i) => [d.vertexUvs[2 * i]! * width, (1 - d.vertexUvs[2 * i + 1]!) * height]);
}
/** Separating-axis triangle/closed pixel-square intersection, including boundary touches. */
export function triangleTouchesPixel(tri: Point[], x: number, y: number): boolean {
  const square: Point[] = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
  const axes: Point[] = [[1, 0], [0, 1], ...tri.map((p, i) => { const q = tri[(i + 1) % 3]!; return [-(q[1] - p[1]), q[0] - p[0]] as Point; })];
  for (const axis of axes) {
    const a = tri.map(p => p[0] * axis[0] + p[1] * axis[1]), b = square.map(p => p[0] * axis[0] + p[1] * axis[1]);
    const epsilon = 1e-9 * Math.max(1, Math.abs(axis[0]) + Math.abs(axis[1]));
    if (Math.max(...a) < Math.min(...b) - epsilon || Math.max(...b) < Math.min(...a) - epsilon) return false;
  }
  return true;
}
export function rasterize(d: Drawable, width: number, height: number): Uint8Array {
  validSize(width, height);
  const mask = new Uint8Array(width * height), points = uvPoints(d, width, height);
  for (let i = 0; i < d.triangleIndices.length; i += 3) {
    const tri = d.triangleIndices.slice(i, i + 3).map(n => points[n]!);
    if (Math.abs(cross(tri[0]!, tri[1]!, tri[2]!)) < 1e-10) throw new Error('DEGENERATE_UV_TRIANGLE: ' + d.id);
    const x0 = Math.max(0, Math.floor(Math.min(...tri.map(p => p[0]))) - 1), x1 = Math.min(width - 1, Math.floor(Math.max(...tri.map(p => p[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...tri.map(p => p[1]))) - 1), y1 = Math.min(height - 1, Math.floor(Math.max(...tri.map(p => p[1]))));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!mask[y * width + x] && triangleTouchesPixel(tri, x, y)) mask[y * width + x] = 1;
  }
  return mask;
}
export function dilate(mask: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  if (mask.length !== width * height || !Number.isInteger(radius) || radius < 0 || radius > 8) throw new Error('MASK_SIZE_INVALID');
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) {
    for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) out[yy * width + xx] = 1;
  }
  return out;
}
export const countMask = (mask: Uint8Array) => mask.reduce((n, b) => n + (b ? 1 : 0), 0);
export const overlapCount = (a: Uint8Array, b: Uint8Array) => { if (a.length !== b.length) throw new Error('MASK_SIZE_INVALID'); let n = 0; for (let i = 0; i < a.length; i++) if (a[i] && b[i]) n++; return n; };
export function maskPng(mask: Uint8Array, width: number, height: number): Raster {
  if (mask.length !== width * height) throw new Error('MASK_SIZE_INVALID');
  const out = blank(width, height);
  for (let p = 0; p < mask.length; p++) { const v = mask[p] ? 255 : 0; out.data.set([v, v, v, 255], p * 4); }
  return out;
}
export const palette = [[126, 87, 194], [255, 167, 38], [41, 182, 246], [102, 187, 106], [236, 64, 122], [171, 71, 188], [38, 166, 154], [239, 83, 80], [92, 107, 192], [141, 110, 99]];
export function ownership(inventory: Inventory, textures: { width: number; height: number }[], layer: { id: string; name: string }) {
  if (!inventory.drawables.length || inventory.drawables.some((d, i) => d.index !== i)) throw new Error('DRAWABLE_INDEX_INVALID');
  const ids = inventory.drawables.map(d => d.id);
  if (new Set(ids).size !== ids.length) throw new Error('DRAWABLE_ID_AMBIGUOUS: Drawable ID 重复');
  if (layer.name !== 'Outfit') throw new Error('OUTFIT_LAYER_MAPPING_INVALID');
  const candidates = inventory.drawables.filter(d => d.id === layer.name);
  if (candidates.length !== 1) throw new Error('OUTFIT_NOT_UNIQUE: 需要恰好一个与源图层名称严格相等的 Drawable ID');
  for (const d of inventory.drawables) validateMesh(d, textures);
  const target = candidates[0]!, masks = inventory.drawables.map(d => rasterize(d, textures[d.textureIndex]!.width, textures[d.textureIndex]!.height));
  const texture = textures[target.textureIndex]!, targetMask = masks[target.index]!;
  const guards = inventory.drawables.map(d => dilate(masks[d.index]!, textures[d.textureIndex]!.width, textures[d.textureIndex]!.height));
  const others = new Uint8Array(targetMask.length), othersGuard = new Uint8Array(targetMask.length);
  const comparisons = inventory.drawables.filter(d => d.index !== target.index && d.textureIndex === target.textureIndex).map(d => {
    for (let p = 0; p < others.length; p++) { if (masks[d.index]![p]) others[p] = 1; if (guards[d.index]![p]) othersGuard[p] = 1; }
    return { drawableId: d.id, directOverlapPixels: overlapCount(targetMask, masks[d.index]!), guardedOverlapPixels: overlapCount(guards[target.index]!, guards[d.index]!) };
  });
  const directOverlapPixels = overlapCount(targetMask, others), guardedOverlapPixels = overlapCount(guards[target.index]!, othersGuard);
  return { target, masks, guards, targetMask, others, othersGuard, comparisons, directOverlapPixels, guardedOverlapPixels,
    unique: countMask(targetMask) > 0 && directOverlapPixels === 0 && guardedOverlapPixels === 0, width: texture.width, height: texture.height };
}
export function ownershipPreview(inventory: Inventory, masks: Uint8Array[], textureIndex: number, width: number, height: number): Raster {
  const image = blank(width, height), owners = new Uint16Array(width * height);
  for (let p = 0; p < owners.length; p++) image.data.set([30, 30, 36, 255], p * 4);
  for (const d of inventory.drawables.filter(d => d.textureIndex === textureIndex)) for (let p = 0; p < owners.length; p++) if (masks[d.index]![p]) {
    owners[p]++; image.data.set(owners[p]! > 1 ? [255, 0, 0, 255] : [...palette[d.index % palette.length]!, 255], p * 4);
  }
  return image;
}
export function overlapPreview(target: Uint8Array, others: Uint8Array, width: number, height: number): Raster {
  const image = blank(width, height);
  for (let p = 0; p < target.length; p++) image.data.set(target[p] && others[p] ? [255, 0, 0, 255] : target[p] ? [122, 90, 248, 255] : others[p] ? [75, 150, 190, 255] : [30, 30, 36, 255], p * 4);
  return image;
}

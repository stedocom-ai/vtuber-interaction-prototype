import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { alphaInfo, composite, decodePng, sha256, validSize } from './pixels.ts';
import type { Raster, Rect } from './pixels.ts';
import { readLimited, safeFile, safeRelative } from './files.ts';

export interface Layer {
  [key: string]: unknown;
  id: string; name: string; index: number; type: string; parentId: null;
  x: number; y: number; width: number; height: number;
  hidden: boolean; effectiveHidden: boolean; blendMode: string; opacity: number; clipping: boolean; unsupported: unknown[];
  original: Rect; cropOffset: { x: number; y: number }; placement: { x: number; y: number };
  cropped: { width: number; height: number }; empty: boolean; padding: number;
  alphaBoundsLocal: Rect | null; alphaBoundsCanvas: Rect | null;
  alpha: { bounds: Rect | null; nonTransparentPixels: number; partialAlphaPixels: number };
  sourcePng: string; croppedPng: string; croppedPngSha256: string;
}
export interface Manifest {
  [key: string]: unknown;
  schemaVersion: string; canvas: { width: number; height: number }; sourceSha256: string;
  order: 'bottom-to-top'; layers: Layer[];
}
export interface LoadedLayer { record: Layer; bytes: Buffer; image: Raster; beforeBytes: Buffer }
export interface LoadedManifest { manifest: Manifest; root: string; path: string; bytes: Buffer; layers: LoadedLayer[] }
const hashPattern = /^[a-f0-9]{64}$/;
function requireThat(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error('MANIFEST_INVALID: ' + detail);
}
export async function loadManifest(file: string): Promise<LoadedManifest> {
  const manifestPath = await realpath(file), root = path.dirname(manifestPath), bytes = await readLimited(manifestPath, 4 * 1024 * 1024);
  const m = JSON.parse(bytes.toString('utf8')) as Manifest;
  requireThat(m && m.schemaVersion === '1.0.0' && m.order === 'bottom-to-top' && m.canvas && hashPattern.test(m.sourceSha256), '不支持的版本、顺序或源校验值');
  validSize(m.canvas.width, m.canvas.height);
  // Side-by-side preview must also fit the explicit raster budget.
  validSize(m.canvas.width * 2, m.canvas.height);
  requireThat(Array.isArray(m.layers) && m.layers.length > 0 && m.layers.length <= 256, '图层列表为空或过大');
  const ids = new Set<string>(), paths = new Set<string>(), layers: LoadedLayer[] = [];
  let pixelBudget = 0;
  for (const [index, r] of m.layers.entries()) {
    requireThat(r && typeof r.id === 'string' && /^[A-Za-z0-9_-]+$/.test(r.id) && !ids.has(r.id), '图层 ID 缺失或重复'); ids.add(r.id);
    requireThat(typeof r.name === 'string' && r.index === index && r.type === 'raster' && r.parentId === null, r.id + '：顺序或图层类型不支持');
    requireThat(r.blendMode === 'normal' && r.opacity === 1 && r.clipping === false && Array.isArray(r.unsupported) && r.unsupported.length === 0, r.id + '：不支持混合模式、蒙版、裁剪或效果');
    requireThat(typeof r.hidden === 'boolean' && r.effectiveHidden === r.hidden && typeof r.empty === 'boolean' && r.padding === 0, r.id + '：可见状态或 padding 不支持');
    requireThat(r.original && r.placement && r.cropOffset && r.cropped && r.alpha, r.id + '：缺少坐标、尺寸或 Alpha 元数据');
    requireThat([r.x, r.y, r.cropOffset.x, r.cropOffset.y, r.placement.x, r.placement.y].every(Number.isSafeInteger), r.id + '：坐标必须是整数');
    validSize(r.width, r.height); validSize(r.cropped.width, r.cropped.height);
    requireThat(isDeepStrictEqual(r.original, { x: r.x, y: r.y, width: r.width, height: r.height }), r.id + '：原始尺寸坐标不一致');
    requireThat(r.placement.x === r.x + r.cropOffset.x && r.placement.y === r.y + r.cropOffset.y && r.cropOffset.x >= 0 && r.cropOffset.y >= 0, r.id + '：偏移量不一致');
    requireThat(r.cropOffset.x + r.cropped.width <= r.width && r.cropOffset.y + r.cropped.height <= r.height, r.id + '：裁切范围越界');
    const pngPath = safeRelative(r.croppedPng), sourcePath = safeRelative(r.sourcePng);
    requireThat(pngPath.startsWith('layers/') && sourcePath.startsWith('before/') && pngPath.endsWith('.png') && sourcePath.endsWith('.png'), r.id + '：PNG 路径布局不支持');
    for (const p of [pngPath, sourcePath]) { requireThat(!paths.has(p.toLowerCase()), 'PNG 路径重复'); paths.add(p.toLowerCase()); }
    requireThat(hashPattern.test(r.croppedPngSha256), r.id + '：缺少 PNG SHA-256');
    const png = await readLimited(await safeFile(root, pngPath));
    if (sha256(png) !== r.croppedPngSha256) throw new Error('SOURCE_HASH_MISMATCH: 图层文件与 manifest 不一致 ' + r.id);
    pixelBudget += r.cropped.width * r.cropped.height;
    requireThat(pixelBudget <= 67108864, '图层像素总量超出限制');
    const image = decodePng(png);
    requireThat(image.width === r.cropped.width && image.height === r.cropped.height, r.id + '：PNG 实际尺寸不一致');
    const alpha = alphaInfo(image), local = alpha.bounds ? { ...alpha.bounds, x: alpha.bounds.x + r.cropOffset.x, y: alpha.bounds.y + r.cropOffset.y } : null;
    const canvas = local ? { ...local, x: local.x + r.x, y: local.y + r.y } : null;
    requireThat(isDeepStrictEqual(local, r.alphaBoundsLocal) && isDeepStrictEqual(canvas, r.alphaBoundsCanvas) && isDeepStrictEqual(local, r.alpha.bounds), r.id + '：Alpha 边界不一致');
    requireThat(alpha.nonTransparentPixels === r.alpha.nonTransparentPixels && alpha.partialAlphaPixels === r.alpha.partialAlphaPixels && r.empty === (alpha.nonTransparentPixels === 0), r.id + '：Alpha 统计不一致');
    const beforeBytes = await readLimited(await safeFile(root, sourcePath));
    layers.push({ record: r, bytes: png, image, beforeBytes });
  }
  return { manifest: m, root, path: manifestPath, bytes, layers };
}
export function render(loaded: LoadedManifest): Raster {
  return composite(loaded.manifest.canvas.width, loaded.manifest.canvas.height,
    loaded.layers.map(({ record: r, image }) => ({ image, x: r.placement.x, y: r.placement.y, hidden: r.effectiveHidden || r.empty })));
}

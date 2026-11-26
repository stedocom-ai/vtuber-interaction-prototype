import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { alphaInfo, blank, encodePng, sha256, composite } from '../src/pixels.ts';
import type { Raster } from '../src/pixels.ts';
import { moduleRoot } from '../src/run.ts';
import type { Config } from '../src/run.ts';
import type { Manifest, Layer } from '../src/manifest.ts';
import { save, saveJson } from '../src/files.ts';

export const rule = { id: 'outfit-solid-v1', targetLayerId: 'layer_003', expectedLayerName: 'Outfit', operation: 'replace-rgb', allowedRegion: 'alpha-nonzero', maskPath: null } as const;
export function sample(): Raster {
  return { width: 3, height: 2, data: new Uint8Array([
    63, 95, 155, 255, 63, 95, 155, 128, 9, 7, 1, 0,
    63, 95, 155, 1, 122, 90, 248, 254, 1, 2, 3, 255,
  ]) };
}
export async function fixture(change?: (manifest: Manifest, config: Config) => void) {
  const tempRoot = path.join(moduleRoot, '.test-tmp'); await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, 'fixture-')), input = path.join(root, 'input'), configPath = path.join(root, 'config.json'), outputRoot = path.join(root, 'runs');
  const body = blank(5, 4); for (let i = 0; i < body.data.length; i += 4) body.data.set([220, 170, 140, 255], i);
  const hair = blank(2, 2); for (let i = 0; i < hair.data.length; i += 4) hair.data.set([10, 20, 30, 255], i);
  const face = { width: 2, height: 1, data: new Uint8Array([230, 190, 150, 255, 230, 190, 150, 128]) };
  const images = [body, sample(), face, hair], names = ['Body', 'Outfit', 'Face', 'Hair'], ids = ['layer_002', 'layer_003', 'layer_005', 'layer_011'];
  const positions = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: -1, y: -1 }];
  const manifest: Manifest = { schemaVersion: '1.0.0', sourceSha256: 'a'.repeat(64), canvas: { width: 5, height: 4 }, order: 'bottom-to-top', layers: [] };
  for (const [i, image] of images.entries()) {
    const offset = i === 1 ? { x: 2, y: 1 } : { x: 0, y: 0 }, placement = positions[i]!, x = placement.x - offset.x, y = placement.y - offset.y;
    const width = image.width + offset.x, height = image.height + offset.y, alpha = alphaInfo(image);
    const bounds = alpha.bounds ? { ...alpha.bounds, x: alpha.bounds.x + offset.x, y: alpha.bounds.y + offset.y } : null;
    const bytes = encodePng(image), id = ids[i]!, sourcePng = `before/${id}.png`, croppedPng = `layers/${id}.png`;
    const r: Layer = { id, name: names[i]!, index: i, type: 'raster', parentId: null, x, y, width, height,
      hidden: i === 3, effectiveHidden: i === 3, blendMode: 'normal', opacity: 1, clipping: false, unsupported: [],
      original: { x, y, width, height }, cropOffset: offset, placement, cropped: { width: image.width, height: image.height },
      empty: false, padding: 0, alphaBoundsLocal: bounds, alphaBoundsCanvas: bounds ? { ...bounds, x: bounds.x + x, y: bounds.y + y } : null,
      alpha: { ...alpha, bounds }, sourcePng, croppedPng, croppedPngSha256: sha256(bytes), pngBytesAfter: bytes.length };
    manifest.layers.push(r);
    await save(path.join(input, croppedPng), bytes);
    const original = blank(width, height);
    for (let row = 0; row < image.height; row++) original.data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((row + offset.y) * width + offset.x) * 4);
    await save(path.join(input, sourcePng), encodePng(original));
  }
  const preview = composite(5, 4, images.map((image, i) => ({ image, ...positions[i]!, hidden: i === 3 })));
  await save(path.join(input, 'previews/reassembled.png'), encodePng(preview));
  const config: Config = { schemaVersion: '1.0.0', manifestPath: 'input/layer-manifest.json', baselinePreviewPath: 'previews/reassembled.png', rule: { ...rule } };
  change?.(manifest, config);
  await saveJson(path.join(input, 'layer-manifest.json'), manifest); await saveJson(configPath, config);
  return { root, input, configPath, outputRoot, manifest, config };
}

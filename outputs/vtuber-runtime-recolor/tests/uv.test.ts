import test from 'node:test';
import assert from 'node:assert/strict';
import { ownership, rasterize, countMask, maskPng, validateMesh, overlapCount, dilate, triangleTouchesPixel, uvPoints } from '../src/uv.ts';
import type { Drawable, Inventory } from '../src/core-reader.ts';
import { recolorWithinMask } from '../src/texture-recolor.ts';
import { blank, encodePng, decodePng, pixelDiff } from '../../vtuber-controlled-recolor/src/pixels.ts';
import { renderPreview, sampleTexture } from '../src/render-preview.ts';

function mesh(index = 0, id = 'Outfit'): Drawable {
  return { index, id, partIndex: -1, partId: null, textureIndex: 0, vertexUvs: [0.1, 0.9, 0.3, 0.9, 0.1, 0.7], vertexPositions: [1, 1, 3, 1, 1, 3], triangleIndices: [0, 1, 2],
    renderOrder: index, drawOrder: index, opacity: 1, constantFlags: 4, dynamicFlags: 1, blendMode: 0, masks: [], multiplyColor: [1, 1, 1, 1], screenColor: [0, 0, 0, 0] };
}
function inv(drawables: Drawable[]): Inventory {
  return { schemaVersion: '1.0.0', mocSha256: 'test-metadata-only-no-sdk', mocFormatVersion: 4, mocConsistency: true, coreVersion: 'fixture', coreVersionNumber: 0,
    canvas: { width: 10, height: 10, originX: 0, originY: 10, pixelsPerUnit: 1 }, parameters: [], parts: [], offscreenCount: 0, drawables };
}
const sizes = [{ width: 20, height: 20 }];
test('UV maps bottom-left origin to PNG top-left without a guessed flip', () => {
  const d = mesh(); d.vertexUvs = [0, 0, 1, 1, 0.5, 0.5]; assert.deepEqual(uvPoints(d, 20, 10), [[0, 10], [20, 0], [10, 5]]);
});
test('triangle rasterization excludes pixels in its bounding box but outside the triangle', () => {
  const m = rasterize(mesh(), 20, 20); assert.equal(m[5 * 20 + 5], 0); assert.equal(m[3 * 20 + 3], 1);
});
test('thin triangle without a pixel-center hit still marks intersected texels', () => {
  assert.ok(triangleTouchesPixel([[1.01, 1.01], [1.99, 1.01], [1.01, 1.02]], 1, 1));
});
test('closed-boundary intersection is conservative', () => {
  assert.ok(triangleTouchesPixel([[1, 1], [2, 1], [1, 2]], 0, 1));
});
test('reversed winding yields exactly the same raster mask', () => {
  const a = mesh(), b = mesh(); b.triangleIndices = [2, 1, 0]; assert.deepEqual(rasterize(a, 20, 20), rasterize(b, 20, 20));
});
test('triangle union is idempotent; repeated triangles do not multiply coverage', () => {
  const a = mesh(), b = mesh(); b.triangleIndices.push(0, 1, 2); assert.deepEqual(rasterize(a, 20, 20), rasterize(b, 20, 20));
});
test('clear separation passes ownership without color or PSD coordinates', () => {
  const a = mesh(), b = mesh(1, 'Body'); b.vertexUvs = b.vertexUvs.map(v => v + (v < 0.5 ? 0.5 : -0.5));
  const result = ownership(inv([a, b]), sizes, { id: 'anything', name: 'Outfit' }); assert.ok(result.unique); assert.equal(result.directOverlapPixels, 0);
});
test('shared UV pixels block stage A even when another Drawable is invisible', () => {
  const a = mesh(), b = mesh(1, 'Body'); b.opacity = 0; b.dynamicFlags = 0;
  const result = ownership(inv([a, b]), sizes, { id: 'layer_003', name: 'Outfit' }); assert.equal(result.unique, false); assert.ok(result.directOverlapPixels > 0);
});
test('sampling guard detects sharing missed by direct non-overlap', () => {
  const a = mesh(), b = mesh(1, 'Body'); b.vertexUvs = [0.37, 0.9, 0.57, 0.9, 0.37, 0.7];
  const result = ownership(inv([a, b]), sizes, { id: 'layer_003', name: 'Outfit' }); assert.equal(result.directOverlapPixels, 0); assert.ok(result.guardedOverlapPixels > 0); assert.equal(result.unique, false);
});
test('identical UV on a different texture is not false-positive overlap', () => {
  const b = mesh(1, 'Body'); b.textureIndex = 1;
  const result = ownership(inv([mesh(), b]), [...sizes, ...sizes], { id: 'layer_003', name: 'Outfit' }); assert.ok(result.unique);
});
test('Outfit must exist exactly and a case-insensitive guess is not accepted', () => {
  assert.throws(() => ownership(inv([mesh(0, 'outfit')]), sizes, { id: 'layer_003', name: 'Outfit' }), /OUTFIT_NOT_UNIQUE/);
});
test('duplicate Outfit IDs block stage A', () => assert.throws(() => ownership(inv([mesh(), mesh(1)]), sizes, { id: 'layer_003', name: 'Outfit' }), /DRAWABLE_ID_AMBIGUOUS/));
test('wrong source layer name is rejected', () => assert.throws(() => ownership(inv([mesh()]), sizes, { id: 'layer_003', name: 'Face' }), /OUTFIT_LAYER_MAPPING_INVALID/));
test('invalid texture index is rejected', () => { const d = mesh(); d.textureIndex = 9; assert.throws(() => validateMesh(d, sizes), /TEXTURE_INDEX_INVALID/); });
test('NaN, infinite or out-of-range UV is rejected', () => {
  for (const v of [NaN, Infinity, -0.1, 1.1]) { const d = mesh(); d.vertexUvs[0] = v; assert.throws(() => validateMesh(d, sizes), /UV_OUT_OF_RANGE/); }
});
test('bad triangle index or incomplete triangle is rejected', () => {
  for (const indices of [[0, 1], [0, 1, 99], [0, 1, -1]]) { const d = mesh(); d.triangleIndices = indices; assert.throws(() => validateMesh(d, sizes), /TRIANGLE_INDICES_INVALID/); }
});
test('degenerate UV triangles fail closed', () => { const d = mesh(); d.vertexUvs = [0, 0, 0, 0, 0, 0]; assert.throws(() => rasterize(d, 20, 20), /DEGENERATE_UV_TRIANGLE/); });
test('drawable array/index inconsistency is rejected', () => assert.throws(() => ownership(inv([mesh(9)]), sizes, { id: 'layer_003', name: 'Outfit' }), /DRAWABLE_INDEX_INVALID/));
test('mask PNG is binary black/white at full original resolution', () => {
  const mask = rasterize(mesh(), 20, 20), png = decodePng(encodePng(maskPng(mask, 20, 20)));
  assert.equal(png.width, 20); assert.equal(png.height, 20);
  for (let p = 0; p < mask.length; p++) assert.deepEqual([...png.data.subarray(p * 4, p * 4 + 4)], mask[p] ? [255, 255, 255, 255] : [0, 0, 0, 255]);
});
test('dilation keeps edges inside the texture', () => { const m = new Uint8Array(9); m[0] = 1; assert.equal(countMask(dilate(m, 3, 3)), 4); });
test('mask comparisons reject mismatched sizes', () => assert.throws(() => overlapCount(new Uint8Array(4), new Uint8Array(9)), /MASK_SIZE_INVALID/));
test('all 256 alpha values are preserved and only mask-visible RGB is replaced', () => {
  const input = blank(256, 1), mask = new Uint8Array(256).fill(1);
  for (let a = 0; a < 256; a++) input.data.set([63, 95, 155, a], a * 4);
  const result = recolorWithinMask(input, mask, '#7A5AF8'); assert.equal(result.changedPixels, 255);
  for (let a = 0; a < 256; a++) { assert.equal(result.image.data[a * 4 + 3], a); assert.deepEqual([...result.image.data.subarray(a * 4, a * 4 + 3)], a ? [122, 90, 248] : [63, 95, 155]); }
});
test('outside-mask RGBA stays byte-identical even when the same source color appears there', () => {
  const input = blank(2, 1); input.data.set([63, 95, 155, 128, 63, 95, 155, 255]);
  const output = recolorWithinMask(input, new Uint8Array([1, 0]), '#7A5AF8').image;
  assert.deepEqual(output.data.subarray(4), input.data.subarray(4)); assert.equal(pixelDiff(input, output, x => x === 0).outsideAllowedChangedPixels, 0);
});
test('same input generates deterministic PNG output without mutating source buffers', () => {
  const input = blank(2, 1); input.data.set([63, 95, 155, 128]); const before = new Uint8Array(input.data), mask = new Uint8Array([1, 0]);
  assert.deepEqual(encodePng(recolorWithinMask(input, mask, '#7A5AF8').image), encodePng(recolorWithinMask(input, mask, '#7a5af8').image)); assert.deepEqual(input.data, before);
});
test('invalid mask and invalid hex produce explicit errors', () => {
  assert.throws(() => recolorWithinMask(blank(1, 1), new Uint8Array([2]), '#7A5AF8'), /MASK_INVALID/);
  assert.throws(() => recolorWithinMask(blank(1, 1), new Uint8Array([1]), '#oops'), /INVALID_COLOR/);
});
test('premultiplied sampling does not turn invisible RGB into visible fringe color', () => {
  const tex = blank(2, 1); tex.data.set([255, 0, 0, 0, 0, 255, 0, 255]); assert.deepEqual(sampleTexture(tex, 0.5, 0.5), [0, 0.5, 0, 0.5]);
});
test('CPU preview uses Core-style mesh positions/UVs and keeps source alpha', () => {
  const d = mesh(), tex = blank(20, 20); for (let i = 0; i < tex.data.length; i += 4) tex.data.set([122, 90, 248, 255], i);
  const rendered = renderPreview(inv([d]), [tex]); assert.ok(rendered.data.some(v => v)); assert.equal(rendered.data[3], 0);
});
test('Core default screenColor alpha=1 is not a screen RGB effect', () => {
  const d = mesh(); d.screenColor = [0, 0, 0, 1]; assert.doesNotThrow(() => renderPreview(inv([d]), [blank(20, 20)]));
});

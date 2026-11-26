import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { run, moduleRoot, defaultConfig } from '../src/run.ts';
import { snapshot, saveJson, within } from '../src/files.ts';
import { alphaHash, decodePng, pixelDiff, sha256 } from '../src/pixels.ts';
import type { Manifest } from '../src/manifest.ts';

let first: Awaited<ReturnType<typeof run>>, second: Awaited<ReturnType<typeof run>>;
let firstSnapshot: Awaited<ReturnType<typeof snapshot>>, inputManifest: Manifest, outputManifest: Manifest;
before(async () => {
  first = await run({ color: '#7A5AF8', configPath: defaultConfig });
  firstSnapshot = await snapshot([first.output]);
  second = await run({ color: '#7A5AF8', configPath: defaultConfig });
  inputManifest = JSON.parse(await readFile(first.report.sourceManifest.path, 'utf8'));
  outputManifest = JSON.parse(await readFile(path.join(first.output, 'layer-manifest.json'), 'utf8'));
  if (process.env.RECOLOR_VERIFY_DIR) {
    const dir = path.resolve(process.env.RECOLOR_VERIFY_DIR);
    assert.ok(within(path.join(moduleRoot, 'verification'), dir));
    await saveJson(path.join(dir, 'reference-runs.json'), { first: first.output, second: second.output });
  }
}, { timeout: 120000 });
test('REAL: existing manifest includes all 11 layers and required machine-readable fields', () => {
  assert.equal(inputManifest.layers.length, 11); assert.equal(inputManifest.canvas.width, 2048); assert.equal(inputManifest.canvas.height, 2048);
  for (const layer of inputManifest.layers) for (const key of ['id', 'croppedPng', 'placement', 'cropped', 'hidden', 'index', 'alphaBoundsLocal', 'alphaBoundsCanvas', 'croppedPngSha256']) assert.ok(key in layer);
});
test('REAL: 447252 Outfit pixels recolored from #3F5F9B to #7A5AF8', () => {
  assert.equal(first.report.target.changedPixels, 447252); assert.equal(first.report.target.allowedPixels, 447252);
  assert.deepEqual(first.report.target.originalColors, [{ hex: '#3F5F9B', pixels: 447252 }]); assert.equal(first.report.target.newColor, '#7A5AF8');
});
test('REAL: all alpha bytes and all alpha=0 RGBA bytes are unchanged', async () => {
  const a = decodePng(await readFile(first.report.target.originalPngPath));
  const b = decodePng(await readFile(path.join(first.output, 'layers/layer_003_Outfit.png')));
  assert.equal(alphaHash(a), alphaHash(b));
  let partial = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    assert.equal(a.data[i + 3], b.data[i + 3]);
    if (!a.data[i + 3]) assert.deepEqual(a.data.subarray(i, i + 4), b.data.subarray(i, i + 4));
    else assert.deepEqual([...b.data.subarray(i, i + 3)], [122, 90, 248]);
    if (a.data[i + 3]! > 0 && a.data[i + 3]! < 255) partial++;
  }
  assert.equal(partial, 2820);
});
test('REAL: every original geometry/ordering/visibility/alpha field remains identical', () => {
  assert.equal(first.report.target.width, 679); assert.equal(first.report.target.height, 836); assert.deepEqual(first.report.target.placement, { x: 673, y: 841 });
  for (const [i, original] of inputManifest.layers.entries()) {
    const expected = structuredClone(original);
    if (original.id === 'layer_003') { expected.croppedPngSha256 = outputManifest.layers[i]!.croppedPngSha256; expected.pngBytesAfter = outputManifest.layers[i]!.pngBytesAfter; }
    assert.deepEqual(outputManifest.layers[i], expected);
  }
});
test('REAL: remaining ten layers retain both original bytes and SHA-256', async () => {
  const rows = first.report.layers.filter(l => !l.isTarget); assert.equal(rows.length, 10);
  for (const l of rows) {
    const r = inputManifest.layers.find(r => r.id === l.id)!;
    const before = await readFile(path.join(path.dirname(first.report.sourceManifest.path), r.croppedPng));
    const after = await readFile(l.outputPath); assert.deepEqual(after, before); assert.equal(sha256(after), r.croppedPngSha256);
  }
});
test('REAL: full canvas has zero changed pixels outside Outfit footprint and no alpha changes', async () => {
  const original = decodePng(await readFile(first.report.composite.baselinePath)), changed = decodePng(await readFile(path.join(first.output, 'previews/reassembled.png')));
  const outfit = decodePng(await readFile(first.report.target.originalPngPath));
  const diff = pixelDiff(original, changed, (x, y) => x >= 673 && x < 1352 && y >= 841 && y < 1677 && !!outfit.data[((y - 841) * 679 + x - 673) * 4 + 3]);
  assert.equal(diff.alphaChangedPixels, 0); assert.equal(diff.outsideAllowedChangedPixels, 0); assert.ok(diff.changedPixels > 0);
});
test('REAL: two separate runs have identical manifest and every generated PNG SHA-256', async () => {
  const a = await snapshot([first.output]), b = await snapshot([second.output]);
  const files = (rows: typeof a, root: string) => rows.filter(f => f.path.endsWith('.png') || path.basename(f.path) === 'layer-manifest.json').map(f => ({ path: path.relative(root, f.path), sha256: f.sha256 }));
  assert.deepEqual(files(a, first.output), files(b, second.output));
});
test('REAL: second run has a new directory and does not overwrite the first acceptance result', async () => {
  assert.notEqual(first.output, second.output); assert.deepEqual(await snapshot([first.output]), firstSnapshot);
});
test('REAL: all eight original source/runtime files match the frozen snapshot and remain untouched', () => {
  assert.equal(first.report.originalFilesMatchingFrozenSnapshot.length, 8);
  assert.ok(first.report.protectedFiles.length > 30); assert.ok(first.report.protectedFiles.every(f => f.unchanged && f.sha256 === f.afterSha256));
  for (const suffix of ['.psd', '.cmo3', '.moc3', '.model3.json', 'texture_00.png']) assert.ok(first.report.originalFilesMatchingFrozenSnapshot.some(f => f.path.endsWith(suffix)));
});
test('REAL: five previews include full-resolution comparison and transparent character', async () => {
  assert.equal(first.report.previews.length, 5);
  const side = first.report.previews.find(p => p.name === 'character-side-by-side.png')!; assert.equal(side.width, 4096); assert.equal(side.height, 2048);
  const transparent = decodePng(await readFile(path.join(first.output, 'previews/reassembled.png')));
  assert.equal(transparent.data[3], 0);
});
test('REAL: input color and future maskPath are recorded with the original manifest hash', async () => {
  const config = JSON.parse(await readFile(path.join(first.output, 'run-config.json'), 'utf8'));
  assert.equal(config.inputColor, '#7A5AF8'); assert.equal(config.config.rule.maskPath, null);
  assert.equal(config.sourceManifestSha256, first.report.sourceManifest.sha256);
});
test('REAL: all runtime gates pass, zero errors and warnings, manual acceptance still pending', () => {
  assert.equal(first.report.status, 'RECOLOR_PASS'); assert.equal(first.report.passedChecks, 13);
  assert.deepEqual(first.report.errors, []); assert.deepEqual(first.report.warnings, []); assert.equal(first.report.manualAcceptance, 'PENDING');
});

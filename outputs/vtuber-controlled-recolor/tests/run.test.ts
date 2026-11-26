import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { run, moduleRoot } from '../src/run.ts';
import { fixture } from './helpers.ts';
import { snapshot, safeRelative } from '../src/files.ts';
import { decodePng, encodePng } from '../src/pixels.ts';

let f: Awaited<ReturnType<typeof fixture>>, first: Awaited<ReturnType<typeof run>>, second: Awaited<ReturnType<typeof run>>, beforeInput: Awaited<ReturnType<typeof snapshot>>;
before(async () => {
  f = await fixture(); beforeInput = await snapshot([f.input, f.configPath]);
  first = await run({ color: '#7A5AF8', configPath: f.configPath, outputRoot: f.outputRoot });
  second = await run({ color: '#7a5af8', configPath: f.configPath, outputRoot: f.outputRoot });
});
test('end-to-end synthetic fixture passes every acceptance gate', () => {
  assert.equal(first.report.status, 'RECOLOR_PASS'); assert.ok(Object.values(first.report.checks).every(Boolean));
  assert.equal(first.report.target.changedPixels, 4); assert.equal(first.report.errors.length, 0);
});
test('cropped dimensions, negative original coordinate, offsets, order and hidden states survive', () => {
  assert.equal(first.report.target.width, 3); assert.equal(first.report.target.height, 2);
  assert.deepEqual(first.report.target.placement, { x: 1, y: 1 });
  assert.ok(first.report.layers.every(l => l.metadataUnchangedExceptTargetFileHashAndBytes));
});
test('all non-Outfit layer PNG SHA-256 values and bytes are unchanged, including hidden layer', () => {
  const other = first.report.layers.filter(l => !l.isTarget); assert.equal(other.length, 3);
  assert.ok(other.every(l => l.beforeSha256 === l.afterSha256 && l.bytesUnchanged));
});
test('full composite changes only within allowed Outfit footprint; occluding layers remain untouched', () => {
  assert.equal(first.report.composite.outsideAllowedChangedPixels, 0);
  assert.equal(first.report.composite.alphaChangedPixels, 0);
  assert.ok(first.report.composite.changedPixels < first.report.target.changedPixels);
});
test('every run writes a different new directory without changing previous result', async () => {
  assert.notEqual(first.output, second.output);
  assert.deepEqual(JSON.parse(await readFile(path.join(first.output, 'acceptance.json'), 'utf8')), first.report);
});
test('same input produces identical persisted layer manifest and all preview PNGs', async () => {
  assert.deepEqual(first.report.previews.map(p => [p.name, p.sha256]), second.report.previews.map(p => [p.name, p.sha256]));
  assert.deepEqual(await readFile(path.join(first.output, 'layer-manifest.json')), await readFile(path.join(second.output, 'layer-manifest.json')));
});
test('configuration, exact input color, normalized color and maskPath are recorded', async () => {
  const saved = JSON.parse(await readFile(path.join(second.output, 'run-config.json'), 'utf8'));
  assert.equal(saved.inputColor, '#7a5af8'); assert.equal(saved.normalizedColor, '#7A5AF8'); assert.equal(saved.config.rule.maskPath, null);
});
test('input PNGs, manifest, configuration and previous acceptance files are untouched', async () => assert.deepEqual(await snapshot([f.input, f.configPath]), beforeInput));
test('five required previews exist; side-by-side is twice the canvas width', () => {
  assert.equal(first.report.previews.length, 5);
  const p = first.report.previews.find(p => p.name === 'character-side-by-side.png')!;
  assert.equal(p.width, 10); assert.equal(p.height, 4);
});
test('missing layer ID returns explicit LAYER_NOT_FOUND', async () => {
  const t = await fixture((_, c) => { c.rule.targetLayerId = 'missing_layer'; });
  await assert.rejects(run({ color: '#7A5AF8', configPath: t.configPath, outputRoot: t.outputRoot }), /LAYER_NOT_FOUND.*missing_layer/);
});
test('choosing an existing non-Outfit layer is rejected', async () => {
  const t = await fixture((_, c) => { c.rule.targetLayerId = 'layer_005'; });
  await assert.rejects(run({ color: '#7A5AF8', configPath: t.configPath, outputRoot: t.outputRoot }), /OUTFIT_ONLY/);
});
test('malformed color fails before any output directory is created', async () => {
  const t = await fixture();
  await assert.rejects(run({ color: 'purple', configPath: t.configPath, outputRoot: t.outputRoot }), /INVALID_COLOR/);
  await assert.rejects(readdir(t.outputRoot), { code: 'ENOENT' });
});
test('tampered source layer hash blocks run without mutating source further', async () => {
  const t = await fixture(), filename = path.join(t.input, 'layers/layer_003.png');
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('tampered')]));
  const before = await snapshot([t.input]);
  await assert.rejects(run({ color: '#7A5AF8', configPath: t.configPath, outputRoot: t.outputRoot }), /SOURCE_HASH_MISMATCH/);
  assert.deepEqual(await snapshot([t.input]), before);
});
test('duplicate IDs, changed order, wrong dimensions and wrong alpha bounds fail closed', async () => {
  const mutations = [
    (m: typeof f.manifest) => { m.layers[1]!.id = m.layers[0]!.id; },
    (m: typeof f.manifest) => { m.layers[1]!.index = 7; },
    (m: typeof f.manifest) => { m.layers[1]!.cropped.width = 2; },
    (m: typeof f.manifest) => { m.layers[1]!.alphaBoundsCanvas!.x = 50; },
  ];
  for (const mutation of mutations) {
    const t = await fixture(mutation);
    await assert.rejects(run({ color: '#7A5AF8', configPath: t.configPath, outputRoot: t.outputRoot }), /MANIFEST_INVALID/);
  }
});
test('non-null mask produces explicit unsupported error', async () => {
  const t = await fixture((_, c) => { (c.rule as unknown as { maskPath: string }).maskPath = 'future-mask.png'; });
  await assert.rejects(run({ color: '#7A5AF8', configPath: t.configPath, outputRoot: t.outputRoot }), /MASK_NOT_SUPPORTED/);
});
test('unsupported blend mode is not silently flattened', async () => {
  const t = await fixture(m => { m.layers[2]!.blendMode = 'multiply'; });
  await assert.rejects(run({ color: '#7A5AF8', configPath: t.configPath, outputRoot: t.outputRoot }), /MANIFEST_INVALID/);
});
test('changed accepted preview blocks recoloring', async () => {
  const t = await fixture(), filename = path.join(t.input, 'previews/reassembled.png');
  const png = decodePng(await readFile(filename)); png.data[0] = png.data[0]! ^ 255; await writeFile(filename, encodePng(png));
  await assert.rejects(run({ color: '#7A5AF8', configPath: t.configPath, outputRoot: t.outputRoot }), /BASELINE_PREVIEW_MISMATCH/);
});
test('output directory inside input or encompassing input is rejected', async () => {
  const t = await fixture();
  for (const outputRoot of [path.join(t.input, 'new-run'), t.root]) await assert.rejects(run({ color: '#7A5AF8', configPath: t.configPath, outputRoot }), /OUTPUT_OVERLAP/);
});
for (const value of ['../outside.png', 'C:/outside.png', '/outside.png', 'https://example.com/a.png', 'layers/../a.png', 'layers\\a.png']) {
  test('unsafe asset path rejected: ' + value, () => assert.throws(() => safeRelative(value), /UNSAFE_PATH/));
}
test('CLI invalid color returns exit code 2 and a readable error', () => {
  const p = spawnSync(process.execPath, [path.join(moduleRoot, 'src/cli.ts'), '--color', '#XYZXYZ'], { encoding: 'utf8', windowsHide: true });
  assert.equal(p.status, 2); assert.match(p.stderr, /INVALID_COLOR/); assert.equal(p.stdout, '');
});
test('CLI missing layer ID returns exit code 2 and a readable error', async () => {
  const t = await fixture((_, c) => { c.rule.targetLayerId = 'missing'; });
  const p = spawnSync(process.execPath, [path.join(moduleRoot, 'src/cli.ts'), '--color', '#7A5AF8', '--config', t.configPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(p.status, 2); assert.match(p.stderr, /LAYER_NOT_FOUND/);
});
test('entire report keeps immutable source fingerprint records', () => {
  assert.ok(first.report.protectedFiles.every(f => f.unchanged));
  assert.ok(isDeepStrictEqual(first.report.target.alphaBeforeSha256, first.report.target.alphaAfterSha256));
});

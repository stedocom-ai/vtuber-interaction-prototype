import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { integrate, moduleRoot } from '../src/integrate.ts';
import { inspectReferences } from '../src/references.ts';
import { decodePng, pixelDiff, sha256 } from '../../vtuber-controlled-recolor/src/pixels.ts';
import { fingerprint, snapshot, within } from '../../vtuber-controlled-recolor/src/files.ts';
import type { Fingerprint } from '../../vtuber-controlled-recolor/src/files.ts';

type AnyReport = Record<string, any>;
const sdk = process.env.RUNTIME_SDK_ROOT;
const verification = process.env.CONFIGURABLE_VERIFY_DIR;
const runs = path.join(moduleRoot, 'runs');
const specs = [
  { key: 'red', color: '#E64B4B', name: 'minimal_character_v1_red_test' },
  { key: 'green', color: '#39B96E', name: 'minimal_character_v1_green_test' },
] as const;
const json = async <T>(file: string) => JSON.parse(await readFile(file, 'utf8')) as T;
const runRoot = (name: string) => path.join(runs, name);
let reports: AnyReport[], repeats: AnyReport[], baselines: { root: string; files: Fingerprint[] }[];
let originalRefs: Awaited<ReturnType<typeof inspectReferences>>;

async function relativeFingerprints(root: string) {
  return (await snapshot([root])).map(f => ({ path: path.relative(root, f.path), bytes: f.bytes, sha256: f.sha256 }));
}
before(async () => {
  assert.ok(sdk, 'SDK_REQUIRED'); assert.ok(verification && within(moduleRoot, verification), 'CONFIGURABLE_VERIFY_DIR_REQUIRED');
  const protectedRoots = [path.join(runs, 'reference-v1-purple'), ...specs.map(s => runRoot(s.name)),
    path.resolve(moduleRoot, '../PROJECT_ACCEPTANCE.md'), path.resolve(moduleRoot, '../VTUBER_PROJECT_HANDOFF_v3.md')];
  baselines = await Promise.all(protectedRoots.map(async root => ({ root, files: await snapshot([root]) })));
  reports = await Promise.all(specs.map(s => json<AnyReport>(path.join(runRoot(s.name), 'acceptance.json'))));
  originalRefs = await inspectReferences(reports[0]!.sourceModel3);
  repeats = [];
  for (const s of specs) {
    const result = await integrate({ sdk, color: s.color, modelName: s.name, output: path.join(verification, `repeat-${s.key}`) });
    assert.ok(result.report); repeats.push(result.report);
  }
}, { timeout: 240000 });
after(async () => {
  if (baselines) for (const b of baselines) assert.deepEqual(await snapshot([b.root]), b.files);
}, { timeout: 120000 });

test('red and green runs record uppercase color, exact model name and reference-v1 binding', async () => {
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!, r = reports[i]!;
    const config = await json<AnyReport>(path.join(r.output, 'run-config.json'));
    assert.equal(r.newColor, s.color); assert.equal(r.modelName, s.name);
    assert.equal(config.color, s.color); assert.equal(config.modelName, s.name); assert.equal(config.templateId, 'reference-v1');
    assert.equal(config.layerId, 'layer_003'); assert.equal(config.drawableId, 'Outfit'); assert.equal(config.overwrite, false);
  }
});
test('both generated colors pass all 18 automatic model checks; the accepted red sample is preserved', () => {
  for (const r of repeats) {
    assert.equal(r.status, 'AUTO_CHECKS_PASS_MANUAL_RUNTIME_PENDING'); assert.equal(r.passedChecks, 18);
    assert.ok(Object.values(r.checks).every(Boolean)); assert.deepEqual(r.errors, []); assert.equal(r.warnings.length, 3);
    assert.deepEqual(r.manualAcceptance, { cubismViewer: 'PENDING', vTubeStudio: 'PENDING', overallComplete: false });
  }
  assert.equal(reports[0]!.status, 'ACCEPTANCE_PASS'); assert.equal(reports[0]!.passedChecks, 18);
  assert.ok(Object.values(reports[0]!.checks).every(Boolean)); assert.deepEqual(reports[0]!.errors, []); assert.deepEqual(reports[0]!.warnings, []);
  assert.equal(reports[0]!.manualAcceptance.cubismViewer, 'PASS'); assert.equal(reports[0]!.manualAcceptance.vTubeStudio, 'PASS');
  assert.equal(reports[0]!.manualAcceptance.overallComplete, true); assert.equal(reports[0]!.manualAcceptance.passedItems, 8);
  assert.equal(reports[1]!.status, 'AUTO_CHECKS_PASS_MANUAL_RUNTIME_PENDING'); assert.equal(reports[1]!.passedChecks, 18);
  assert.ok(Object.values(reports[1]!.checks).every(Boolean)); assert.deepEqual(reports[1]!.errors, []); assert.equal(reports[1]!.warnings.length, 3);
  assert.deepEqual(reports[1]!.manualAcceptance, { cubismViewer: 'PENDING', vTubeStudio: 'PENDING', overallComplete: false });
});
test('red and green alter only visible Outfit mask pixels; outside RGBA and all Alpha stay unchanged', async () => {
  const originalRef = originalRefs.records.find(r => r.textureIndex === 0)!, original = decodePng(await readFile(originalRef.path));
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!, r = reports[i]!;
    const mask = decodePng(await readFile(path.join(r.output, r.binding.maskPath)));
    const changed = decodePng(await readFile(path.join(r.modelDirectory, r.binding.texturePath)));
    const diff = pixelDiff(original, changed, (x, y) => mask.data[(y * mask.width + x) * 4] === 255);
    assert.equal(diff.changedPixels, 73499); assert.equal(diff.outsideAllowedChangedPixels, 0); assert.equal(diff.alphaChangedPixels, 0);
    const rgb = [1, 3, 5].map(n => parseInt(s.color.slice(n, n + 2), 16));
    for (let p = 0; p < original.width * original.height; p++) if (mask.data[p * 4] === 255 && original.data[p * 4 + 3]) {
      assert.deepEqual([...changed.data.subarray(p * 4, p * 4 + 3)], rgb);
    }
  }
});
test('every copied MOC3 is byte-identical and all model3 references resolve', async () => {
  const mocRef = originalRefs.records.find(r => r.field === 'Moc')!, originalMoc = await readFile(mocRef.path);
  const originalModel = await readFile(reports[0]!.sourceModel3);
  for (const r of [...reports, ...repeats]) for (const dir of [r.modelDirectory, r.importDirectory]) {
    assert.deepEqual(await readFile(path.join(dir, mocRef.relativePath)), originalMoc);
    const entry = path.join(dir, r.modelName + '.model3.json'); assert.deepEqual(await readFile(entry), originalModel);
    assert.equal((await inspectReferences(entry)).records.length, originalRefs.records.length);
    assert.ok(!(await snapshot([dir])).some(f => f.path.toLowerCase().endsWith('.vtube.json')));
  }
});
test('each model and VTS import folder contains the same four complete runtime files', async () => {
  for (const r of [...reports, ...repeats]) {
    const model = await relativeFingerprints(r.modelDirectory); assert.equal(model.length, 4);
    assert.deepEqual(await relativeFingerprints(r.importDirectory), model);
  }
});
test('same color and model name reproduce model, mask, binding and preview bytes', async () => {
  for (let i = 0; i < specs.length; i++) {
    const first = reports[i]!, again = repeats[i]!;
    for (const dir of ['model', 'masks', 'previews']) assert.deepEqual(await relativeFingerprints(path.join(first.output, dir)), await relativeFingerprints(path.join(again.output, dir)));
    for (const name of ['drawable-inventory.json', 'runtime-texture-bindings.json', 'ownership-check.json']) {
      assert.equal(sha256(await readFile(path.join(first.output, name))), sha256(await readFile(path.join(again.output, name))));
    }
  }
});
test('red and green outputs are distinct while sharing the exact verified mask and original MOC3', async () => {
  assert.notEqual(reports[0]!.binding.outputTextureSha256, reports[1]!.binding.outputTextureSha256);
  assert.equal(reports[0]!.binding.maskSha256, reports[1]!.binding.maskSha256);
  assert.equal(reports[0]!.binding.mocSha256, reports[1]!.binding.mocSha256);
});
function cli(args: string[]) {
  return spawnSync(process.execPath, [path.join(moduleRoot, 'src/runtime-cli.ts'), ...args], { cwd: moduleRoot, encoding: 'utf8', windowsHide: true });
}
test('invalid color exits nonzero before creating an output directory', () => {
  const name = 'failure_invalid_color_v01', target = runRoot(name);
  const result = cli(['--sdk', sdk!, '--color', '#E64B4BFF', '--output-name', name]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /INVALID_COLOR/); assert.equal(existsSync(target), false);
});
test('missing color exits nonzero before creating an output directory', () => {
  const name = 'failure_missing_color_v01', target = runRoot(name);
  const result = cli(['--sdk', sdk!, '--output-name', name]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /COLOR_REQUIRED/); assert.equal(existsSync(target), false);
});
test('existing output exits nonzero early and leaves the complete red run unchanged', async () => {
  const beforeFiles = await snapshot([runRoot(specs[0].name)]);
  const result = cli(['--sdk', sdk!, '--color', specs[0].color, '--output-name', specs[0].name]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /OUTPUT_EXISTS/); assert.deepEqual(await snapshot([runRoot(specs[0].name)]), beforeFiles);
});
test('SDK/Core remain external, unchanged, uncopied and untracked in both runs', async () => {
  for (const r of reports) {
    const audit = await json<AnyReport>(path.join(r.output, 'sdk-audit.json'));
    assert.equal(audit.sdkFilesUnchanged, true); assert.equal(audit.sdkFileCount, 291);
    assert.deepEqual(audit.gitAfter.copiedSdkFiles, []); assert.deepEqual(audit.gitAfter.sdkLinks, []);
    assert.ok(audit.gitAfter.repositories.every((x: AnyReport) => x.trackedSdkFiles.length === 0));
    for (const f of audit.sdkFingerprints) assert.deepEqual(await fingerprint(f.path), f);
  }
});
test('original, accepted purple, red and green protected baselines do not change during repeats or failure tests', async () => {
  for (const b of baselines) assert.deepEqual(await snapshot([b.root]), b.files);
  for (const r of reports) assert.ok(r.protectedFiles.every((f: AnyReport) => f.unchanged && f.sha256 === f.afterSha256));
});
test('generated Chinese reports contain the actual color, model name and copyable CLI flags', async () => {
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!, r = reports[i]!, md = await readFile(path.join(r.output, 'acceptance.md'), 'utf8');
    assert.match(md, new RegExp(s.color)); assert.match(md, new RegExp(s.name));
    assert.match(md, /--color/); assert.match(md, /--output-name/);
    if (i === 0) { assert.match(md, /ACCEPTANCE_PASS/); assert.match(md, /完成人工抽样/); }
    else assert.match(md, /人工运行验收尚未完成/);
  }
});

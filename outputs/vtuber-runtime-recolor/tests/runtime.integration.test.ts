import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { integrate, moduleRoot, modelName } from '../src/integrate.ts';
import { createCoreReader, resolveSdk } from '../src/core-reader.ts';
import type { Inventory } from '../src/core-reader.ts';
import { countMask, ownership } from '../src/uv.ts';
import { inspectReferences } from '../src/references.ts';
import { decodePng, pixelDiff, sha256 } from '../../vtuber-controlled-recolor/src/pixels.ts';
import { fingerprint, snapshot, saveJson, within } from '../../vtuber-controlled-recolor/src/files.ts';
import type { Fingerprint } from '../../vtuber-controlled-recolor/src/files.ts';

type Report = NonNullable<Awaited<ReturnType<typeof integrate>>['report']>;
const primary = path.join(moduleRoot, 'runs/reference-v1-purple');
const sdkInput = process.env.RUNTIME_SDK_ROOT;
const verification = process.env.RUNTIME_VERIFY_DIR;
const json = async <T>(file: string) => JSON.parse(await readFile(file, 'utf8')) as T;
let report: Report, repeated: Report, inventory: Inventory;
let beforePrimary: Fingerprint[], beforeSdk: Fingerprint[];
let reader: Awaited<ReturnType<typeof createCoreReader>>;
let originalRefs: Awaited<ReturnType<typeof inspectReferences>>;
let actualOwn: ReturnType<typeof ownership>;
let originalTexture: ReturnType<typeof decodePng>, changedTexture: ReturnType<typeof decodePng>;

before(async () => {
  assert.ok(sdkInput, 'SDK_REQUIRED: use scripts/verify-runtime.ts --sdk "external SDK root"');
  assert.ok(verification && within(moduleRoot, verification), 'VERIFICATION_DIRECTORY_REQUIRED');
  beforePrimary = await snapshot([primary]);
  report = await json<Report>(path.join(primary, 'acceptance.json'));
  const sdk = await resolveSdk(sdkInput, path.resolve(moduleRoot, '../..'));
  beforeSdk = await snapshot([sdk.root]);
  reader = await createCoreReader(sdk.corePath);
  originalRefs = await inspectReferences(report.sourceModel3);
  inventory = reader.extract(await readFile(originalRefs.records.find(r => r.field === 'Moc')!.path));
  const textures = await Promise.all(originalRefs.records.filter(r => r.textureIndex !== undefined)
    .sort((a, b) => a.textureIndex! - b.textureIndex!).map(async r => decodePng(await readFile(r.path))));
  actualOwn = ownership(inventory, textures, { id: 'layer_003', name: 'Outfit' });
  originalTexture = textures[actualOwn.target.textureIndex]!;
  changedTexture = decodePng(await readFile(path.join(report.modelDirectory, report.binding.texturePath)));
  const result = await integrate({ sdk: sdkInput, output: path.join(verification, 'repeat-run') });
  assert.ok(result.report, 'Independent full stage A+B run must produce a report');
  repeated = result.report;
}, { timeout: 180000 });

after(async () => {
  if (beforePrimary) assert.deepEqual(await snapshot([primary]), beforePrimary);
  if (beforeSdk) for (const f of beforeSdk) assert.deepEqual(await fingerprint(f.path), f);
  if (report && repeated && verification) await saveJson(path.join(verification, 'real-model-run-receipt.json'), {
    primaryRun: primary, independentRepeatRun: repeated.output, stageAOnlyRun: path.join(verification, 'stage-a-only'),
    sdkRoot: sdkInput, sdkFileCount: beforeSdk.length, sdkUnchanged: true, primaryUnchanged: true,
    originalTextureSha256: report.binding.originalTextureSha256,
    recoloredTextureSha256: report.binding.outputTextureSha256, maskSha256: report.binding.maskSha256,
    changedPixels: report.changedPixels, runtimeChecksPerRun: report.passedChecks,
    primaryManualAcceptance: report.manualAcceptance,
    independentRepeatManualAcceptance: repeated.manualAcceptance,
  });
});

test('real SDK/Core versions match local official metadata and the Core API', () => {
  assert.equal(report.sdkVersion, '5-r.5'); assert.equal(reader.version, '06.00.0001');
  assert.equal(report.coreVersion, reader.version); assert.equal(inventory.mocConsistency, true);
});
test('real MOC3 exports all 10 Drawable IDs, Parts, texture indices, vertices, UVs, triangles and orders', () => {
  assert.equal(inventory.drawables.length, 10); assert.deepEqual(inventory.parts, []);
  for (const d of inventory.drawables) {
    assert.equal(d.partId, null); assert.equal(d.partIndex, -1); assert.equal(d.textureIndex, 0);
    assert.equal(d.vertexUvs.length, 8); assert.equal(d.vertexPositions.length, 8); assert.equal(d.triangleIndices.length, 6);
    assert.ok(Number.isInteger(d.renderOrder)); assert.ok(d.id);
  }
});
test('real Outfit binding uses one exact Drawable ID and the texture path from model3.json', () => {
  assert.equal(inventory.drawables.filter(d => d.id === 'Outfit').length, 1);
  assert.equal(report.binding.layerId, 'layer_003'); assert.equal(report.binding.drawableId, 'Outfit');
  assert.equal(report.binding.textureIndex, actualOwn.target.textureIndex);
  assert.equal(report.binding.texturePath, originalRefs.records.find(r => r.textureIndex === actualOwn.target.textureIndex)!.relativePath);
});
test('real triangle rasterization reproduces the mask and has zero overlap with all 9 other Drawables', async () => {
  assert.equal(countMask(actualOwn.targetMask), 93564); assert.equal(actualOwn.comparisons.length, 9);
  assert.equal(actualOwn.directOverlapPixels, 0); assert.equal(actualOwn.guardedOverlapPixels, 0); assert.equal(actualOwn.unique, true);
  const disk = decodePng(await readFile(path.join(primary, report.binding.maskPath)));
  assert.equal(disk.width, originalTexture.width); assert.equal(disk.height, originalTexture.height);
  for (let p = 0; p < actualOwn.targetMask.length; p++) {
    const v = actualOwn.targetMask[p] ? 255 : 0;
    assert.ok(disk.data[p * 4] === v && disk.data[p * 4 + 1] === v && disk.data[p * 4 + 2] === v && disk.data[p * 4 + 3] === 255);
  }
});
test('real six authored controls preserve UVs, triangles and texture indices at all 12 endpoints', async () => {
  const check = await json<{ parameterChecks: { uvTextureAndIndicesUnchanged: boolean }[] }>(path.join(primary, 'ownership-check.json'));
  assert.equal(check.parameterChecks.length, 12); assert.ok(check.parameterChecks.every(c => c.uvTextureAndIndicesUnchanged));
});
test('every original and previously accepted protected file still matches its recorded SHA-256', async () => {
  assert.equal(report.originalFiles.length, 8);
  for (const f of report.protectedFiles) assert.equal((await fingerprint(f.path)).sha256, f.sha256, f.path);
  for (const f of report.originalFiles) assert.deepEqual(await fingerprint(f.path), f);
});
test('all 291 external SDK files stay unchanged and the audit finds no copied or Git-tracked SDK', async () => {
  const audit = await json<{ sdkFingerprints: Fingerprint[]; gitAfter: { copiedSdkFiles: string[]; sdkLinks: string[]; repositories: { trackedSdkFiles: string[] }[] } }>(path.join(primary, 'sdk-audit.json'));
  assert.equal(beforeSdk.length, 291); assert.deepEqual(beforeSdk, audit.sdkFingerprints);
  assert.deepEqual(audit.gitAfter.copiedSdkFiles, []); assert.deepEqual(audit.gitAfter.sdkLinks, []);
  assert.ok(audit.gitAfter.repositories.every(r => r.trackedSdkFiles.length === 0));
});
test('real copied MOC3 bytes and the full parameter/Drawable inventory equal the original', async () => {
  const ref = originalRefs.records.find(r => r.field === 'Moc')!, original = await readFile(ref.path);
  for (const r of [report, repeated]) for (const dir of [r.modelDirectory, r.importDirectory]) {
    const copied = await readFile(path.join(dir, ref.relativePath)); assert.deepEqual(copied, original);
    assert.deepEqual(reader.extract(copied), inventory);
  }
});
test('real atlas retains every Alpha byte, every outside-mask RGBA byte and all fully transparent RGBA', () => {
  const diff = pixelDiff(originalTexture, changedTexture, (x, y) => !!actualOwn.targetMask[y * originalTexture.width + x]);
  assert.equal(diff.alphaChangedPixels, 0); assert.equal(diff.outsideAllowedChangedPixels, 0);
  for (let p = 0; p < actualOwn.targetMask.length; p++) if (!originalTexture.data[p * 4 + 3]) {
    for (let c = 0; c < 4; c++) assert.equal(changedTexture.data[p * 4 + c], originalTexture.data[p * 4 + c]);
  }
});
test('exactly 73499 real visible Outfit pixels change to #7A5AF8', () => {
  assert.equal(report.changedPixels, 73499); assert.equal(pixelDiff(originalTexture, changedTexture).changedPixels, 73499);
  let visible = 0;
  for (let p = 0; p < actualOwn.targetMask.length; p++) if (actualOwn.targetMask[p] && originalTexture.data[p * 4 + 3]) {
    visible++; assert.equal(changedTexture.data[p * 4], 122); assert.equal(changedTexture.data[p * 4 + 1], 90); assert.equal(changedTexture.data[p * 4 + 2], 248);
  }
  assert.equal(visible, 73499); assert.equal(report.binding.originalColors.reduce((n, c) => n + c.pixels, 0), visible);
});
test('renamed model3 content stays byte-identical and every dynamic relative reference exists', async () => {
  const original = await readFile(report.sourceModel3);
  for (const r of [report, repeated]) for (const dir of [r.modelDirectory, r.importDirectory]) {
    const entry = path.join(dir, modelName + '.model3.json'); assert.deepEqual(await readFile(entry), original);
    const refs = await inspectReferences(entry); assert.equal(refs.records.length, originalRefs.records.length);
    assert.deepEqual(refs.records.map(x => x.relativePath), originalRefs.records.map(x => x.relativePath));
  }
});
async function relativeFingerprints(root: string) {
  return (await snapshot([root])).map(f => ({ path: path.relative(root, f.path), bytes: f.bytes, sha256: f.sha256 }));
}
test('both complete output model folders contain all 4 runtime files with identical contents', async () => {
  for (const r of [report, repeated]) {
    const model = await relativeFingerprints(r.modelDirectory); assert.equal(model.length, 4);
    assert.deepEqual(await relativeFingerprints(r.importDirectory), model);
  }
});
test('neither run copies old .vtube.json or editable PSD/cmo3 files into its runtime folders', async () => {
  for (const r of [report, repeated]) for (const dir of [r.modelDirectory, r.importDirectory]) {
    assert.ok((await snapshot([dir])).every(f => !/\.(?:vtube\.json|psd|cmo3)$/i.test(f.path)));
  }
});
test('two independent full runs reproduce model files, UV masks, bindings and every preview byte-for-byte', async () => {
  for (const dir of ['model', 'masks', 'previews']) assert.deepEqual(await relativeFingerprints(path.join(primary, dir)), await relativeFingerprints(path.join(repeated.output, dir)));
  for (const name of ['drawable-inventory.json', 'runtime-texture-bindings.json', 'ownership-check.json']) {
    assert.equal(sha256(await readFile(path.join(primary, name))), sha256(await readFile(path.join(repeated.output, name))));
  }
});
test('independent verification does not overwrite any existing primary acceptance output', async () => {
  assert.deepEqual(await snapshot([primary]), beforePrimary);
});
test('stage-A-only execution writes ownership evidence but never creates any model folder', async () => {
  const result = await integrate({ sdk: sdkInput!, output: path.join(verification!, 'stage-a-only'), stageAOnly: true });
  assert.equal(result.status, 'STAGE_A_PASS_ONLY'); assert.equal(result.modelCreated, false);
  const files = await readdir(result.output); assert.ok(!files.includes('model')); assert.ok(!files.includes('vts-import'));
  assert.ok(!(await snapshot([result.output])).some(f => f.path.endsWith('.moc3')));
});
test('rerunning into an existing output returns EEXIST without replacing any file', async () => {
  await assert.rejects(integrate({ sdk: sdkInput!, output: primary }), { code: 'EEXIST' });
  assert.deepEqual(await snapshot([primary]), beforePrimary);
});
test('manual acceptance belongs to its recorded primary model; new runs remain PENDING', async () => {
  for (const r of [report, repeated]) {
    assert.equal(r.passedChecks, 18); assert.ok(Object.values(r.checks).every(Boolean)); assert.deepEqual(r.errors, []);
    assert.match(r.previewMethod, /Not a Viewer\/VTS screenshot/);
  }
  // A new automatic run must never inherit a previous run's human approval.
  assert.equal(repeated.status, 'AUTO_CHECKS_PASS_MANUAL_RUNTIME_PENDING'); assert.equal(repeated.warnings.length, 3);
  assert.deepEqual(repeated.manualAcceptance, { cubismViewer: 'PENDING', vTubeStudio: 'PENDING', overallComplete: false });
  if (report.status === 'ACCEPTANCE_PASS') {
    assert.equal(report.warnings.length, 0);
    assert.equal(report.manualAcceptance.cubismViewer, 'PASS'); assert.equal(report.manualAcceptance.vTubeStudio, 'PASS');
    assert.equal(report.manualAcceptance.overallComplete, true);
    const record = await json<{ status: string; runId: string; evidenceSource: string; cubismViewer: string; vTubeStudio: string;
      checks: { id: string; status: string }[]; modelFileFingerprints: Fingerprint[] }>(path.join(primary, 'manual-acceptance/2026-09-06/manual-acceptance.json'));
    assert.equal(record.status, 'MANUAL_ACCEPTANCE_PASS'); assert.equal(record.runId, 'reference-v1-purple');
    assert.equal(record.evidenceSource, 'USER_ATTESTATION_IN_CURRENT_CONVERSATION');
    assert.equal(record.cubismViewer, 'PASS'); assert.equal(record.vTubeStudio, 'PASS');
    assert.equal(record.checks.length, 7); assert.equal(new Set(record.checks.map(c => c.id)).size, 7);
    assert.ok(record.checks.every(c => c.status === 'PASS'));
    assert.equal(record.modelFileFingerprints.length, 8);
    for (const f of record.modelFileFingerprints) assert.deepEqual(await fingerprint(f.path), f);
  } else {
    assert.equal(report.status, 'AUTO_CHECKS_PASS_MANUAL_RUNTIME_PENDING'); assert.equal(report.warnings.length, 3);
    assert.deepEqual(report.manualAcceptance, { cubismViewer: 'PENDING', vTubeStudio: 'PENDING', overallComplete: false });
  }
});

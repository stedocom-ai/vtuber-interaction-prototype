import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { collectReferences, findModel, inspectReferences, requireVerifiedOwnership } from '../src/references.ts';
import { moduleRoot } from '../src/preflight.ts';
import { save, saveJson, snapshot } from '../../vtuber-controlled-recolor/src/files.ts';

const model = () => ({ Version: 3, FileReferences: { Moc: 'custom.moc3', Textures: ['different-atlas/a.png', 'second/b.png'], DisplayInfo: 'custom.cdi3.json' } });
async function fixture() {
  const tempRoot = path.join(moduleRoot, '.test-tmp'); await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, 'refs-'));
  await saveJson(path.join(root, 'custom.model3.json'), model());
  for (const r of collectReferences(model())) await save(path.join(root, r.path), 'read-only fixture for reference existence checks');
  return root;
}
test('texture paths and indices come from FileReferences.Textures, not a fixed texture_00 path', () => {
  assert.deepEqual(collectReferences(model()).filter(r => r.textureIndex !== undefined), [
    { field: 'Textures[0]', path: 'different-atlas/a.png', textureIndex: 0 },
    { field: 'Textures[1]', path: 'second/b.png', textureIndex: 1 },
  ]);
});
test('all standard model references including motions and sound are collected', () => {
  const m = { Version: 3, FileReferences: { ...model().FileReferences, Physics: 'p.json', Pose: 'pose.json', UserData: 'user.json',
    Expressions: [{ Name: 'smile', File: 'smile.exp3.json' }], Motions: { Idle: [{ File: 'idle.motion3.json', Sound: 'sound.wav', FadeInTime: 1 }] } } };
  assert.equal(collectReferences(m).length, 10);
});
test('missing texture list returns explicit error', () => assert.throws(() => collectReferences({ Version: 3, FileReferences: { Moc: 'a.moc3' } }), /TEXTURES_MISSING/));
test('unknown file reference is rejected rather than silently ignored', () => assert.throws(() => collectReferences({ Version: 3, FileReferences: { ...model().FileReferences, UnexpectedFile: 'a.bin' } }), /UNKNOWN_FILE_REFERENCE/));
test('old vtube.json cannot be smuggled in as a model reference', () => assert.throws(() => collectReferences({ Version: 3, FileReferences: { ...model().FileReferences, UserData: 'old.vtube.json' } }), /LEGACY_VTS_REFERENCE/));
for (const p of ['../outside.png', 'C:/outside.png', '/outside.png', 'https://example.com/a.png', 'folder\\a.png']) {
  test('unsafe reference rejected: ' + p, () => assert.throws(() => collectReferences({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: [p] } }), /UNSAFE_PATH/));
}
test('exactly one model entry is discovered without relying on its filename', async () => {
  const root = await fixture(); assert.equal(await findModel(root), path.join(root, 'custom.model3.json'));
});
test('multiple model entries are rejected instead of guessing', async () => {
  const root = await fixture(); await saveJson(path.join(root, 'other.model3.json'), model()); await assert.rejects(findModel(root), /MODEL3_NOT_UNIQUE/);
});
test('all referenced files are checked and source bytes remain untouched', async () => {
  const root = await fixture(), before = await snapshot([root]);
  const result = await inspectReferences(path.join(root, 'custom.model3.json'));
  assert.equal(result.records.length, 4); assert.ok(result.records.every(r => r.exists)); assert.deepEqual(await snapshot([root]), before);
});
test('missing referenced file returns a clear error', async () => {
  const root = await fixture(), m = model(); m.FileReferences.Textures = ['missing.png']; await saveJson(path.join(root, 'broken.model3.json'), m);
  await assert.rejects(inspectReferences(path.join(root, 'broken.model3.json')), /REFERENCED_FILE_MISSING_OR_UNSAFE.*missing.png/);
});
test('same inputs yield identical reference records and fingerprints', async () => {
  const root = await fixture(), file = path.join(root, 'custom.model3.json'); assert.deepEqual(await inspectReferences(file), await inspectReferences(file));
});
test('missing ownership evidence stops before any mask or model is created', async () => {
  const root = await fixture(), before = await snapshot([root]);
  assert.throws(() => requireVerifiedOwnership(null), /RUNTIME_OWNERSHIP_UNVERIFIED/); assert.deepEqual(await snapshot([root]), before);
  assert.ok(!(await readdir(root)).includes('model'));
});
test('a claimed valid flag, color match, rectangle or hand-written JSON cannot bypass the ownership gate', () => {
  for (const evidence of [{ valid: true }, { color: '#3F5F9B' }, { x: 0, y: 700, width: 300, height: 320 }, { maskPath: 'guessed.png' }]) {
    assert.throws(() => requireVerifiedOwnership(evidence), /OWNERSHIP_ADAPTER_UNAVAILABLE/);
  }
});
test('reference validation does not rewrite the model3 file', async () => {
  const root = await fixture(), file = path.join(root, 'custom.model3.json'), before = await readFile(file);
  await inspectReferences(file); assert.deepEqual(await readFile(file), before);
});

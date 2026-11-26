import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { relativeFile, modelReferences, validateMocHash, MOC_SHA256, parameterMetadata, parameterValue, projection, PARAMETERS } from '../web/contracts.js';
import { startServer, readModel, modelPresets, moduleRoot, allowedHost } from '../src/server.ts';

const valid = { Version: 3, FileReferences: { Moc: 'test.moc3', Textures: ['atlas/texture.png'], DisplayInfo: 'test.cdi3.json' } };
test('model references use JSON paths and retain texture subfolder', () => assert.deepEqual(modelReferences(valid), ['test.moc3', 'atlas/texture.png', 'test.cdi3.json']));
for (const value of ['../outside.png', 'C:/outside.png', '/outside.png', 'a\\b.png', 'https://example.com/a.png', 'a/%2e%2e/b', 'a//b', 'a./b']) test('unsafe path rejected: ' + value, () => assert.throws(() => relativeFile(value), /UNSAFE_PATH/));
test('model version invalid rejected', () => assert.throws(() => modelReferences({ ...valid, Version: 2 }), /MODEL_INVALID/));
test('unsupported motions are explicit scope failure', () => assert.throws(() => modelReferences({ ...valid, FileReferences: { ...valid.FileReferences, Motions: {} } }), /SCOPE_UNSUPPORTED/));
test('missing texture rejected', () => assert.throws(() => modelReferences({ ...valid, FileReferences: { ...valid.FileReferences, Textures: [] } }), /TEXTURE_COUNT/));
test('wrong reference type rejected', () => assert.throws(() => modelReferences({ ...valid, FileReferences: { ...valid.FileReferences, Moc: 'old.vtube.json' } }), /REFERENCE_TYPE/));
test('only exact accepted reference MOC hash allowed', () => { validateMocHash(MOC_SHA256); assert.throws(() => validateMocHash('00'.repeat(32)), /TEMPLATE_MISMATCH/); });
const model = {
  getParameterCount: () => 6, getParameterId: (i: number) => ({ getString: () => PARAMETERS[i][0] }),
  getParameterMinimumValue: (i: number) => i < 3 ? -30 : 0,
  getParameterMaximumValue: (i: number) => i < 3 ? 30 : 1,
  getParameterDefaultValue: (i: number) => i === 3 || i === 4 ? 1 : 0,
};
test('six ranges/defaults are read from Core metadata', () => { const data = parameterMetadata(model); assert.equal(data.length, 6); assert.equal(data[3].default, 1); assert.equal(data[0].min, -30); });
test('missing parameter fails closed', () => assert.throws(() => parameterMetadata({ ...model, getParameterCount: () => 5 }), /PARAMETER_MISSING/));
test('invalid parameter ranges fail closed', () => assert.throws(() => parameterMetadata({ ...model, getParameterMinimumValue: () => NaN }), /PARAMETER_RANGE/));
test('slider values reject nonnumeric and out-of-range inputs', () => { for (const value of ['', 'bad', Infinity, 31]) assert.throws(() => parameterValue({ min: -30, max: 30 }, value), /PARAMETER_VALUE/); assert.equal(parameterValue({ min: 0, max: 1 }, '.5'), .5); });
test('projection keeps world-to-pixel X/Y scale equal after resize', () => { for (const [w,h] of [[600,900],[1200,400]]) { const m = projection([-1,-2,1,2],w,h); assert.ok(Math.abs(m[0]*w - m[5]*h) < .0001); } });
test('projection rejects invalid zoom/dimensions', () => { assert.throws(() => projection([-1,-1,1,1], 0, 100), /VIEW_INVALID/); assert.throws(() => projection([-1,-1,1,1], 100, 100, 10), /VIEW_INVALID/); });
test('all five real model packages are complete and exact MOC', async () => { for (const [id,,file] of modelPresets) { const result = await readModel(path.resolve(moduleRoot, file)); assert.equal(Object.keys(result.files).length, 4, id); assert.equal(result.hashes[result.json.FileReferences.Moc], MOC_SHA256); } });
test('local service host allowlist rejects DNS rebinding', () => { assert.ok(allowedHost('127.0.0.1:1234', 1234)); assert.ok(!allowedHost('attacker.example:1234',1234)); });
test('HTTP routes are read-only, isolated, external SDK no-store', async () => {
  const app = await startServer();
  try {
    const config = await fetch(app.url + '/api/config'); assert.equal(config.status,200); assert.equal((await config.json()).verification,false);
    assert.equal(config.headers.get('cache-control'),'no-store');
    assert.match(config.headers.get('content-security-policy')!, /connect-src 'self'/);
    assert.equal((await fetch(app.url + '/api/config', { headers: { Origin: 'https://example.com' } })).status,403);
    assert.equal((await fetch(app.url + '/api/evidence', { method:'POST', body:'{}' })).status,405);
    assert.equal((await fetch(app.url + '/models/gold/unknown.moc3')).status,404);
    assert.equal((await fetch(app.url + '/models/gold/..%2F..%2FREADME.md')).status,404);
    assert.equal((await fetch(app.url + '/sdk/README.md')).status,400);
    const core = await fetch(app.url + '/sdk/core.js'); assert.equal(core.headers.get('cache-control'),'no-store');
    assert.equal(Buffer.compare(Buffer.from(await core.arrayBuffer()), await readFile(app.sdk.corePath)),0);
    const mod = await fetch(app.url + '/sdk/framework/model/cubismmoc.js'); assert.equal(mod.status,200);
    const body = await mod.text(); assert.ok(/from ['"]\.\/cubismmodel\.js['"]/.test(body), 'memory import must have .js extension'); assert.ok(!body.includes('sourceMappingURL'), 'no source maps');
    assert.ok(app.sdkMemory.cache.size >= 2);
  } finally { await app.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_POSE, MODEL_ID, STALE_MS, validateClientId, validatePose} from '../web/protocol.js';
import {OutputError, OutputState} from '../src/state.ts';

const first = 'client-first-001';
const second = 'client-second-002';
const pose = {...DEFAULT_POSE, ParamAngleX: 12, ParamAngleY: -9, ParamAngleZ: 7, ParamEyeLOpen: .2, ParamEyeROpen: .8, ParamMouthOpenY: .4};
const packet = (sequence = 0, values = pose, clientId = first) => ({clientId, sequence, modelId: MODEL_ID, values});
const errorIs = (code, status = 400) => error => error instanceof OutputError && error.code === code && error.status === status;

test('protocol fixes one gold model, six neutral parameters and 1500 ms expiry', () => {
  assert.equal(MODEL_ID, 'gold');
  assert.equal(STALE_MS, 1500);
  assert.deepEqual(DEFAULT_POSE, {ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthOpenY: 0});
  assert.equal(Object.isFrozen(DEFAULT_POSE), true);
});
test('pose validation returns a fresh six-key object in canonical order', () => {
  const input = Object.fromEntries(Object.entries(pose).reverse());
  const result = validatePose(input);
  assert.deepEqual(result, pose);assert.notEqual(result, input);
  assert.deepEqual(Object.keys(result), Object.keys(DEFAULT_POSE));
  result.ParamAngleX = 25;assert.equal(input.ParamAngleX, 12);
});
for (const key of Object.keys(DEFAULT_POSE)) test('strict inclusive bounds without clamping: ' + key, () => {
  const minimum = key.startsWith('ParamAngle') ? -30 : 0, maximum = key.startsWith('ParamAngle') ? 30 : 1;
  for (const value of [minimum, maximum, (minimum + maximum) / 2]) assert.equal(validatePose({...pose, [key]: value})[key], value);
  for (const value of [minimum - .001, maximum + .001]) assert.throws(() => validatePose({...pose, [key]: value}));
});
test('all pose fields reject nonnumbers, NaN and infinities', () => {
  for (const key of Object.keys(DEFAULT_POSE)) for (const value of [NaN, Infinity, -Infinity, '0', null, undefined, false, 0n]) {
    assert.throws(() => validatePose({...pose, [key]: value}));
  }
});
test('pose rejects missing, extra, inherited, symbol and nonenumerable extra fields', () => {
  for (const value of [null, [], {}, false, 'pose', {...pose, video: 'not allowed'}]) assert.throws(() => validatePose(value));
  for (const key of Object.keys(DEFAULT_POSE)) {const value = {...pose};delete value[key];assert.throws(() => validatePose(value));}
  assert.throws(() => validatePose(Object.create(pose)));
  assert.throws(() => validatePose({...pose, [Symbol('unknown')]: 1}));
  assert.throws(() => validatePose(Object.defineProperty({...pose}, 'unknown', {value: 1})));
});
test('client IDs allow exactly 8 through 80 ASCII alphanumeric/hyphen characters', () => {
  for (const value of ['A1-b2-C3', 'a'.repeat(80), '--------', first]) assert.equal(validateClientId(value), value);
  for (const value of ['', 'a'.repeat(7), 'a'.repeat(81), 'client_id', 'client id', 'client中文', first + '\n', 12345678, null]) {
    assert.throws(() => validateClientId(value));
  }
});
test('initial public state is inactive, neutral and contains no owner or token', () => {
  assert.deepEqual(new OutputState().read(0), {active: false, stale: false, revision: 0, modelId: 'gold', values: {...DEFAULT_POSE}});
});
test('start reserves a neutral lease and first sequence 0 publishes successfully', () => {
  const state = new OutputState();
  assert.deepEqual(state.start(first, 100), {active: true, stale: false, revision: 1, modelId: 'gold', values: {...DEFAULT_POSE}});
  assert.deepEqual(state.publish(packet(), 101), {active: true, stale: false, revision: 2, modelId: 'gold', values: pose});
});
test('publish is forbidden before explicit start', () => {
  const state = new OutputState(), before = state.read(10);
  assert.throws(() => state.publish(packet(), 10), errorIs('OUTPUT_NOT_ACTIVE', 409));
  assert.deepEqual(state.read(10), before);
});
test('same-owner repeated start is idempotent and does not renew TTL', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(), 10);
  const before = state.read(20);assert.deepEqual(state.start(first, 1400), before);
  assert.equal(state.read(1511).stale, true);
});
test('same-owner repeated start cannot reset sequence ordering', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(4), 10);state.start(first, 20);
  assert.throws(() => state.publish(packet(0), 30), errorIs('SEQUENCE_INVALID', 409));
  assert.equal(state.publish(packet(5), 30).revision, 3);
});
test('one live owner excludes another writer and stopper without changing values or revision', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(), 10);const before = state.read(20);
  assert.throws(() => state.start(second, 100), errorIs('OUTPUT_OWNER_CONFLICT', 409));
  assert.throws(() => state.publish(packet(1, pose, second), 100), errorIs('OUTPUT_OWNER_CONFLICT', 409));
  assert.throws(() => state.stop(second, 100), errorIs('OUTPUT_OWNER_CONFLICT', 409));
  assert.deepEqual(state.read(100), before);
  assert.equal(state.read(1511).stale, true);
});
test('TTL is inclusive at 1500 ms and stale strictly after it; old expression is erased', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(), 10);
  assert.equal(state.read(1510).active, true);
  const expired = state.read(1510.001);
  assert.deepEqual(expired, {active: false, stale: true, revision: 3, modelId: 'gold', values: {...DEFAULT_POSE}});
  assert.deepEqual(state.read(9000), expired);
});
test('reading does not refresh a publisher lease', () => {
  const state = new OutputState();state.start(first, 0);
  for (let now = 100; now <= 1500; now += 100) assert.equal(state.read(now).active, true);
  assert.equal(state.read(1501).stale, true);
});
test('each successful latest frame renews the lease', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(0), 1000);state.publish(packet(1), 2000);
  assert.equal(state.read(3500).active, true);assert.equal(state.read(3501).stale, true);
});
test('new owner may take over expired lease without a preliminary read', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(), 10);
  assert.throws(() => state.start(second, 1510), errorIs('OUTPUT_OWNER_CONFLICT', 409));
  assert.deepEqual(state.start(second, 1511), {active: true, stale: false, revision: 3, modelId: 'gold', values: {...DEFAULT_POSE}});
  assert.equal(state.publish(packet(0, pose, second), 1512).revision, 4);
  assert.throws(() => state.stop(first, 1513), errorIs('OUTPUT_OWNER_CONFLICT', 409));
});
test('expired publisher must explicitly start again before another frame', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(9), 10);
  assert.throws(() => state.publish(packet(10), 1511), errorIs('OUTPUT_NOT_ACTIVE', 409));
  state.start(first, 1511);assert.equal(state.publish(packet(0), 1512).active, true);
});
test('stop clears pose and ownership; idle stop is idempotent', () => {
  const state = new OutputState();assert.equal(state.stop(first, 0).revision, 0);
  state.start(first, 0);state.publish(packet(), 1);
  const stopped = state.stop(first, 2);
  assert.deepEqual(stopped, {active: false, stale: false, revision: 3, modelId: 'gold', values: {...DEFAULT_POSE}});
  assert.deepEqual(state.stop(first, 3), stopped);
  assert.throws(() => state.publish(packet(1), 3), errorIs('OUTPUT_NOT_ACTIVE', 409));
  state.start(second, 3);assert.equal(state.publish(packet(0, pose, second), 4).active, true);
});
test('stale state may be explicitly cleared without reviving its expression', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(), 1);state.read(1502);
  assert.deepEqual(state.stop(first, 1503), {active: false, stale: false, revision: 4, modelId: 'gold', values: {...DEFAULT_POSE}});
});
for (const missing of ['clientId', 'sequence', 'modelId', 'values']) test('missing frame field never changes state: ' + missing, () => {
  const state = new OutputState();state.start(first, 0);const value = packet();delete value[missing];const before = state.read(0);
  assert.throws(() => state.publish(value, 1000), errorIs('PUBLISH_INVALID'));
  assert.deepEqual(state.read(1000), before);assert.equal(state.read(1501).stale, true);
});
test('frame rejects unknown fields, primitive/array bodies and symbol keys', () => {
  const state = new OutputState();state.start(first, 0);const before = state.read(0);
  for (const value of [null, [], {}, 'frame', {...packet(), camera: true}, {...packet(), [Symbol('token')]: 1}]) {
    assert.throws(() => state.publish(value, 100), errorIs('PUBLISH_INVALID'));assert.deepEqual(state.read(100), before);
  }
});
test('non-gold model identifiers are rejected without replacing the latest frame', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(), 1);const before = state.read(2);
  for (const modelId of ['red', 'purple', 'Gold', null, 1]) {
    assert.throws(() => state.publish({...packet(1), modelId}, 100), errorIs('MODEL_UNSUPPORTED'));assert.deepEqual(state.read(100), before);
  }
});
test('invalid sequence types and unsafe integers do not renew or mutate the lease', () => {
  const state = new OutputState();state.start(first, 0);const before = state.read(0);
  for (const sequence of [-1, .5, NaN, Infinity, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => state.publish({...packet(), sequence}, 1000), errorIs('SEQUENCE_INVALID'));assert.deepEqual(state.read(1000), before);
  }
  assert.equal(state.read(1501).stale, true);
});
test('sequence must increase but may skip numbers and reach MAX_SAFE_INTEGER', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(2), 1);const before = state.read(1);
  for (const sequence of [0, 1, 2]) assert.throws(() => state.publish(packet(sequence), 100), errorIs('SEQUENCE_INVALID', 409));
  assert.deepEqual(state.read(100), before);
  assert.equal(state.publish(packet(Number.MAX_SAFE_INTEGER), 200).revision, 3);
});
test('invalid pose does not clamp, partially apply, refresh TTL or change revision', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(), 10);const before = state.read(10);
  for (const values of [{...pose, ParamAngleX: 31}, {...pose, ParamEyeLOpen: NaN}, {...pose, ParamMouthOpenY: '1'}, {...pose, extra: 1}]) {
    assert.throws(() => state.publish(packet(1, values), 1000), errorIs('POSE_INVALID'));assert.deepEqual(state.read(1000), before);
  }
  assert.equal(state.read(1511).stale, true);
});
test('invalid client identifiers never change any operation state', () => {
  const state = new OutputState();state.start(first, 0);state.publish(packet(), 10);const before = state.read(10);
  assert.throws(() => state.start('short', 1000), errorIs('CLIENT_ID_INVALID'));
  assert.throws(() => state.stop('short', 1000), errorIs('CLIENT_ID_INVALID'));
  assert.throws(() => state.publish(packet(1, pose, 'short'), 1000), errorIs('CLIENT_ID_INVALID'));
  assert.deepEqual(state.read(1000), before);assert.equal(state.read(1511).stale, true);
});
test('invalid internal timestamps fail before state mutation', () => {
  const state = new OutputState();state.start(first, 0);const before = state.read(0);
  for (const now of [-1, NaN, Infinity, '100']) {
    for (const operation of [() => state.start(first, now), () => state.publish(packet(), now), () => state.stop(first, now), () => state.read(now)]) {
      assert.throws(operation, errorIs('OUTPUT_TIME_INVALID'));assert.deepEqual(state.read(0), before);
    }
  }
});
test('published input and public snapshots cannot mutate the stored latest pose', () => {
  const state = new OutputState(), values = {...pose};state.start(first, 0);const response = state.publish(packet(0, values), 1);
  values.ParamAngleX = 30;response.values.ParamAngleY = 30;
  const read = state.read(2);assert.deepEqual(read.values, pose);read.values.ParamEyeLOpen = 1;
  assert.deepEqual(state.read(3).values, pose);
});
test('all public operation responses expose only the five documented fields', () => {
  const state = new OutputState(), responses = [state.read(0), state.start(first, 0), state.publish(packet(), 1), state.stop(first, 2)];
  for (const response of responses) {
    assert.deepEqual(Object.keys(response), ['active', 'stale', 'revision', 'modelId', 'values']);
    assert.equal(JSON.stringify(response).includes(first), false);assert.equal('token' in response, false);
  }
});
test('instances have no persisted state, history or ownership in common', () => {
  const one = new OutputState();one.start(first, 0);one.publish(packet(), 1);
  const two = new OutputState();assert.equal(two.read(1).revision, 0);assert.equal(two.read(1).active, false);
  assert.equal(two.start(second, 1).active, true);assert.deepEqual(one.read(1).values, pose);
});

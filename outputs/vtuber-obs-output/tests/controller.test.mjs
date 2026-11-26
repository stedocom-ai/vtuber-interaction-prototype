import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {OutputController} from '../web/controller-client.js';
import {DEFAULT_POSE, MODEL_ID, STALE_MS, validatePose} from '../web/protocol.js';
import {OutputState} from '../src/state.ts';

const configuration = Object.freeze({token: 'local-write-token', modelId: MODEL_ID,
  modelName: 'gold.model3.json', modelPath: 'C:/verified/gold/model/gold.model3.json',
  outputUrl: 'http://127.0.0.1:12345/obs/output', staleMs: STALE_MS});
const pose = {...DEFAULT_POSE, ParamAngleX: 15, ParamEyeLOpen: .25, ParamMouthOpenY: .7};
const state = (active = true, values = pose) => ({active, stale: false, revision: 1, modelId: MODEL_ID, values});
const response = (data, ok = true) => ({ok, json: async () => data});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
function clock() {
  let serial = 0;
  const tasks = new Map();
  return {tasks, schedule: (fn, ms) => { const id = ++serial; tasks.set(id, {fn, ms}); return id; },
    cancel: id => tasks.delete(id), fire(ms) { const entry = [...tasks].find(([, task]) => task.ms === ms); assert.ok(entry, `timer ${ms} exists`); tasks.delete(entry[0]); entry[1].fn(); }};
}
function harness({request, source, timeoutMs = 1000, createClientId} = {}) {
  const timer = clock(), calls = [], statuses = [];
  let lease = 0;
  const current = source ?? {ready: true, identity: {name: configuration.modelName, source: configuration.modelPath}, values: {...pose}};
  const client = new OutputController({createClientId: createClientId ?? (() => ++lease === 1 ? 'test-client-one' : `test-client-${lease}`), readSource: () => current,
    schedule: timer.schedule, cancel: timer.cancel, timeoutMs, onStatus: s => statuses.push(s),
    request: async (url, options) => {
      calls.push({url, options, body: options.body ? JSON.parse(options.body) : undefined});
      if (request) return request(url, options);
      return response(url.endsWith('/controller') ? {...configuration} : state(!url.endsWith('/stop')));
    }});
  return {client, timer, calls, statuses, current};
}

test('loading configuration is read-only and never starts output or a camera', async () => {
  const h = harness();
  assert.equal(await h.client.load(), true);
  assert.equal(h.client.running, false);
  assert.deepEqual(h.calls.map(x => [x.url, x.options.method]), [['/api/output/controller', 'GET']]);
  assert.equal(h.calls[0].options.headers, undefined);
  assert.equal(h.timer.tasks.size, 0);
});

test('explicit start uses token header and schedules only numeric frames at 50 ms', async () => {
  const h = harness(); await h.client.load();
  assert.equal(await h.client.start(), true);
  assert.equal(h.client.running, true);
  const start = h.calls[1];
  assert.equal(start.url, '/api/output/start');
  assert.deepEqual(start.body, {clientId: 'test-client-one'});
  assert.equal(start.options.headers['X-Output-Token'], configuration.token);
  assert.equal(start.options.headers['Content-Type'], 'application/json');
  assert.deepEqual([...h.timer.tasks.values()].map(x => x.ms), [50]);
  await h.client.tick();
  const frame = h.calls[2];
  assert.deepEqual(frame.body, {clientId: 'test-client-one', sequence: 0, modelId: MODEL_ID, values: pose});
  assert.deepEqual(Object.keys(frame.body.values), Object.keys(DEFAULT_POSE));
  assert.ok(Object.values(frame.body.values).every(x => typeof x === 'number'));
  await h.client.stop();
});

test('successive frames have increasing sequence and copied numeric snapshots', async () => {
  const h = harness(); await h.client.load(); await h.client.start();
  await h.client.tick(); h.current.values.ParamAngleX = -20; await h.client.tick();
  const frames = h.calls.filter(x => x.url.endsWith('/frame'));
  assert.deepEqual(frames.map(x => x.body.sequence), [0, 1]);
  assert.equal(frames[0].body.values.ParamAngleX, 15);
  assert.equal(frames[1].body.values.ParamAngleX, -20);
  await h.client.stop();
});

for (const [label, change] of [
  ['different name', s => { s.identity.name = 'purple.model3.json'; }],
  ['same name but different source', s => { s.identity.source += '-copy'; }],
  ['ambiguous null identity', s => { s.identity = null; }]
]) test('non-gold identity is rejected before any write: ' + label, async () => {
  const h = harness(); await h.client.load(); change(h.current);
  assert.equal(await h.client.start(), false);
  assert.equal(h.calls.length, 1);
  assert.match(h.client.message, /本轮只支持.*金色/);
});

test('unready renderer cannot start output', async () => {
  const h = harness(); await h.client.load(); h.current.ready = false;
  assert.equal(await h.client.start(), false); assert.equal(h.calls.length, 1);
  assert.match(h.client.message, /尚未就绪/);
});

test('unconfigured controller cannot write', async () => {
  const h = harness(); assert.equal(await h.client.start(), false); assert.equal(h.calls.length, 0);
});

test('changing away from gold stops without publishing mismatched pose', async () => {
  const h = harness(); await h.client.load(); await h.client.start();
  h.current.identity.source = 'browser-local-file';
  assert.equal(await h.client.tick(), false);
  assert.equal(h.client.running, false);
  assert.deepEqual(h.calls.map(x => x.url), ['/api/output/controller', '/api/output/start', '/api/output/stop']);
  assert.match(h.client.message, /金色/);
  assert.equal(h.timer.tasks.size, 0);
});

for (const [label, invalid] of [
  ['NaN', {...pose, ParamAngleY: NaN}], ['out of range', {...pose, ParamAngleX: 100}],
  ['extra image field', {...pose, image: 'never-upload'}], ['missing parameter', {ParamAngleX: 0}]
]) test('invalid source pose fails closed before publication: ' + label, async () => {
  const h = harness(); await h.client.load(); h.current.values = invalid;
  assert.equal(await h.client.start(), false); assert.equal(h.calls.length, 1);
});

test('duplicate start while starting cannot overlap requests', async () => {
  const gate = deferred();
  const h = harness({request: async url => url.endsWith('/controller') ? response({...configuration}) :
    url.endsWith('/start') ? gate.promise : response(state(false))});
  await h.client.load(); const first = h.client.start();
  assert.equal(await h.client.start(), false); assert.equal(h.calls.length, 2);
  gate.resolve(response(state())); assert.equal(await first, true);
  await h.client.stop();
});

test('frame publication permits only one in-flight request', async () => {
  const gate = deferred();
  const h = harness({request: async url => url.endsWith('/controller') ? response({...configuration}) :
    url.endsWith('/frame') ? gate.promise : response(state())});
  await h.client.load(); await h.client.start(); const first = h.client.tick();
  assert.equal(await h.client.tick(), false);
  assert.equal(h.calls.filter(x => x.url.endsWith('/frame')).length, 1);
  gate.resolve(response(state())); assert.equal(await first, true);
  await h.client.stop();
});

test('stop waits for in-flight frame, clears schedule and requires manual restart', async () => {
  const gate = deferred();
  const h = harness({request: async url => url.endsWith('/controller') ? response({...configuration}) :
    url.endsWith('/frame') ? gate.promise : response(state(!url.endsWith('/stop')))});
  await h.client.load(); await h.client.start(); const frame = h.client.tick();
  const stop = h.client.stop('窗口转到后台，已停止输出。');
  assert.equal(h.client.running, false);
  assert.equal(h.calls.some(x => x.url.endsWith('/stop')), false);
  gate.resolve(response(state())); await frame; await stop;
  assert.equal(h.calls.at(-1).url, '/api/output/stop');
  assert.equal(h.calls.at(-1).options.keepalive, true);
  assert.equal(h.timer.tasks.size, 0);
  assert.equal(await h.client.tick(), false);
  h.client.status(); assert.equal(h.client.running, false);
});

test('stop during pending start cannot reactivate after late acknowledgement', async () => {
  const gate = deferred();
  const h = harness({request: async url => url.endsWith('/controller') ? response({...configuration}) :
    url.endsWith('/start') ? gate.promise : response(state(false))});
  await h.client.load(); const start = h.client.start(); const stop = h.client.stop();
  gate.resolve(response(state())); await start; await stop;
  assert.equal(h.client.running, false);
  assert.equal(h.timer.tasks.size, 0);
  assert.equal(h.calls.at(-1).url, '/api/output/stop');
});

test('one-second stalled frame aborts, stops and does not auto-restart', async () => {
  const gate = deferred(); let signal;
  const h = harness({request: async (url, options) => {
    if (url.endsWith('/controller')) return response({...configuration});
    if (url.endsWith('/frame')) { signal = options.signal; return gate.promise; }
    return response(state(!url.endsWith('/stop')));
  }});
  await h.client.load(); await h.client.start(); const frame = h.client.tick();
  h.timer.fire(1000); assert.equal(await frame, false);
  assert.equal(signal.aborted, true); assert.equal(h.client.running, false);
  assert.match(h.client.message, /超过 1 秒/);
  assert.equal(h.timer.tasks.size, 0);
  gate.resolve(response(state()));
});

test('non-success HTTP response displays readable error and safely stops', async () => {
  const h = harness({request: async url => {
    if (url.endsWith('/controller')) return response({...configuration});
    if (url.endsWith('/frame')) return response({code: 'OWNER_CONFLICT', error: '另一个控制页正在输出。'}, false);
    return response(state(!url.endsWith('/stop')));
  }});
  await h.client.load(); await h.client.start(); assert.equal(await h.client.tick(), false);
  assert.match(h.client.message, /另一个控制页/); assert.equal(h.client.running, false);
});

test('failed stop reports uncertainty and the 1.5 second safety fallback', async () => {
  const h = harness({request: async url => {
    if (url.endsWith('/controller')) return response({...configuration});
    if (url.endsWith('/stop')) throw new Error('connection lost');
    return response(state());
  }});
  await h.client.load(); await h.client.start(); assert.equal(await h.client.stop(), false);
  assert.match(h.client.message, /未获确认/); assert.match(h.client.message, /1.5 秒/);
  assert.equal(h.client.running, false); assert.equal(h.timer.tasks.size, 0);
});

test('invalid acknowledgement cannot claim output is active', async () => {
  const h = harness({request: async url => response(url.endsWith('/controller') ? {...configuration} : state(false))});
  await h.client.load(); assert.equal(await h.client.start(), false);
  assert.equal(h.client.running, false); assert.match(h.client.message, /未确认/);
});

test('disposal aborts pending transport and clears all timers without restarting', async () => {
  const gate = deferred(); let signal;
  const h = harness({request: async (url, options) => {
    if (url.endsWith('/controller')) return response({...configuration});
    if (url.endsWith('/frame')) { signal = options.signal; return gate.promise; }
    return response(state(!url.endsWith('/stop')));
  }});
  await h.client.load(); await h.client.start(); const tick = h.client.tick();
  await h.client.dispose(); await tick;
  assert.equal(signal.aborted, true); assert.equal(h.client.disposed, true);
  assert.equal(h.client.running, false); assert.equal(h.timer.tasks.size, 0);
  assert.equal(await h.client.start(), false); gate.resolve(response(state()));
});

test('a timed-out previous lease frame cannot enter a newly started lease', async () => {
  const store = new OutputState(), late = deferred();
  let delayedBody;
  const h = harness({request: async (url, options) => {
    if (url.endsWith('/controller')) return response({...configuration});
    const body = JSON.parse(options.body);
    if (url.endsWith('/start')) return response(store.start(body.clientId, 0));
    if (url.endsWith('/stop')) return response(store.stop(body.clientId, 0));
    if (!delayedBody) { delayedBody = body; return late.promise; }
    return response(store.publish(body, 0));
  }});
  await h.client.load(); await h.client.start();
  const oldTick = h.client.tick(); h.timer.fire(1000); await oldTick;
  assert.equal(h.client.running, false); assert.equal(store.read(0).active, false);
  assert.equal(await h.client.start(), true);
  const starts = h.calls.filter(x => x.url.endsWith('/start'));
  assert.notEqual(starts[0].body.clientId, starts[1].body.clientId);
  assert.equal(h.calls.find(x => x.url.endsWith('/stop')).body.clientId, starts[0].body.clientId);
  h.current.values.ParamAngleX = -12;
  assert.equal(await h.client.tick(), true);
  const accepted = store.read(0);
  assert.throws(() => store.publish({...delayedBody, sequence: 999}, 0), /不是当前输出连接/);
  assert.deepEqual(store.read(0), accepted);
  late.resolve(response({code: 'OUTPUT_OWNER_CONFLICT', error: '旧连接已失效。'}, false));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.client.running, true);
  assert.equal(await h.client.tick(), true);
  assert.equal(store.read(0).values.ParamAngleX, -12);
  await h.client.stop();
  assert.equal(h.calls.at(-1).body.clientId, starts[1].body.clientId);
});

test('reused lease ID from an injected factory is rejected before a new start request', async () => {
  const h = harness({createClientId: () => 'fixed-test-lease'});
  await h.client.load(); await h.client.start(); await h.client.stop();
  assert.equal(await h.client.start(), false);
  assert.match(h.client.message, /新的连接标识/);
  assert.equal(h.calls.filter(x => x.url.endsWith('/start')).length, 1);
});

test('invalid configuration and load failure do not make controller ready', async () => {
  const h = harness({request: async () => response({...configuration, modelId: 'purple'})});
  assert.equal(await h.client.load(), false); assert.equal(h.client.snapshot().ready, false);
  assert.match(h.client.message, /金色模型/);
});

const outputSource = await readFile(new URL('../web/output-page.js', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../web/controller-client.js', import.meta.url), 'utf8');
const outputHtml = await readFile(new URL('../web/output.html', import.meta.url), 'utf8');
const outputCss = await readFile(new URL('../web/output.css', import.meta.url), 'utf8');
const controllerSource = await readFile(new URL('../web/controller.js', import.meta.url), 'utf8');

test('default browser timers are invoked without binding Window APIs to the controller', async () => {
  let serial = 0;
  const timers = new Map();
  const browserTimer = function (fn, ms) {
    if (this && typeof this.sourcePose === 'function') throw new TypeError('Illegal invocation');
    const id = ++serial; timers.set(id, {fn, ms}); return id;
  };
  const browserCancel = function (id) {
    if (this && typeof this.sourcePose === 'function') throw new TypeError('Illegal invocation');
    timers.delete(id);
  };
  const context = {MODEL_ID, STALE_MS, validatePose,
    validateClientId: id => id, AbortController, setTimeout: browserTimer, clearTimeout: browserCancel};
  const script = clientSource.replace(/^import .*;\r?\n/gm, '').replace('export class OutputController', 'class OutputController');
  vm.runInNewContext(script + '\nglobalThis.TestOutputController = OutputController;', context);
  const client = new context.TestOutputController({createClientId: () => 'browser-timer-lease',
    readSource: () => ({ready: true, identity: {name: configuration.modelName, source: configuration.modelPath}, values: pose}),
    request: async url => response(url.endsWith('/controller') ? {...configuration} : state(!url.endsWith('/stop')))});
  assert.equal(await client.load(), true);
  assert.equal(await client.start(), true);
  assert.equal(await client.tick(), true);
  assert.equal(await client.stop(), true);
  assert.equal(timers.size, 0);
});

test('output document uses only frozen renderer consumer and hidden supporting controls', () => {
  assert.match(outputHtml, /src="\/obs\/output-page\.js"/);
  assert.match(outputSource, /from '\/obs\/renderer\.js'/);
  assert.doesNotMatch(outputHtml + outputSource, /<video|tracking-app|getUserMedia|captureStream|toDataURL|toBlob|X-Output-Token|\/api\/output\/controller/);
  assert.match(outputHtml, /id="renderer-support" hidden inert aria-hidden="true"/);
  for (const id of ['canvas', 'stage', 'model-title', 'fps', 'parameters', 'status', 'stability', 'preset', 'choose-folder', 'folder', 'reset', 'zoom', 'zoom-value', 'reset-view', 'runtime-info', 'model-path']) assert.match(outputHtml, new RegExp(`id="${id}"`));
  assert.match(outputCss, /background:\s*transparent !important/);
  assert.match(outputCss, /#renderer-support\s*\{\s*display:\s*none !important/);
  assert.doesNotMatch(outputHtml + outputCss, /checker|linear-gradient|background-image/);
});

test('controller visibility and page exit are wired to explicit stop, not auto-resume', () => {
  assert.match(controllerSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(controllerSource, /if \(document\.hidden\) void client\.stop/);
  assert.match(controllerSource, /else client\.status\(\)/);
  assert.match(controllerSource, /addEventListener\('pagehide'.*client\.dispose/);
  assert.match(controllerSource, /url\.pathname !== '\/obs\/output'/);
  assert.match(controllerSource, /url\.search \|\| url\.hash/);
  assert.doesNotMatch(controllerSource, /getUserMedia|localStorage|sessionStorage|sendBeacon/);
});

// Evaluate only the project-owned consumer against a mock bridge and fake clock.
// No renderer, Cubism SDK, DOM browser, camera or network is loaded by these tests.
async function outputHarness({initial = state(), ready = true, error = false, request} = {}) {
  let now = 0, revision = initial;
  const events = {}, intervals = new Map(), timeouts = new Map(), requests = [], applied = [];
  let serial = 0, resets = 0, isReady = ready;
  const status = {classList: {contains: name => name === 'error' && error}}, note = {textContent: ''};
  const document = {title: '', getElementById: id => id === 'status' ? status : note};
  const context = {MODEL_ID, STALE_MS, validatePose, AbortController,
    previewBridge: {ready: () => isReady, apply: values => applied.push({...values}), reset: () => resets++},
    document, performance: {now: () => now},
    setInterval: (fn, ms) => { const id = ++serial; intervals.set(id, {fn, ms}); return id; }, clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = ++serial; timeouts.set(id, {fn, ms}); return id; }, clearTimeout: id => timeouts.delete(id),
    addEventListener: (name, fn) => { events[name] = fn; },
    fetch: async (url, options) => { requests.push({url, options}); return request ? request(url, options) : response(revision); }
  };
  const script = outputSource.replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(script, context, {filename: 'output-page.mock.js'});
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await flush();
  return {events, intervals, timeouts, requests, applied, document, flush,
    resets: () => resets, setState: value => { revision = value; }, setReady: value => { isReady = value; },
    async pulse(ms) { for (const {fn, ms: delay} of intervals.values()) if (delay === ms) fn(); await flush(); },
    advance: ms => { now += ms; }};
}

test('output consumer polls only read-only state and applies validated six numbers', async () => {
  const h = await outputHarness();
  assert.deepEqual(h.applied, [pose]); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/output/state');
  assert.equal(h.requests[0].options.method, 'GET');
  assert.equal(h.requests[0].options.headers, undefined);
  assert.match(h.document.title, /正在接收/);
  h.events.pagehide();
});

test('inactive and server-stale state reset the output pose', async () => {
  const h = await outputHarness({initial: state(false, DEFAULT_POSE)});
  assert.equal(h.resets(), 1); assert.equal(h.applied.length, 0);
  h.setState({...state(false, DEFAULT_POSE), stale: true}); await h.pulse(75);
  assert.equal(h.resets(), 2); assert.match(h.document.title, /过期/); h.events.pagehide();
});

test('consumer watchdog resets when last valid data is older than 1500 ms', async () => {
  const h = await outputHarness();
  h.advance(1500); await h.pulse(100); assert.equal(h.resets(), 0);
  h.advance(1); await h.pulse(100); assert.equal(h.resets(), 1);
  assert.match(h.document.title, /1.5 秒/); h.events.pagehide();
});

test('unready or failed renderer is never reported as loaded', async () => {
  const waiting = await outputHarness({ready: false});
  assert.equal(waiting.applied.length, 0); assert.match(waiting.document.title, /模型未就绪/);
  waiting.events.pagehide();
  const broken = await outputHarness({error: true}); assert.match(broken.document.title, /渲染错误/); broken.events.pagehide();
});

test('invalid consumer data cannot apply pose and leaves clear error state', async () => {
  const h = await outputHarness({initial: {...state(), values: {...pose, image: 'rejected'}}});
  assert.equal(h.applied.length, 0); assert.equal(h.resets(), 1);
  assert.match(h.document.title, /连接中断/); h.events.pagehide();
});

test('consumer has one in-flight GET and aborts it on page exit', async () => {
  const gate = deferred(); let signal;
  const h = await outputHarness({request: async (url, options) => { signal = options.signal; return gate.promise; }});
  await h.pulse(75); await h.pulse(75); assert.equal(h.requests.length, 1);
  h.events.pagehide(); assert.equal(signal.aborted, true); assert.equal(h.intervals.size, 0);
  gate.resolve(response(state())); await h.flush(); assert.equal(h.applied.length, 0); assert.equal(h.timeouts.size, 0);
});

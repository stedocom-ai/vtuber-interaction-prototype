import { CubismFramework, Option } from '/sdk/framework/live2dcubismframework.js';
import { CubismMoc } from '/sdk/framework/model/cubismmoc.js';
import { CubismRenderer_WebGL } from '/sdk/framework/rendering/cubismrenderer_webgl.js';
import { CubismShaderManager_WebGL } from '/sdk/framework/rendering/cubismshader_webgl.js';
import { CubismMatrix44 } from '/sdk/framework/math/cubismmatrix44.js';
import { modelReferences, validateMocHash, parameterMetadata, parameterValue, projection } from './contracts.js';

const $ = id => document.getElementById(id), canvas = $('canvas');
const metrics = { frames: 0, errors: [], contextLosses: 0, startedAt: performance.now(), maxFrameGapMs: 0, samples: [], pausedMs: 0 };
let gl, active = null, config, busy = false, dead = false, zoom = 1, lastFrame = 0, sampleAt = 0, sampleFrames = 0;
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function report(error) { const message = String(error?.message ?? error); metrics.errors.push(message); status(message, true); }
addEventListener('error', e => report(e.error ?? e.message));
addEventListener('unhandledrejection', e => report(e.reason));
canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); dead = true; metrics.contextLosses++; report(new Error('GRAPHICS_CONTEXT_LOST: 显卡上下文已丢失。请关闭预览窗口并重新打开本地地址；模型文件没有改变。')); });

// Count live GL objects for real-browser reload/stability checks, not estimated allocations.
const live = Object.fromEntries(['Texture', 'Buffer', 'Program', 'Shader', 'Framebuffer', 'Renderbuffer'].map(name => [name, new Set()]));
function instrumentGL(context) {
  for (const [name, objects] of Object.entries(live)) {
    const create = context['create' + name].bind(context), remove = context['delete' + name].bind(context);
    context['create' + name] = (...args) => { const object = create(...args); if (object) objects.add(object); return object; };
    context['delete' + name] = object => { objects.delete(object); return remove(object); };
  }
}
function resources() { return Object.fromEntries(Object.entries(live).map(([k, v]) => [k, v.size])); }
async function readResponse(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('FILE_READ: 无法读取模型文件：' + url); return r.arrayBuffer(); }
async function packageFromPreset(id) {
  const preset = config.presets.find(x => x.id === id); if (!preset) throw new Error('MODEL_NOT_FOUND: 没有这个模型。');
  const read = name => readResponse('/models/' + id + '/' + name.split('/').map(encodeURIComponent).join('/'));
  return preparePackage(preset.name, read, preset.path);
}
async function packageFromFiles(list) {
  const files = Array.from(list);
  if (!files.length || files.length > 256 || files.reduce((n, f) => n + f.size, 0) > 64 * 1024 * 1024) throw new Error('FOLDER_LIMIT: 请只选择模型的 model 文件夹（最多 256 个文件、64 MB）。');
  const candidates = files.filter(f => f.name.endsWith('.model3.json'));
  if (candidates.length !== 1) throw new Error('MODEL_NOT_UNIQUE: 文件夹内必须只有一个 model3.json；不要选择包含多个颜色的 runs 文件夹。');
  const source = candidates[0], root = source.webkitRelativePath.slice(0, -source.name.length);
  const map = new Map(files.map(f => [f.webkitRelativePath, f]));
  const read = name => { const file = map.get(root + name); if (!file) throw new Error('FILE_MISSING: 文件夹缺少 ' + name + '，请重新选择完整模型。'); return file.arrayBuffer(); };
  return preparePackage(source.name, read, source.webkitRelativePath + '（浏览器本地读取，不上传）');
}
async function preparePackage(name, read, source) {
  const jsonBytes = await read(name);
  if (jsonBytes.byteLength > 1024 * 1024) throw new Error('MODEL_TOO_LARGE: model3.json 过大。');
  let json; try { json = JSON.parse(new TextDecoder().decode(jsonBytes)); } catch { throw new Error('MODEL_JSON: model3.json 内容损坏或不是 JSON。'); }
  const refs = modelReferences(json), bytes = new Map();
  for (const ref of refs) { const data = await read(ref); if (data.byteLength > 16 * 1024 * 1024) throw new Error('FILE_TOO_LARGE: 模型引用文件过大。'); bytes.set(ref, data); }
  validateMocHash(await sha(bytes.get(json.FileReferences.Moc)));
  try { JSON.parse(new TextDecoder().decode(bytes.get(json.FileReferences.DisplayInfo))); } catch { throw new Error('CDI_JSON: cdi3.json 内容损坏。'); }
  return { name, source, json, bytes };
}
async function decodeTexture(bytes) {
  const sig = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  if ([137,80,78,71,13,10,26,10].some((x,i) => sig[i] !== x)) throw new Error('TEXTURE_INVALID: 纹理不是有效的 PNG。');
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  try {
    const img = new Image(); img.src = blobUrl; await img.decode();
    if (img.width !== 1024 || img.height !== 1024) throw new Error('TEXTURE_SIZE: reference-v1 的图集必须为 1024×1024。');
    return img;
  } finally { URL.revokeObjectURL(blobUrl); }
}
function release(item) {
  if (!item) return;
  item.renderer?.release();
  for (const texture of item.textures ?? []) gl.deleteTexture(texture);
  if (item.model) item.moc.deleteModel(item.model);
  item.moc?.release();
}
async function construct(pkg) {
  const item = { ...pkg, moc: null, model: null, renderer: null, textures: [] };
  try {
    const images = await Promise.all(pkg.json.FileReferences.Textures.map(name => decodeTexture(pkg.bytes.get(name))));
    item.moc = CubismMoc.create(pkg.bytes.get(pkg.json.FileReferences.Moc), true);
    if (!item.moc) throw new Error('MOC_LOAD: 官方 Core 无法读取模型。');
    item.model = item.moc.createModel(); if (!item.model) throw new Error('MODEL_LOAD: 官方模型实例创建失败。');
    item.params = parameterMetadata(item.model);
    item.values = Object.fromEntries(item.params.map(p => [p.id, p.default]));
    item.model.update();
    const all = Array.from({ length: item.model.getDrawableCount() }, (_, i) => Array.from(item.model.getDrawableVertices(i))).flat();
    const xs = all.filter((_, i) => i % 2 === 0), ys = all.filter((_, i) => i % 2);
    item.bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    item.renderer = new CubismRenderer_WebGL(); item.renderer.initialize(item.model); item.renderer.startUp(gl);
    item.renderer.setIsPremultipliedAlpha(true);
    for (const [index, img] of images.entries()) {
      const texture = gl.createTexture(); if (!texture) throw new Error('TEXTURE_ALLOC: 显存纹理创建失败。');
      item.textures.push(texture); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      item.renderer.bindTexture(index, texture);
    }
    item.renderer.loadShaders('/sdk/shaders/');
    const started = performance.now();
    while (!CubismShaderManager_WebGL.getInstance().getShader(gl)._isShaderLoaded) {
      if (performance.now() - started > 20000 || dead) throw new Error('SHADER_INIT: 官方着色器未能完成初始化，请检查 SDK 完整性。');
      await nextFrame();
    }
    const error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error('GL_INIT: 显卡初始化错误 ' + error);
    return item;
  } catch (error) { release(item); throw error; }
}
function controls() {
  $('parameters').replaceChildren();
  for (const p of active.params) {
    const row = document.createElement('div'); row.className = 'parameter';
    const top = document.createElement('div'); top.className = 'parameter-label';
    const label = document.createElement('label'); label.htmlFor = p.id; label.textContent = p.label;
    const id = document.createElement('small'); id.textContent = p.id; label.append(id);
    const output = document.createElement('output'); output.id = p.id + '-value'; output.textContent = String(p.default);
    const range = document.createElement('input'); range.type = 'range'; range.id = p.id; range.min = p.min; range.max = p.max;
    range.step = (p.max - p.min) / 200; range.value = p.default;
    range.addEventListener('input', () => { try { setParameter(p.id, range.value); } catch (error) { report(error); } });
    top.append(label, output); row.append(top, range); $('parameters').append(row);
  }
}
function setParameter(id, value) {
  const p = active.params.find(x => x.id === id); if (!p) throw new Error('PARAMETER_MISSING: ' + id);
  active.values[id] = parameterValue(p, value); $(id).value = active.values[id]; $(id + '-value').textContent = Number(active.values[id].toFixed(3));
}
function reset() { if (active) for (const p of active.params) setParameter(p.id, p.default); }
function setZoom(value) { const n = Number(value); if (!(n >= .5 && n <= 2)) throw new Error('ZOOM_INVALID'); zoom = n; $('zoom').value = n; $('zoom-value').textContent = Math.round(n * 100) + '%'; }
async function load(loader) {
  if (busy || dead) return false;
  busy = true; $('preset').disabled = true; $('choose-folder').disabled = true; $('reset').disabled = true;
  const old = active;
  status('正在检查模型并创建官方渲染实例…');
  try {
    const pkg = await loader(); const candidate = await construct(pkg);
    active = candidate; release(old); controls(); setZoom(1);
    $('model-title').textContent = pkg.name.replace('.model3.json', ''); $('model-path').textContent = pkg.source;
    status('模型已加载。拖动右侧滑块检查动作，或缩放查看衣服边缘。'); return true;
  } catch (error) { status(String(error.message) + (old ? ' 当前模型保持不变。' : ''), true); return false; }
  finally { busy = false; $('preset').disabled = false; $('choose-folder').disabled = false; $('reset').disabled = !active; }
}
function render() {
  if (!active || dead) return;
  const rect = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio, 2);
  const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  for (const p of active.params) active.model.setParameterValueByIndex(p.index, active.values[p.id]);
  active.model.update();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  const matrix = new CubismMatrix44(); matrix.setMatrix(projection(active.bounds, width, height, zoom));
  active.renderer.setMvpMatrix(matrix); active.renderer.setRenderState(null, [0, 0, width, height]); active.renderer.drawModel('/sdk/shaders/');
}
function frame(now) {
  if (dead) return;
  try {
    if (!document.hidden) {
      render(); if (active) metrics.frames++;
      if (lastFrame) metrics.maxFrameGapMs = Math.max(metrics.maxFrameGapMs, now - lastFrame);
      lastFrame = now;
    } else { if (lastFrame) metrics.pausedMs += now - lastFrame; lastFrame = 0; }
    if (now - sampleAt >= 1000) {
      const fps = (metrics.frames - sampleFrames) * 1000 / (now - sampleAt);
      $('fps').textContent = fps.toFixed(0) + ' FPS';
      if (active) metrics.samples.push({ atMs: now, frames: metrics.frames, fps, hidden: document.hidden, resources: resources(), heapBytes: performance.memory?.usedJSHeapSize ?? null });
      if (metrics.samples.length > 4000) metrics.samples.shift();
      sampleAt = now; sampleFrames = metrics.frames;
      const error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error('GL_RENDER: 显卡渲染错误 ' + error);
    }
  } catch (error) { dead = true; report(error); return; }
  requestAnimationFrame(frame);
}
function pixels() { render(); const data = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data); return data; }
async function initialize() {
  config = await (await fetch('/api/config', { cache: 'no-store' })).json();
  const deadline = performance.now() + 15000;
  while (true) {
    try { if (globalThis.Live2DCubismCore?.Version.csmGetVersion() > 0) break; } catch { /* official async WASM initialization */ }
    if (performance.now() > deadline) throw new Error('CORE_INIT: 官方 Core 初始化失败；请检查本机 SDK。'); await nextFrame();
  }
  const opt = new Option(); opt.logFunction = message => console.info('[Cubism]', message);
  if (!CubismFramework.startUp(opt)) throw new Error('FRAMEWORK_START'); CubismFramework.initialize();
  gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WEBGL_UNAVAILABLE: 当前浏览器无法创建 WebGL，请使用支持硬件加速的 Chrome 或 Edge。');
  instrumentGL(gl);
  const version = Live2DCubismCore.Version.csmGetVersion();
  $('runtime-info').textContent = `SDK ${config.sdkVersion} · Core ${version >>> 24}.${(version >>> 16) & 255}.${version & 65535} · WebGL / Alpha。SDK：${config.sdkRoot}`;
  for (const preset of config.presets) { const option = document.createElement('option'); option.value = preset.id; option.textContent = preset.label; $('preset').append(option); }
  $('preset').addEventListener('change', () => load(() => packageFromPreset($('preset').value)));
  $('choose-folder').addEventListener('click', () => $('folder').click());
  $('folder').addEventListener('change', async () => { if ($('folder').files.length) await load(() => packageFromFiles($('folder').files)); $('folder').value = ''; });
  $('reset').addEventListener('click', reset); $('zoom').addEventListener('input', () => setZoom($('zoom').value)); $('reset-view').addEventListener('click', () => setZoom(1));
  requestAnimationFrame(frame);
  if (!await load(() => packageFromPreset('gold'))) throw new Error('INITIAL_MODEL_FAILED: 默认金色模型没有加载。');
  addEventListener('pagehide', () => { dead = true; release(active); active = null; CubismShaderManager_WebGL.deleteInstance(); CubismFramework.dispose(); });
  // Test interface exists only in an explicitly requested local verification session.
  if (config.verification) {
    const api = { config, metrics, gl, canvas, resources, pixels, render, reset, setZoom, setParameter,
      active: () => active, load, preparePackage, packageFromFiles, packageFromPreset, nextFrame, sha, status };
    const { runSelftest } = await import('./selftest.js'); await runSelftest(api);
  }
}
initialize().catch(report);

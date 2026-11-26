import {previewBridge} from '/obs/renderer.js';
import {MODEL_ID, STALE_MS, validatePose} from './protocol.js';

// Read-only consumer. No controller token, POST, video, camera, or microphone access.
let disposed = false, pending = null, lastGood = null, reason = '等待本地输出状态';
const note = document.getElementById('output-state');
function describe(text) {
  reason = text;
  const renderError = document.getElementById('status').classList.contains('error');
  const message = renderError ? '模型渲染错误，请检查控制页及本地服务' :
    (!previewBridge.ready() ? `模型未就绪 · ${text}` : text);
  note.textContent = message;
  document.title = `纯角色输出 · ${message}`;
}
function reset(text) { previewBridge.reset(); describe(text); }
async function poll() {
  if (disposed || pending) return;
  const controller = new AbortController();
  pending = controller;
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch('/api/output/state', {method: 'GET', cache: 'no-store', signal: controller.signal});
    if (!response.ok) throw new Error('状态读取失败');
    const state = await response.json();
    if (disposed) return;
    if (!state || state.modelId !== MODEL_ID || typeof state.active !== 'boolean' ||
        typeof state.stale !== 'boolean' || !Number.isSafeInteger(state.revision) || state.revision < 0) {
      throw new Error('状态数据无效');
    }
    const values = validatePose(state.values);
    lastGood = performance.now();
    if (!state.active || state.stale) reset(state.stale ? '数据已过期，默认姿势' : '输出未开始，默认姿势');
    else {
      if (previewBridge.ready()) previewBridge.apply(values);
      describe('正在接收动作数值');
    }
  } catch {
    if (!disposed) {
      if (lastGood === null || performance.now() - lastGood > STALE_MS) reset('连接中断，默认姿势');
      else describe('连接暂时中断，等待恢复');
    }
  } finally {
    clearTimeout(timeout);
    if (pending === controller) pending = null;
  }
}
const polling = setInterval(() => void poll(), 75);
const watchdog = setInterval(() => {
  if (lastGood !== null && performance.now() - lastGood > STALE_MS) reset('连接中断超过 1.5 秒，默认姿势');
  else describe(reason);
}, 100);
function dispose() {
  disposed = true;
  clearInterval(polling);
  clearInterval(watchdog);
  pending?.abort();
  pending = null;
}
addEventListener('pagehide', dispose, {once: true});
describe(reason);
void poll();

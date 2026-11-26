import {MODEL_ID, STALE_MS, validateClientId, validatePose} from './protocol.js';

// Transport only: no DOM, SDK, camera, image data, or persistent storage.
export class OutputController {
  constructor({request = (...args) => fetch(...args), readSource, onStatus = () => {},
    createClientId = () => globalThis.crypto.randomUUID(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id),
    intervalMs = 50, timeoutMs = 1000} = {}) {
    Object.assign(this, {request, readSource, onStatus, createClientId, schedule, cancel, intervalMs, timeoutMs});
    this.clientId = null;
    this.config = null;
    this.running = false;
    this.starting = false;
    this.stopping = false;
    this.disposed = false;
    this.sequence = 0;
    this.generation = 0;
    this.timer = null;
    this.inFlight = null;
    this.abortController = null;
    this.stopPromise = null;
    this.message = '输出未开始。不会自动开启摄像头。';
  }

  snapshot() {
    return {ready: !!this.config && !this.disposed, running: this.running,
      busy: this.starting || this.stopping || (!this.config && !!this.inFlight),
      message: this.message, config: this.config ? {...this.config} : null};
  }

  status(message = this.message) {
    this.message = message;
    this.onStatus(this.snapshot());
  }

  async call(path, body, {keepalive = false} = {}) {
    if (this.inFlight) throw new Error('OUTPUT_BUSY: 上一次输出请求尚未结束。');
    const controller = new AbortController();
    this.abortController = controller;
    let timeout;
    const work = (async () => {
      const response = await this.request(path, {
        method: body ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal,
        ...(body ? {headers: {'Content-Type': 'application/json', 'X-Output-Token': this.config.token},
          body: JSON.stringify(body), keepalive} : {})
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('OUTPUT_RESPONSE: 本地服务返回了无法识别的响应。'); }
      if (!response.ok) throw new Error(`${data.code ?? 'OUTPUT_REQUEST'}: ${data.error ?? '输出请求失败。'}`);
      return data;
    })();
    const deadline = new Promise((_, reject) => {
      timeout = this.schedule(() => {
        reject(new Error('OUTPUT_TIMEOUT: 本地输出请求超过 1 秒，已停止发布。'));
        controller.abort();
      }, this.timeoutMs);
      controller.signal.addEventListener('abort', () => reject(new Error('OUTPUT_ABORTED: 输出请求已取消。')), {once: true});
    });
    const pending = Promise.race([work, deadline]);
    this.inFlight = pending;
    try { return await pending; }
    finally {
      this.cancel(timeout);
      if (this.inFlight === pending) this.inFlight = null;
      if (this.abortController === controller) this.abortController = null;
    }
  }

  async load() {
    if (this.disposed || this.running || this.starting || this.stopping || this.inFlight) return false;
    this.status('正在读取本机输出配置…');
    try {
      const data = await this.call('/api/output/controller');
      if (this.disposed) return false;
      if (!data || data.modelId !== MODEL_ID || data.staleMs !== STALE_MS ||
          typeof data.token !== 'string' || !data.token ||
          typeof data.modelName !== 'string' || !data.modelName ||
          typeof data.modelPath !== 'string' || !data.modelPath ||
          typeof data.outputUrl !== 'string' || !data.outputUrl) {
        throw new Error('OUTPUT_CONFIG: 输出配置不完整或不是本轮金色模型。');
      }
      this.config = {...data};
      this.status('输出未开始。点击“开始输出”后才发布六个动作数值；不会自动开启摄像头。');
      return true;
    } catch (error) {
      if (!this.disposed) this.status(`无法准备输出：${error.message}`);
      return false;
    }
  }

  sourcePose() {
    const source = this.readSource?.();
    if (!source?.ready) throw new Error('OUTPUT_NOT_READY: 角色尚未就绪，请等待加载后再开始。');
    if (source.identity?.name !== this.config.modelName || source.identity?.source !== this.config.modelPath) {
      throw new Error('OUTPUT_MODEL_MISMATCH: 本轮只支持已验证的金色预设。请选回金色模型，再手动开始输出。');
    }
    return validatePose(source.values);
  }

  async start() {
    if (this.disposed || this.running || this.starting || this.stopping || this.inFlight) return false;
    if (!this.config) { this.status('输出配置尚未就绪，请刷新控制页后重试。'); return false; }
    let clientId;
    try {
      this.sourcePose();
      clientId = validateClientId(this.createClientId());
      if (clientId === this.clientId) throw new Error('OUTPUT_LEASE_REUSED: 每次开始输出必须使用新的连接标识。');
    }
    catch (error) { this.status(error.message); return false; }
    // A fresh lease prevents a timed-out old HTTP frame from entering a later run.
    this.clientId = clientId;
    const generation = ++this.generation;
    this.starting = true;
    this.status('正在开始输出…');
    try {
      const result = await this.call('/api/output/start', {clientId});
      if (this.disposed || generation !== this.generation) return false;
      if (result.active !== true || result.stale !== false || result.modelId !== MODEL_ID) {
        throw new Error('OUTPUT_START_REJECTED: 服务端未确认开始输出。');
      }
      this.sourcePose();
      this.sequence = 0;
      this.running = true;
      this.status('正在输出六个动作数值。请保持此控制页在前台；输出页不采集摄像头。');
      this.queue();
      return true;
    } catch (error) {
      if (!this.disposed && generation === this.generation) await this.stop(`开始输出失败：${error.message}`);
      return false;
    } finally {
      this.starting = false;
      this.status();
    }
  }

  queue() {
    if (!this.running || this.disposed || this.timer !== null) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.tick();
    }, this.intervalMs);
  }

  async tick() {
    if (!this.running || this.disposed || this.inFlight) return false;
    const generation = this.generation, clientId = this.clientId;
    try {
      const values = this.sourcePose();
      const result = await this.call('/api/output/frame', {
        clientId, sequence: this.sequence++, modelId: MODEL_ID, values
      });
      if (generation !== this.generation || !this.running) return false;
      if (result.active !== true || result.stale !== false || result.modelId !== MODEL_ID) {
        throw new Error('OUTPUT_INACTIVE: 服务端输出已停止，请手动重新开始。');
      }
      return true;
    } catch (error) {
      if (generation === this.generation && !this.disposed) await this.stop(`输出已停止：${error.message}`);
      return false;
    } finally { this.queue(); }
  }

  stop(message = '输出已停止。输出页将回到默认姿势；再次输出需手动开始。', {abort = false} = {}) {
    this.running = false;
    ++this.generation;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (abort) this.abortController?.abort();
    if (this.stopPromise) return this.stopPromise;
    const clientId = this.clientId;
    if (!this.config || !clientId) { this.status(message); return Promise.resolve(false); }
    this.stopping = true;
    this.status(message);
    const pendingRequest = this.inFlight;
    const finish = (async () => {
      if (pendingRequest) { try { await pendingRequest; } catch { /* stop still needs sending */ } }
      try {
        await this.call('/api/output/stop', {clientId}, {keepalive: true});
        return true;
      } catch (error) {
        this.message = `${message} 停止请求未获确认：${error.message} 无新数据超过 1.5 秒后，输出页会回默认姿势。`;
        return false;
      }
    })();
    this.stopPromise = finish;
    return finish.finally(() => {
      this.stopping = false;
      this.stopPromise = null;
      this.status();
    });
  }

  dispose() {
    if (this.disposed) return this.stopPromise ?? Promise.resolve(false);
    this.disposed = true;
    return this.stop('控制页已关闭，输出已停止。', {abort: true});
  }
}

import {DEFAULT_POSE, MODEL_ID, STALE_MS, validateClientId, validatePose} from '../web/protocol.js';

type Pose = Record<keyof typeof DEFAULT_POSE, number>;

export interface PublicOutputState {
  active: boolean;
  stale: boolean;
  revision: number;
  modelId: typeof MODEL_ID;
  values: Pose;
}

export class OutputError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'OutputError';
    this.status = status;
    this.code = code;
  }
}

function client(value: unknown): string {
  try { return validateClientId(value); }
  catch (error) { throw new OutputError(400, 'CLIENT_ID_INVALID', (error as Error).message); }
}

function timestamp(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new OutputError(400, 'OUTPUT_TIME_INVALID', '输出时间必须是非负的有限数值。');
  }
  return value;
}

function frame(value: unknown): {clientId: string; sequence: number; modelId: typeof MODEL_ID; values: Pose} {
  const fields = ['clientId', 'sequence', 'modelId', 'values'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== fields.length ||
      !fields.every(key => Object.hasOwn(value, key))) {
    throw new OutputError(400, 'PUBLISH_INVALID', '输出帧必须且只能包含连接标识、序号、模型和六参数。');
  }
  const input = value as Record<string, unknown>;
  const {clientId: rawClientId, sequence, modelId, values: rawValues} = input;
  const clientId = client(rawClientId);
  if (modelId !== MODEL_ID) {
    throw new OutputError(400, 'MODEL_UNSUPPORTED', '本轮只允许金色 reference-v1 模型。');
  }
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new OutputError(400, 'SEQUENCE_INVALID', '输出序号必须是从 0 开始的非负安全整数。');
  }
  let values: Pose;
  try { values = validatePose(rawValues); }
  catch (error) { throw new OutputError(400, 'POSE_INVALID', (error as Error).message); }
  return {clientId, sequence, modelId: MODEL_ID, values};
}

/** One publisher lease and one latest pose; no filesystem, media, or history. */
export class OutputState {
  #owner: string | null = null;
  #updatedAt: number | null = null;
  #sequence = -1;
  #revision = 0;
  #stale = false;
  #values: Pose = {...DEFAULT_POSE};

  #expired(now: number): boolean {
    return this.#owner !== null && this.#updatedAt !== null && now - this.#updatedAt > STALE_MS;
  }

  #snapshot(): PublicOutputState {
    return {active: this.#owner !== null, stale: this.#stale, revision: this.#revision,
      modelId: MODEL_ID, values: {...this.#values}};
  }

  #clear(stale: boolean): void {
    this.#owner = null;
    this.#updatedAt = null;
    this.#sequence = -1;
    this.#stale = stale;
    this.#values = {...DEFAULT_POSE};
    this.#revision++;
  }

  start(clientId: unknown, now = Date.now()): PublicOutputState {
    const id = client(clientId);
    timestamp(now);
    if (this.#owner !== null && !this.#expired(now)) {
      if (this.#owner !== id) throw new OutputError(409, 'OUTPUT_OWNER_CONFLICT', '另一个窗口正在输出，请先停止它或等待连接超时。');
      // A repeated start is not a heartbeat and cannot reset sequence ordering.
      return this.#snapshot();
    }
    this.#owner = id;
    this.#updatedAt = now;
    this.#sequence = -1;
    this.#stale = false;
    this.#values = {...DEFAULT_POSE};
    this.#revision++;
    return this.#snapshot();
  }

  publish(value: unknown, now = Date.now()): PublicOutputState {
    const input = frame(value);
    timestamp(now);
    // Validate before any mutation, including expiry cleanup.
    if (this.#owner === null || this.#expired(now)) {
      throw new OutputError(409, 'OUTPUT_NOT_ACTIVE', '输出连接尚未开启或已经超时，请重新开启画面输出。');
    }
    if (this.#owner !== input.clientId) {
      throw new OutputError(409, 'OUTPUT_OWNER_CONFLICT', '此窗口不是当前输出连接，不能发送参数。');
    }
    if (input.sequence <= this.#sequence) {
      throw new OutputError(409, 'SEQUENCE_INVALID', '输出序号必须严格递增，重复或迟到的帧不会覆盖当前姿势。');
    }
    this.#values = input.values;
    this.#sequence = input.sequence;
    this.#updatedAt = now;
    this.#stale = false;
    this.#revision++;
    return this.#snapshot();
  }

  stop(clientId: unknown, now = Date.now()): PublicOutputState {
    const id = client(clientId);
    timestamp(now);
    if (this.#owner !== null && this.#owner !== id && !this.#expired(now)) {
      throw new OutputError(409, 'OUTPUT_OWNER_CONFLICT', '此窗口不是当前输出连接，不能停止另一个窗口。');
    }
    if (this.#owner !== null || this.#stale) this.#clear(false);
    return this.#snapshot();
  }

  read(now = Date.now()): PublicOutputState {
    timestamp(now);
    if (this.#expired(now)) this.#clear(true);
    return this.#snapshot();
  }
}

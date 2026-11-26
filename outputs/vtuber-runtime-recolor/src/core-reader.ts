import path from 'node:path';
import vm from 'node:vm';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { sha256 } from '../../vtuber-controlled-recolor/src/pixels.ts';
import { fingerprint, within } from '../../vtuber-controlled-recolor/src/files.ts';

export interface Drawable {
  index: number; id: string; partIndex: number; partId: string | null; textureIndex: number;
  vertexUvs: number[]; vertexPositions: number[]; triangleIndices: number[];
  renderOrder: number; drawOrder: number; opacity: number; constantFlags: number; dynamicFlags: number;
  blendMode: number; masks: number[]; multiplyColor: number[]; screenColor: number[];
}
export interface Inventory {
  schemaVersion: string; mocSha256: string; mocFormatVersion: number; mocConsistency: boolean;
  coreVersion: string; coreVersionNumber: number;
  canvas: { width: number; height: number; originX: number; originY: number; pixelsPerUnit: number };
  parameters: { id: string; min: number; max: number; default: number; value: number }[];
  parts: { index: number; id: string; parentIndex: number; opacity: number }[];
  offscreenCount: number; drawables: Drawable[];
}
export async function resolveSdk(supplied: string, projectRoot: string) {
  const outer = await realpath(supplied);
  const candidates = [outer, ...(await readdir(outer, { withFileTypes: true })).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => path.join(outer, e.name))];
  const found: string[] = [];
  for (const dir of candidates) try { await realpath(path.join(dir, 'Core/live2dcubismcore.js')); found.push(dir); } catch { /* not an SDK root */ }
  if (found.length !== 1) throw new Error('SDK_NOT_UNIQUE: SDK 根目录必须唯一');
  const root = found[0]!;
  if (within(projectRoot, root) || within(root, projectRoot)) throw new Error('SDK_MUST_BE_EXTERNAL: SDK 必须位于项目之外');
  const names = ['README.md', 'LICENSE.md', 'NOTICE.md', 'CHANGELOG.md', 'Core/README.md', 'Core/LICENSE.md', 'Core/CHANGELOG.md', 'Core/live2dcubismcore.js'];
  const files = [];
  for (const name of names) files.push({ relativePath: name, ...await fingerprint(path.join(root, name)) });
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const sdkVersion = /^## \[([^\]]+)\]/m.exec(changelog)?.[1];
  if (!sdkVersion || /beta|alpha|rc/i.test(sdkVersion)) throw new Error('SDK_NOT_STABLE: 未识别正式 SDK 版本');
  return { root, sdkVersion, corePath: path.join(root, 'Core/live2dcubismcore.js'), files, mode: 'external-read-only-no-copy' };
}
/** Execute the external official library in memory. No require, fs, network or disk cache is exposed. */
export async function createCoreReader(corePath: string) {
  const logs: string[] = [];
  const context = vm.createContext({ console: { log: (...a: unknown[]) => logs.push(a.join(' ')), warn: (...a: unknown[]) => logs.push(a.join(' ')), error: (...a: unknown[]) => logs.push(a.join(' ')) },
    setTimeout, clearTimeout, TextDecoder, TextEncoder, Buffer });
  const source = await readFile(corePath, 'utf8');
  new vm.Script(source, { filename: corePath }).runInContext(context, { timeout: 10000 });
  // Core initializes asynchronously even for this self-contained JS build.
  let ready = false;
  for (let i = 0; i < 100; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    try { if (context.Live2DCubismCore.Version.csmGetVersion() > 0) { ready = true; break; } } catch { /* wait for initialization */ }
  }
  if (!ready) throw new Error('CORE_INIT_FAILED: 官方 Core 初始化失败');
  // Dynamic external API object: SDK declarations are intentionally not copied into this project.
  const core = context.Live2DCubismCore;
  const versionNumber: number = core.Version.csmGetVersion();
  const version = `${String(versionNumber >>> 24).padStart(2, '0')}.${String((versionNumber >>> 16) & 255).padStart(2, '0')}.${String(versionNumber & 65535).padStart(4, '0')}`;
  function extract(bytes: Uint8Array, overrides: Record<string, number> = {}): Inventory {
    const copy = Uint8Array.from(bytes).buffer, moc = core.Moc.fromArrayBuffer(copy);
    if (!moc) throw new Error('MOC_LOAD_FAILED');
    let model: any;
    try {
      const consistent = moc.hasMocConsistency(Uint8Array.from(bytes).buffer) === 1;
      if (!consistent) throw new Error('MOC_INCONSISTENT');
      model = core.Model.fromMoc(moc); if (!model) throw new Error('MODEL_LOAD_FAILED');
      for (const [id, value] of Object.entries(overrides)) {
        const i = model.parameters.ids.indexOf(id);
        if (i < 0 || !Number.isFinite(value) || value < model.parameters.minimumValues[i] || value > model.parameters.maximumValues[i]) throw new Error('PARAMETER_OVERRIDE_INVALID: ' + id);
        model.parameters.values[i] = value;
      }
      model.update();
      const d = model.drawables, p = model.parts, c = model.canvasinfo, parameters = model.parameters, orders = model.getRenderOrders();
      if (!Number.isInteger(d.count) || d.count < 1 || d.count > 256) throw new Error('DRAWABLE_COUNT_UNSUPPORTED');
      return {
        schemaVersion: '1.0.0', mocSha256: sha256(bytes), mocFormatVersion: core.Version.csmGetMocVersion(Uint8Array.from(bytes).buffer), mocConsistency: consistent,
        coreVersion: version, coreVersionNumber: versionNumber,
        canvas: { width: c.CanvasWidth, height: c.CanvasHeight, originX: c.CanvasOriginX, originY: c.CanvasOriginY, pixelsPerUnit: c.PixelsPerUnit },
        parameters: Array.from(parameters.ids, (id: string, i: number) => ({ id, min: parameters.minimumValues[i], max: parameters.maximumValues[i], default: parameters.defaultValues[i], value: parameters.values[i] })),
        parts: Array.from(p.ids, (id: string, i: number) => ({ index: i, id, parentIndex: p.parentIndices[i], opacity: p.opacities[i] })),
        offscreenCount: model.offscreens.count,
        drawables: Array.from(d.ids, (id: string, i: number) => ({ index: i, id, partIndex: d.parentPartIndices[i], partId: d.parentPartIndices[i] === -1 ? null : p.ids[d.parentPartIndices[i]],
          textureIndex: d.textureIndices[i], vertexUvs: Array.from(d.vertexUvs[i]), vertexPositions: Array.from(d.vertexPositions[i]), triangleIndices: Array.from(d.indices[i]),
          renderOrder: orders[i], drawOrder: d.drawOrders[i], opacity: d.opacities[i], constantFlags: d.constantFlags[i], dynamicFlags: d.dynamicFlags[i], blendMode: d.blendModes[i],
          masks: Array.from(d.masks[i]), multiplyColor: Array.from(d.multiplyColors.slice(i * 4, i * 4 + 4)), screenColor: Array.from(d.screenColors.slice(i * 4, i * 4 + 4)) })),
      };
    } finally { model?.release(); moc._release(); }
  }
  return { extract, version, versionNumber, logs };
}

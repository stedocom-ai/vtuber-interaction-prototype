import path from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { fingerprint, readJson, safeFile, safeRelative } from '../../vtuber-controlled-recolor/src/files.ts';

export interface Reference { field: string; path: string; textureIndex?: number }
export function collectReferences(value: unknown): Reference[] {
  const model = value as { Version?: number; FileReferences?: Record<string, unknown> };
  if (!model || model.Version !== 3 || !model.FileReferences || typeof model.FileReferences !== 'object' || Array.isArray(model.FileReferences)) throw new Error('MODEL3_INVALID: 缺少 Version 3 或 FileReferences');
  const f = model.FileReferences, out: Reference[] = [];
  const add = (field: string, name: unknown, index?: number) => {
    const relative = safeRelative(name);
    out.push({ field, path: relative, ...(index === undefined ? {} : { textureIndex: index }) });
  };
  add('Moc', f.Moc);
  if (!Array.isArray(f.Textures) || !f.Textures.length) throw new Error('TEXTURES_MISSING: FileReferences.Textures 为空');
  f.Textures.forEach((name, i) => add(`Textures[${i}]`, name, i));
  for (const key of Object.keys(f)) {
    if (key === 'Moc' || key === 'Textures') continue;
    if (['DisplayInfo', 'Physics', 'Pose', 'UserData'].includes(key)) { add(key, f[key]); continue; }
    if (key === 'Expressions') {
      if (!Array.isArray(f[key])) throw new Error('REFERENCES_INVALID: Expressions 不是数组');
      (f[key] as Record<string, unknown>[]).forEach((e, i) => {
        if (!e || Object.keys(e).some(k => !['Name', 'File'].includes(k))) throw new Error('REFERENCES_INVALID: Expression 包含未知字段');
        add(`Expressions[${i}].File`, e.File);
      });
      continue;
    }
    if (key === 'Motions') {
      if (!f[key] || typeof f[key] !== 'object' || Array.isArray(f[key])) throw new Error('REFERENCES_INVALID: Motions 不是对象');
      for (const [group, entries] of Object.entries(f[key] as Record<string, unknown>)) {
        if (!Array.isArray(entries)) throw new Error('REFERENCES_INVALID: Motion 组不是数组');
        entries.forEach((e: Record<string, unknown>, i) => {
          if (!e || Object.keys(e).some(k => !['File', 'Sound', 'FadeInTime', 'FadeOutTime'].includes(k))) throw new Error('REFERENCES_INVALID: Motion 包含未知字段');
          add(`Motions.${group}[${i}].File`, e.File);
          if (e.Sound !== undefined) add(`Motions.${group}[${i}].Sound`, e.Sound);
        });
      }
      continue;
    }
    throw new Error('UNKNOWN_FILE_REFERENCE: 未识别的文件引用 ' + key);
  }
  if (out.some(r => r.path.toLowerCase().endsWith('.vtube.json'))) throw new Error('LEGACY_VTS_REFERENCE: 模型不能引用旧 .vtube.json');
  return out;
}
export async function findModel(runtimeRoot: string): Promise<string> {
  const root = await realpath(runtimeRoot);
  const entries = (await readdir(root, { withFileTypes: true })).filter(e => e.isFile() && e.name.toLowerCase().endsWith('.model3.json'));
  if (entries.length !== 1) throw new Error('MODEL3_NOT_UNIQUE: 运行时目录必须恰好有一个 model3.json，当前 ' + entries.length);
  return safeFile(root, entries[0]!.name);
}
export async function inspectReferences(modelPath: string) {
  const model = await readJson(modelPath), root = path.dirname(await realpath(modelPath));
  const records = [];
  for (const ref of collectReferences(model)) {
    try { records.push({ ...ref, ...(await fingerprint(await safeFile(root, ref.path))), relativePath: ref.path, exists: true }); }
    catch (error) { throw new Error('REFERENCED_FILE_MISSING_OR_UNSAFE: ' + ref.field + ' -> ' + ref.path, { cause: error }); }
  }
  return { root, records };
}
export function requireVerifiedOwnership(evidence: unknown): never {
  // Do not accept guessed rectangles, color selections, or unaudited JSON as ownership proof.
  // The official Core adapter and its UV/sampling-footprint validation are not implemented yet.
  throw new Error(evidence == null
    ? 'RUNTIME_OWNERSHIP_UNVERIFIED: 尚无经过验证的 Outfit 网格 / UV / 纹理采样范围，禁止生成蒙版或修改纹理'
    : 'OWNERSHIP_ADAPTER_UNAVAILABLE: 证据尚未经过官方 Core 解析与交叉验证，不能仅凭配置宣称通过');
}

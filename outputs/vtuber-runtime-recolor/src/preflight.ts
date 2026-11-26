import path from 'node:path';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { alphaInfo, checkerboard, decodePng, encodePng, sha256 } from '../../vtuber-controlled-recolor/src/pixels.ts';
import { fingerprint, readJson, readLimited, safeFile, save, saveJson, snapshot } from '../../vtuber-controlled-recolor/src/files.ts';
import { parseColor } from '../../vtuber-controlled-recolor/src/recolor.ts';
import { loadManifest } from '../../vtuber-controlled-recolor/src/manifest.ts';
import { findModel, inspectReferences, requireVerifiedOwnership } from './references.ts';

export const moduleRoot = fileURLToPath(new URL('../', import.meta.url));
export async function preflight() {
  const configPath = path.join(moduleRoot, 'config/reference.json');
  const config = await readJson(configPath) as {
    originalRoot: string; runtimeDirectory: string; frozenSnapshot: string; normalizedManifest: string;
    protectedPaths: string[]; layerId: string; expectedLayerName: string; originalColor: string; newColor: string;
  };
  const base = path.dirname(configPath), originalRoot = await realpath(config.originalRoot), runtimeRoot = await realpath(path.join(originalRoot, config.runtimeDirectory));
  const lockPath = await realpath(path.resolve(base, config.frozenSnapshot));
  const lock = await readJson(lockPath) as { schemaVersion: string; files: { path: string; sha256: string; bytes: number }[] };
  if (lock.schemaVersion !== '1.0.0' || !Array.isArray(lock.files) || !lock.files.length) throw new Error('SNAPSHOT_INVALID');
  const protectedRoots = [originalRoot, configPath, lockPath, ...await Promise.all(config.protectedPaths.map(p => realpath(path.resolve(base, p))))];
  const before = await snapshot(protectedRoots), frozenOriginals = [];
  for (const record of lock.files) {
    const actual = await fingerprint(await safeFile(originalRoot, record.path));
    if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) throw new Error('FROZEN_ORIGINAL_CHANGED: ' + record.path);
    frozenOriginals.push({ ...actual, relativePath: record.path, matchesFrozenSnapshot: true });
  }
  const modelPath = await findModel(runtimeRoot), refs = await inspectReferences(modelPath);
  const normalized = await loadManifest(path.resolve(base, config.normalizedManifest));
  const outfit = normalized.layers.find(l => l.record.id === config.layerId && l.record.name === config.expectedLayerName);
  if (!outfit) throw new Error('OUTFIT_LAYER_NOT_FOUND');
  const original = parseColor(config.originalColor), target = parseColor(config.newColor), sourceColorOwners = [];
  for (const l of normalized.layers) {
    let matchedPixels = 0;
    for (let i = 0; i < l.image.data.length; i += 4) if (l.image.data[i + 3] && original.rgb.every((v, c) => l.image.data[i + c] === v)) matchedPixels++;
    if (matchedPixels) sourceColorOwners.push({ layerId: l.record.id, name: l.record.name, matchedPixels });
  }
  await mkdir(path.join(moduleRoot, 'preflight'), { recursive: true });
  const output = await mkdtemp(path.join(moduleRoot, 'preflight', new Date().toISOString().replace(/[:.]/g, '-') + '_'));
  const textures = [];
  for (const ref of refs.records.filter(r => r.textureIndex !== undefined)) {
    const bytes = await readLimited(ref.path), image = decodePng(bytes);
    let exactOriginalColorVisiblePixels = 0, transparentPixelsWithRgb = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] && original.rgb.every((v, c) => image.data[i + c] === v)) exactOriginalColorVisiblePixels++;
      if (!image.data[i + 3] && (image.data[i] || image.data[i + 1] || image.data[i + 2])) transparentPixelsWithRgb++;
    }
    const name = `texture-${ref.textureIndex}-original.png`;
    await save(path.join(output, 'previews', name), bytes);
    await save(path.join(output, 'previews', `texture-${ref.textureIndex}-checkerboard.png`), encodePng(checkerboard(image)));
    textures.push({ textureIndex: ref.textureIndex, texturePath: ref.relativePath, absolutePath: ref.path, sha256: sha256(bytes),
      width: image.width, height: image.height, alpha: alphaInfo(image), exactOriginalColorVisiblePixels,
      transparentPixelsWithRgb, ownershipVerified: false, diagnosticCopy: path.join(output, 'previews', name) });
  }
  let ownershipError = '';
  try { requireVerifiedOwnership(null); } catch (error) { ownershipError = (error as Error).message; }
  const shared = sourceColorOwners.some(l => l.layerId !== outfit.record.id);
  const after = await snapshot(protectedRoots);
  if (!isDeepStrictEqual(before, after)) throw new Error('SOURCE_CHANGED_DURING_PREFLIGHT');
  const cdi = refs.records.find(r => r.field === 'DisplayInfo');
  const cdiData = cdi ? await readJson(cdi.path) as { Parameters: { Id: string }[] } : null;
  const report = {
    schemaVersion: '1.0.0', status: 'ERROR', code: shared ? 'SOURCE_COLOR_SHARED' : 'RUNTIME_OWNERSHIP_UNVERIFIED',
    phase: 'read-only-runtime-preflight', runtimeManualAcceptance: 'NOT_STARTED', output,
    errors: [...(shared ? ['SOURCE_COLOR_SHARED: 原色同时被其他源图层使用，禁止按颜色选择'] : []), ownershipError],
    modelPath, modelSha256: (await fingerprint(modelPath)).sha256, references: refs.records,
    referencesResolvedFrom: 'model3.json.FileReferences', allModelReferencesExist: true,
    textures, normalizedLayer: { layerId: outfit.record.id, name: outfit.record.name, pngSha256: outfit.record.croppedPngSha256 },
    sourceColorOwners, requestedOriginalColor: original.hex, requestedNewColor: target.hex,
    binding: { layerId: outfit.record.id, textureIndex: null, texturePath: null, maskPath: null,
      originalColor: original.hex, newColor: target.hex, modifiedPixelCount: 0, ownershipVerified: false, state: 'UNRESOLVED_NOT_USABLE' },
    parameterIdsFromDisplayInfo: cdiData?.Parameters.map(p => p.Id) ?? [],
    originalFiles: frozenOriginals, protectedFiles: before.map((f, i) => ({ ...f, afterSha256: after[i]!.sha256, unchanged: true })),
    originalsUnchanged: true, newModelCreated: false, moc3WrittenOrGenerated: false, oldVtubeConfigCopied: false,
    plannedModelDirectory: path.join(moduleRoot, 'runs/reference-v1-purple/model'),
    notExecuted: ['输出测试模型', '运行时 Outfit mask', '纹理换色', '纹理差异图', '真实运行时角色预览',
      '复制模型一致性测试', '换色后 mask/Alpha/确定性测试', 'Cubism Viewer 人工运行测试', 'VTube Studio 人工动作测试'],
    nextRequiredInput: '用户阅读并接受官方 SDK 许可后提供 Cubism SDK for Web 的解压目录，或提供已验证且绑定此 MOC3/纹理校验值的网格 UV 数据及专属 mask。',
    sources: {
      coreApi: 'https://docs.live2d.com/en/cubism-sdk-manual/cubism-core-api-reference/',
      sdkDownload: 'https://www.live2d.com/en/sdk/download/web/',
      bleedPrevention: 'https://docs.live2d.com/en/cubism-editor-manual/texture-setting/',
      vtsImport: 'https://github.com/DenchiSoft/VTubeStudio/wiki/Loading-your-own-Models',
    },
  };
  await saveJson(path.join(output, 'preflight.json'), report);
  await save(path.join(output, 'preflight.md'), `# Live2D 运行时纹理换色：前置检查报告\n\n结论：ERROR / ${report.code}。不是模型损坏；是当前缺少可以证明纹理像素专属归属的证据。不得开始运行时换色或把此状态称为完成。\n\n` +
    `## 已确认\n\n- 模型入口：${modelPath}\n- 从 model3.json 的 FileReferences 读取全部引用：${refs.records.length} 个，均存在。纹理路径没有硬编码。\n` +
    `- 原始 ${frozenOriginals.length} 个文件与冻结 SHA-256 一致。总计 ${before.length} 个受保护文件前后校验一致。\n` +
    `- 源图层 ${outfit.record.id} / Outfit 的 PNG 与已验收 manifest 一致。\n- 源图层中包含 ${original.hex} 的图层：${sourceColorOwners.map(l => l.name).join('、')}。这是源图层颜色统计，不能代替运行时 UV 归属证明。\n\n` +
    `## 为什么停止\n\nmodel3.json 只提供文件级引用，没有说明 Outfit 网格使用图集中的哪些坐标。规范化 manifest 记录的是原 PSD 画布坐标，也不是 Live2D UV。\n\n` +
    `运行时图集经过排版、缩放及防漏色处理；直接全局搜索蓝色、用肉眼画矩形，或只修改 Alpha>0 像素，都不足以证明边缘采样及其他网格不受影响。\n\n` +
    `尚未使用官方 Core 取得 Outfit 与全部其他网格的纹理索引、UV、三角形和采样范围。因此不能判定是否共享纹理像素。并非已确认存在共用，而是尚未排除。\n\n` +
    `当前只找到 Cubism Editor 安装目录中的 Core 组件，未找到项目可用的独立 SDK。没有把 Editor 内部组件拆出来当作 SDK 使用，也没有自行解码或重新生成 MOC3。\n\n` +
    `## 图集事实（不等于 Outfit 绑定）\n\n${textures.map(t => `- 索引 ${t.textureIndex}：${t.texturePath}；${t.width}×${t.height}；完全等于原蓝色的可见像素 ${t.exactOriginalColorVisiblePixels}；Alpha=0 但含 RGB 的像素 ${t.transparentPixelsWithRgb}。`).join('\n')}\n\n` +
    `仅生成了原纹理字节副本及棋盘诊断图，位于本报告旁 previews。没有生成猜测 mask、紫色纹理、差异图或伪装成运行时截图的 PSD 重组预览。\n\n` +
    `## 未执行的验收\n\n${report.notExecuted.map(x => '- ' + x + '：未执行').join('\n')}\n\n修改像素数量为 0。没有创建计划中的 model 目录，没有复制旧 .vtube.json。\n\n` +
    `## 下一步\n\n1. 打开 [官方 Cubism SDK for Web 下载页](${report.sources.sdkDownload})。\n2. 由用户阅读并确认许可，下载正式版 SDK，解压到一个独立目录。此操作不要求重新导出模型。\n3. 将 SDK 解压目录的完整路径发给我；请不要只复制 Editor 安装目录里的 DLL。\n4. 获得可用 Core 后，只读加载现有 MOC3，取得 Outfit 和其他网格的 UV；继续检查共享采样区以及同色部件。如仍有歧义，继续 ERROR。\n5. 通过绑定门槛后才制作紫色测试副本，并提供 Viewer/VTS 的最终导入路径和动作测试清单。\n\n` +
    `用户确认 Viewer 和 VTS 运行前，整轮状态不得标为完成。\n\n## 原始文件指纹\n\n| 文件 | SHA-256（匹配冻结版本且未变化） |\n|---|---|\n${frozenOriginals.map(f => `| ${f.relativePath} | ${f.sha256} |`).join('\n')}\n\n` +
    `## 官方依据\n\n- [Core API：取得模型顶点与 UV](${report.sources.coreApi})\n- [纹理防漏色：透明区域的 RGB 也有意义](${report.sources.bleedPrevention})\n- [VTube Studio 模型导入说明](${report.sources.vtsImport})\n`);
  return report;
}

import path from 'node:path';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadManifest, render } from './manifest.ts';
import { recolor, parseColor, validateRule } from './recolor.ts';
import type { Rule } from './recolor.ts';
import { alphaHash, checkerboard, decodePng, encodePng, pixelDiff, sha256, sideBySide } from './pixels.ts';
import { fingerprint, readJson, readLimited, resolvedDestination, safeFile, save, saveJson, snapshot, within } from './files.ts';

export const moduleRoot = fileURLToPath(new URL('../', import.meta.url));
export const defaultConfig = path.join(moduleRoot, 'config/outfit-v1.json');
export interface Config {
  schemaVersion: '1.0.0'; manifestPath: string; baselinePreviewPath: string; rule: Rule;
  protectedSources?: { root: string; snapshotPath: string };
  additionalProtectedPaths?: string[];
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export async function readConfig(file: string): Promise<Config> {
  const c = await readJson(file) as Config;
  check(c && c.schemaVersion === '1.0.0' && typeof c.manifestPath === 'string' && !!c.manifestPath && typeof c.baselinePreviewPath === 'string', 'CONFIG_INVALID: 缺少 manifest 或基准预览路径');
  check(!Object.keys(c).some(k => !['schemaVersion', 'manifestPath', 'baselinePreviewPath', 'rule', 'protectedSources', 'additionalProtectedPaths'].includes(k)), 'CONFIG_INVALID: 存在未知配置项');
  validateRule(c.rule);
  if (c.protectedSources) check(typeof c.protectedSources.root === 'string' && typeof c.protectedSources.snapshotPath === 'string', 'CONFIG_INVALID: 原始文件保护配置无效');
  if (c.additionalProtectedPaths) check(Array.isArray(c.additionalProtectedPaths) && c.additionalProtectedPaths.every(p => typeof p === 'string'), 'CONFIG_INVALID: 保护路径无效');
  return c;
}
export async function run(options: { color: string; configPath?: string; outputRoot?: string }) {
  const color = parseColor(options.color), configPath = await realpath(options.configPath ?? defaultConfig), config = await readConfig(configPath);
  const configRoot = path.dirname(configPath), configFingerprint = await fingerprint(configPath);
  const input = await loadManifest(path.resolve(configRoot, config.manifestPath));
  const target = input.layers.find(l => l.record.id === config.rule.targetLayerId);
  check(target, 'LAYER_NOT_FOUND: manifest 中不存在图层 ID ' + config.rule.targetLayerId);
  check(target.record.name === 'Outfit', 'OUTFIT_ONLY: 本轮只允许修改名称为 Outfit 的图层');
  check(!target.record.effectiveHidden && !target.record.empty, 'OUTFIT_NOT_VISIBLE: Outfit 不可见或为空');
  const baselinePath = await safeFile(input.root, config.baselinePreviewPath), baselineBytes = await readLimited(baselinePath);
  const baseline = decodePng(baselineBytes), original = render(input), baselineDiff = pixelDiff(baseline, original);
  check(baselineDiff.changedPixels === 0, 'BASELINE_PREVIEW_MISMATCH: 按 manifest 重组结果与已验收预览不同，停止换色');
  const roots = [input.root, configPath];
  const baselineRecords: { path: string; sha256: string; bytes: number }[] = [];
  if (config.protectedSources) {
    const root = await realpath(path.resolve(configRoot, config.protectedSources.root));
    const snapshotPath = await realpath(path.resolve(configRoot, config.protectedSources.snapshotPath));
    const lock = await readJson(snapshotPath) as { schemaVersion: string; files: { path: string; sha256: string; bytes: number }[] };
    check(lock && lock.schemaVersion === '1.0.0' && Array.isArray(lock.files) && lock.files.length > 0 && lock.files.length <= 10000, 'BASELINE_INVALID: 原文件锁定清单无效');
    for (const record of lock.files) {
      const actual = await fingerprint(await safeFile(root, record.path));
      check(/^[a-f0-9]{64}$/.test(record.sha256) && actual.sha256 === record.sha256 && actual.bytes === record.bytes, 'PROTECTED_BASELINE_MISMATCH: 原始文件已不同于冻结版本 ' + record.path);
      baselineRecords.push(actual);
    }
    roots.push(root, snapshotPath);
  }
  for (const p of config.additionalProtectedPaths ?? []) roots.push(await realpath(path.resolve(configRoot, p)));
  const outputRoot = await resolvedDestination(options.outputRoot ?? path.join(moduleRoot, 'runs'));
  for (const root of roots) check(!within(root, outputRoot) && !within(outputRoot, root), 'OUTPUT_OVERLAP: 输出目录必须与所有输入及受保护文件分离');
  const protectedBefore = await snapshot(roots);
  check(protectedBefore.find(f => f.path === configPath)?.sha256 === configFingerprint.sha256, 'INPUT_CHANGED_DURING_READ: 配置读取期间发生变化');
  check(protectedBefore.find(f => f.path === input.path)?.sha256 === sha256(input.bytes), 'INPUT_CHANGED_DURING_READ: manifest 读取期间发生变化');
  for (const l of input.layers) check(protectedBefore.find(f => f.path === path.join(input.root, l.record.croppedPng))?.sha256 === sha256(l.bytes) &&
    protectedBefore.find(f => f.path === path.join(input.root, l.record.sourcePng))?.sha256 === sha256(l.beforeBytes), 'INPUT_CHANGED_DURING_READ: 图层读取期间发生变化');
  check(protectedBefore.find(f => f.path === baselinePath)?.sha256 === sha256(baselineBytes), 'INPUT_CHANGED_DURING_READ: 基准预览读取期间发生变化');
  for (const b of baselineRecords) check(protectedBefore.find(f => f.path === b.path)?.sha256 === b.sha256, 'INPUT_CHANGED_DURING_READ: 原始文件变化');
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(path.join(outputRoot, new Date().toISOString().replace(/[:.]/g, '-') + '_' + color.hex.slice(1) + '_'));
  try {
    await saveJson(path.join(output, 'run-config.json'), { schemaVersion: '1.0.0', inputColor: options.color, normalizedColor: color.hex,
      configPath, configSha256: configFingerprint.sha256, sourceManifestPath: input.path, sourceManifestSha256: sha256(input.bytes), config });
    await save(path.join(output, 'input-manifest.json'), input.bytes);
    const changed = recolor(target.image, color.hex), changedBytes = encodePng(changed.image), outManifest = structuredClone(input.manifest);
    const targetOut = outManifest.layers.find(l => l.id === target.record.id)!;
    targetOut.croppedPngSha256 = sha256(changedBytes); targetOut.pngBytesAfter = changedBytes.length;
    outManifest.recolor = { moduleVersion: '0.1.0', sourceManifestSha256: sha256(input.bytes), rule: config.rule, color: color.hex };
    for (const l of input.layers) {
      // Source PNGs are copied byte-for-byte, never re-encoded or opened for writing.
      await save(path.join(output, l.record.croppedPng), l === target ? changedBytes : l.bytes);
      await save(path.join(output, l.record.sourcePng), l.beforeBytes);
    }
    await saveJson(path.join(output, 'layer-manifest.json'), outManifest);
    // Verify serialized coordinates, hashes and the PNG bytes actually saved to disk.
    const persisted = await loadManifest(path.join(output, 'layer-manifest.json'));
    const newTarget = persisted.layers.find(l => l.record.id === target.record.id)!;
    const reassembled = render(persisted), targetDiff = pixelDiff(target.image, newTarget.image, (x, y) => target.image.data[(y * target.image.width + x) * 4 + 3]! > 0);
    const globalDiff = pixelDiff(original, reassembled, (x, y) => {
      const lx = x - target.record.placement.x, ly = y - target.record.placement.y;
      return lx >= 0 && ly >= 0 && lx < target.image.width && ly < target.image.height && target.image.data[(ly * target.image.width + lx) * 4 + 3]! > 0;
    });
    const layers = input.layers.map((before, index) => {
      const after = persisted.layers[index]!, expected = structuredClone(before.record);
      if (before === target) { expected.croppedPngSha256 = after.record.croppedPngSha256; expected.pngBytesAfter = after.bytes.length; }
      return { id: before.record.id, name: before.record.name, isTarget: before === target,
        beforeSha256: sha256(before.bytes), afterSha256: sha256(after.bytes), bytesUnchanged: before.bytes.equals(after.bytes),
        metadataUnchangedExceptTargetFileHashAndBytes: isDeepStrictEqual(expected, after.record),
        beforePngUnchanged: before.beforeBytes.equals(after.beforeBytes), outputPath: path.join(output, after.record.croppedPng) };
    });
    let targetColorMismatchPixels = 0;
    for (let i = 0; i < newTarget.image.data.length; i += 4) if (target.image.data[i + 3] && color.rgb.some((v, c) => newTarget.image.data[i + c] !== v)) targetColorMismatchPixels++;
    const previewImages = {
      'original-outfit.png': target.image,
      'recolored-outfit.png': newTarget.image,
      'character-side-by-side.png': sideBySide(checkerboard(original), checkerboard(reassembled)),
      'reassembled.png': reassembled,
      'reassembled-checkerboard.png': checkerboard(reassembled),
    };
    const previews = [];
    for (const [name, raster] of Object.entries(previewImages)) {
      const filename = path.join(output, 'previews', name), encoded = name === 'original-outfit.png' ? target.bytes : encodePng(raster);
      await save(filename, encoded);
      const saved = await readLimited(filename);
      check(pixelDiff(raster, decodePng(saved)).changedPixels === 0, 'PREVIEW_ROUNDTRIP_FAILED: ' + name);
      previews.push({ name, path: filename, width: raster.width, height: raster.height, sha256: sha256(saved) });
    }
    const protectedAfter = await snapshot(roots);
    const checks = {
      originalCompositeMatchesAcceptedPreview: baselineDiff.changedPixels === 0,
      outfitAlphaIdentical: targetDiff.alphaChangedPixels === 0,
      dimensionsCoordinatesVisibilityOrderAndAlphaBoundsIdentical: layers.every(l => l.metadataUnchangedExceptTargetFileHashAndBytes),
      onlyAllowedOutfitPixelsChanged: targetDiff.outsideAllowedChangedPixels === 0,
      allAllowedPixelsMatchRequestedColor: targetColorMismatchPixels === 0,
      otherLayersSha256AndBytesIdentical: layers.filter(l => !l.isTarget).every(l => l.bytesUnchanged && l.beforeSha256 === l.afterSha256),
      allBeforePngsUnchanged: layers.every(l => l.beforePngUnchanged),
      compositeAlphaIdentical: globalDiff.alphaChangedPixels === 0,
      compositeOutsideOutfitRegionIdentical: globalDiff.outsideAllowedChangedPixels === 0,
      sameInputRecolorPngDeterministic: changedBytes.equals(encodePng(recolor(target.image, options.color).image)),
      previewPngRoundTripsExact: true,
      protectedFilesUnchanged: isDeepStrictEqual(protectedBefore, protectedAfter),
      recordedChangedPixelCountMatchesDisk: targetDiff.changedPixels === changed.changedPixels,
    };
    check(Object.values(checks).every(Boolean), 'ACCEPTANCE_FAILED: ' + Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join(', '));
    const report = {
      schemaVersion: '1.0.0', moduleVersion: '0.1.0', status: 'RECOLOR_PASS', manualAcceptance: 'PENDING',
      createdAt: new Date().toISOString(), output, errors: [] as string[], warnings: changed.changedPixels ? [] : ['NO_COLOR_CHANGE: 输入颜色与允许区域现有颜色相同，没有像素需要修改'],
      scope: '仅 Outfit 的 PNG 受控换色；不认证 Live2D 运行时或产品交付',
      limits: ['本轮为纯色 RGB 替换，不保留允许区域内部的明暗、花纹或多色设计；当前 Outfit 本来就是单一颜色。',
        'maskPath 已预留但仅允许 null；局部蒙版暂未实现。',
        '比较基准是人工验收通过的规范化 PNG，不是重新渲染 PSD；不修改或生成任何 MOC3、模型或纹理。'],
      target: { id: target.record.id, name: target.record.name, inputColor: options.color, newColor: color.hex, originalColors: changed.originalColors,
        allowedPixels: changed.allowedPixels, changedPixels: changed.changedPixels, targetDiff, targetColorMismatchPixels,
        width: target.image.width, height: target.image.height, placement: target.record.placement, orderIndex: target.record.index,
        alphaBeforeSha256: alphaHash(target.image), alphaAfterSha256: alphaHash(newTarget.image),
        originalPngPath: path.join(input.root, target.record.croppedPng), originalPngSha256: sha256(target.bytes), outputPngSha256: sha256(newTarget.bytes) },
      composite: { ...globalDiff, baselinePath, baselineSha256: sha256(baselineBytes), baselineDiff },
      checks, passedChecks: Object.values(checks).filter(Boolean).length, layers, previews,
      sourceManifest: { path: input.path, sha256: sha256(input.bytes) },
      protectedFiles: protectedBefore.map((f, i) => ({ ...f, afterSha256: protectedAfter[i]!.sha256, unchanged: f.sha256 === protectedAfter[i]!.sha256 })),
      originalFilesMatchingFrozenSnapshot: baselineRecords,
    };
    await saveJson(path.join(output, 'acceptance.json'), report);
    await save(path.join(output, 'acceptance.md'), humanReport(report));
    return { output, report };
  } catch (error) {
    await saveJson(path.join(output, 'failure.json'), { status: 'BLOCKED', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
export type Report = Awaited<ReturnType<typeof run>>['report'];
const cell = (s: string) => s.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const checkLabels: Record<string, string> = {
  originalCompositeMatchesAcceptedPreview: '原角色重组与已验收预览逐像素一致',
  outfitAlphaIdentical: 'Outfit Alpha 完全不变',
  dimensionsCoordinatesVisibilityOrderAndAlphaBoundsIdentical: '所有尺寸、坐标、偏移、可见状态、顺序及 Alpha 边界不变',
  onlyAllowedOutfitPixelsChanged: 'Outfit 允许区域外的全部 RGBA 字节不变',
  allAllowedPixelsMatchRequestedColor: '允许区域全部像素采用指定 RGB 颜色',
  otherLayersSha256AndBytesIdentical: '其他图层 SHA-256 及文件字节不变',
  allBeforePngsUnchanged: '裁切前 PNG 的输出副本逐字节一致',
  compositeAlphaIdentical: '完整重组角色 Alpha 完全不变',
  compositeOutsideOutfitRegionIdentical: '完整角色中 Outfit 全局允许区域外无像素变化',
  sameInputRecolorPngDeterministic: '相同输入再次计算 Outfit PNG 得到相同字节',
  previewPngRoundTripsExact: '五张预览写盘后读取像素完全一致',
  protectedFilesUnchanged: '原始文件、规范化输入和旧验收结果运行前后校验值一致',
  recordedChangedPixelCountMatchesDisk: '报告修改像素数量与实际输出文件一致',
};
function humanReport(r: Report): string {
  return `# Outfit 受控换色验收报告 v0.1\n\n自动验收：${r.status}。${r.passedChecks} 项运行时检查全部通过。错误 ${r.errors.length}，提醒 ${r.warnings.length}。人工验收：待用户确认。\n\n` +
    `## 本轮修改\n\n- 图层：${r.target.name}（${r.target.id}），尺寸 ${r.target.width}×${r.target.height}，坐标 (${r.target.placement.x}, ${r.target.placement.y})，从底到顶顺序索引 ${r.target.orderIndex}（从 0 开始）。\n` +
    `- 原颜色（只统计 Alpha>0）：${r.target.originalColors.map(c => `${c.hex}：${c.pixels} 像素`).join('；')}。\n- 输入颜色：${r.target.inputColor}；规范颜色：${r.target.newColor}。\n` +
    `- 允许区域 ${r.target.allowedPixels} 像素；实际改色 ${r.target.changedPixels} 像素。Outfit Alpha 改动 ${r.target.targetDiff.alphaChangedPixels}，区域外改动 ${r.target.targetDiff.outsideAllowedChangedPixels}。\n` +
    `- 完整角色中实际变化 ${r.composite.changedPixels} 像素（受上层遮挡影响，不必等于 Outfit 图层内改动数）；全画布 Alpha 改动 ${r.composite.alphaChangedPixels}，Outfit 全局允许区域外改动 ${r.composite.outsideAllowedChangedPixels}。\n` +
    `- 其他 ${r.layers.length - 1} 个图层 PNG 均逐字节不变；${r.protectedFiles.length} 个受保护文件前后 SHA-256 一致，其中 ${r.originalFilesMatchingFrozenSnapshot.length} 个原始文件同时匹配静态阶段冻结清单。\n\n` +
    `## 如何人工验收\n\n1. 优先打开 previews/character-side-by-side.png：左边是原角色，右边是换色角色；两边均为原尺寸，无缩放。\n2. 确认仅衣服变为紫色，五官、头发、身体与位置均未改变，衣服边缘没有新增毛边。\n3. 打开 previews/reassembled-checkerboard.png 检查单张完整角色。透明成品为 previews/reassembled.png。\n4. 查看原衣服与新衣服，可分别打开 original-outfit.png 与 recolored-outfit.png（保留透明背景）。\n\n` +
    `## 检查结果\n\n${Object.entries(r.checks).map(([name, ok]) => `- ${checkLabels[name] ?? name}：${ok ? '通过' : '失败'}`).join('\n')}\n\n` +
    `## 预览绝对路径\n\n${r.previews.map(p => `- ${p.name}：${p.path}（${p.width}×${p.height}）`).join('\n')}\n\n` +
    `输出目录：${r.output}\n\n配置及输入颜色：run-config.json。机器可读输出：layer-manifest.json。逐项数据：acceptance.json。重复运行会创建新目录，不覆盖本目录。\n\n` +
    `## 原始校验值\n\n输入 manifest SHA-256：${r.sourceManifest.sha256}\n\n原 Outfit PNG：${r.target.originalPngSha256}\n\n新 Outfit PNG：${r.target.outputPngSha256}\n\nAlpha（前后相同）：${r.target.alphaBeforeSha256}\n\n` +
    `| 图层 | 原 PNG SHA-256 | 输出 PNG SHA-256 |\n|---|---|---|\n${r.layers.map(l => `| ${cell(l.name)} | ${l.beforeSha256} | ${l.afterSha256} |`).join('\n')}\n\n` +
    `| 冻结原始文件 | SHA-256（与冻结版本一致，运行前后不变） |\n|---|---|\n${r.originalFilesMatchingFrozenSnapshot.map(f => `| ${cell(f.path)} | ${f.sha256} |`).join('\n')}\n\n` +
    `完整受保护文件清单（含旧 PNG 和验收文件）见 acceptance.json 的 protectedFiles。\n\n## 当前范围限制（不是本轮测试错误）\n\n${r.limits.map(x => '- ' + x).join('\n')}\n\n${r.warnings.length ? '提醒：' + r.warnings.join('；') : '本次无运行提醒。'}\n`;
}

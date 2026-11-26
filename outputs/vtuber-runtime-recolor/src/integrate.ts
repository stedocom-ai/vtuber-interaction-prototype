import path from 'node:path';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../vtuber-controlled-recolor/src/manifest.ts';
import { alphaHash, checkerboard, decodePng, encodePng, pixelDiff, sha256, sideBySide } from '../../vtuber-controlled-recolor/src/pixels.ts';
import type { Raster } from '../../vtuber-controlled-recolor/src/pixels.ts';
import { fingerprint, readJson, readLimited, resolvedDestination, safeFile, save, saveJson, snapshot, within } from '../../vtuber-controlled-recolor/src/files.ts';
import { createCoreReader, resolveSdk } from './core-reader.ts';
import { auditSdkIsolation } from './sdk-audit.ts';
import { findModel, inspectReferences } from './references.ts';
import { countMask, maskPng, ownership, ownershipPreview, overlapPreview, palette } from './uv.ts';
import { differencePreview, recolorWithinMask } from './texture-recolor.ts';
import { renderPreview } from './render-preview.ts';
import { ownershipReport, acceptanceReport } from './reports.ts';
import { normalizeRgbHex, validateModelName } from './cli-options.ts';

export const moduleRoot = fileURLToPath(new URL('../', import.meta.url));
export const workspaceRoot = path.resolve(moduleRoot, '../..');
export const modelName = 'minimal_character_v1_purple_test';
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function ensureAbsent(target: string) {
  try { await stat(target); const error = new Error('OUTPUT_EXISTS: 输出目录已存在，拒绝覆盖 ' + target) as NodeJS.ErrnoException; error.code = 'EEXIST'; throw error; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function integrate(options: { sdk: string; output?: string; stageAOnly?: boolean; color?: string; modelName?: string; sourceModel?: string }) {
  const requestedColor = normalizeRgbHex(options.color ?? '#7A5AF8');
  const outputModelName = validateModelName(options.modelName ?? modelName);
  const requestedOutput = options.output ? await resolvedDestination(options.output) : undefined;
  if (requestedOutput) await ensureAbsent(requestedOutput);
  const sdk = await resolveSdk(options.sdk, workspaceRoot), sdkBefore = await snapshot([sdk.root]);
  const gitBefore = await auditSdkIsolation(workspaceRoot, moduleRoot, sdk.root, sdkBefore);
  const configFile = path.join(moduleRoot, 'config/reference.json'), config = await readJson(configFile) as {
    originalRoot: string; runtimeDirectory: string; frozenSnapshot: string; normalizedManifest: string; protectedPaths: string[];
    layerId: string; expectedLayerName: string; originalColor: string; newColor: string;
  };
  const configRoot = path.dirname(configFile), originalRoot = await realpath(config.originalRoot);
  const runtimeRoot = await realpath(path.join(originalRoot, config.runtimeDirectory)), lockPath = await realpath(path.resolve(configRoot, config.frozenSnapshot));
  const sourceRoots = [originalRoot, lockPath, configFile, ...await Promise.all(config.protectedPaths.map(p => realpath(path.resolve(configRoot, p)))),
    path.join(moduleRoot, 'preflight'), path.join(moduleRoot, 'runs/reference-v1-purple'),
    path.join(workspaceRoot, 'outputs/PROJECT_ACCEPTANCE.md'), path.join(workspaceRoot, 'outputs/VTUBER_PROJECT_HANDOFF_v3.md')];
  const sourceBefore = await snapshot(sourceRoots);
  const lock = await readJson(lockPath) as { schemaVersion: string; files: { path: string; bytes: number; sha256: string }[] };
  ensure(lock.schemaVersion === '1.0.0' && Array.isArray(lock.files) && lock.files.length, 'SNAPSHOT_INVALID');
  const originalFiles = [];
  for (const f of lock.files) { const actual = await fingerprint(await safeFile(originalRoot, f.path)); ensure(actual.sha256 === f.sha256 && actual.bytes === f.bytes, 'FROZEN_SOURCE_CHANGED: ' + f.path); originalFiles.push(actual); }
  const modelPath = await findModel(runtimeRoot), modelBytes = await readLimited(modelPath), references = await inspectReferences(modelPath);
  if (options.sourceModel) ensure(await realpath(options.sourceModel) === modelPath, 'SOURCE_MODEL_NOT_REFERENCE_V1: 本阶段只支持已冻结的 reference-v1 model3.json');
  const mocRef = references.records.find(r => r.field === 'Moc')!, mocBytes = await readLimited(mocRef.path);
  const normalized = await loadManifest(path.resolve(configRoot, config.normalizedManifest));
  const layer = normalized.layers.find(l => l.record.id === config.layerId);
  ensure(layer && layer.record.name === config.expectedLayerName && layer.record.name === 'Outfit', 'OUTFIT_LAYER_MAPPING_INVALID');
  const textureRefs = references.records.filter(r => r.textureIndex !== undefined).sort((a, b) => a.textureIndex! - b.textureIndex!);
  const textures: Raster[] = [], textureBuffers: Buffer[] = [];
  for (const ref of textureRefs) { const bytes = await readLimited(ref.path); ensure(sha256(bytes) === ref.sha256, 'TEXTURE_CHANGED_DURING_READ'); textureBuffers.push(bytes); textures.push(decodePng(bytes)); }
  const reader = await createCoreReader(sdk.corePath), inventory = reader.extract(mocBytes);
  ensure(inventory.drawables.every((d, i) => d.index === i), 'DRAWABLE_ORDER_INVALID');
  const own = ownership(inventory, textures, { id: layer.record.id, name: layer.record.name });
  const targetRef = textureRefs[own.target.textureIndex]!, originalTexture = textures[own.target.textureIndex]!;
  // Only a corroborating safety check. This never establishes ownership or generates a mask.
  const originalRgb = [1, 3, 5].map(i => parseInt(config.originalColor.slice(i, i + 2), 16));
  const sharedColorDrawables = [];
  for (const d of inventory.drawables.filter(d => d.index !== own.target.index)) {
    const image = textures[d.textureIndex]!, mask = own.masks[d.index]!; let matchingPixels = 0;
    for (let p = 0; p < mask.length; p++) if (mask[p] && image.data[p * 4 + 3] && originalRgb.every((v, c) => image.data[p * 4 + c] === v)) matchingPixels++;
    if (matchingPixels) sharedColorDrawables.push({ id: d.id, matchingPixels });
  }
  // Check UV/texture identity at the extremes of the six authored controls (in-memory only).
  const parameterChecks = [];
  for (const id of ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY']) {
    const param = inventory.parameters.find(p => p.id === id); ensure(param, 'REQUIRED_PARAMETER_MISSING: ' + id);
    for (const value of [param.min, param.max]) {
      const posed = reader.extract(mocBytes, { [id]: value });
      const stable = inventory.drawables.every((d, i) => d.id === posed.drawables[i]!.id && d.textureIndex === posed.drawables[i]!.textureIndex && isDeepStrictEqual(d.vertexUvs, posed.drawables[i]!.vertexUvs) && isDeepStrictEqual(d.triangleIndices, posed.drawables[i]!.triangleIndices));
      parameterChecks.push({ id, value, uvTextureAndIndicesUnchanged: stable });
    }
  }
  const phaseAPassed = own.unique && sharedColorDrawables.length === 0 && parameterChecks.every(p => p.uvTextureAndIndicesUnchanged);
  let output: string;
  let outputCreatedByThisRun = false;
  if (requestedOutput) output = requestedOutput;
  else if (options.stageAOnly) { await mkdir(path.join(moduleRoot, 'ownership-checks'), { recursive: true }); output = await mkdtemp(path.join(moduleRoot, 'ownership-checks', new Date().toISOString().replace(/[:.]/g, '-') + '_')); outputCreatedByThisRun = true; }
  else output = await resolvedDestination(path.join(moduleRoot, 'runs/reference-v1-purple'));
  ensure(output !== path.parse(output).root, 'OUTPUT_DIRECTORY_INVALID');
  for (const root of [sdk.root, ...sourceRoots]) ensure(!within(root, output) && !within(output, root), 'OUTPUT_OVERLAP');
  if (options.output || !options.stageAOnly) { await mkdir(path.dirname(output), { recursive: true }); await mkdir(output); outputCreatedByThisRun = true; }
  try {
    const maskImage = maskPng(own.targetMask, own.width, own.height), maskBytes = encodePng(maskImage);
    await saveJson(path.join(output, 'drawable-inventory.json'), { ...inventory, sourceModel3: modelPath, sdkVersion: sdk.sdkVersion, corePath: sdk.corePath,
      notes: ['partIndex=-1 and partId=null means no parent Part; never invent a Part name.', 'Positions are from official Core at default parameters; UVs use bottom-left origin.'] });
    await save(path.join(output, 'masks/outfit-uv-mask.png'), maskBytes);
    const previews: { name: string; path: string; sha256: string; width: number; height: number }[] = [];
    async function preview(name: string, image: Raster, bytes?: Buffer) {
      const file = path.join(output, 'previews', name), encoded = bytes ?? encodePng(image); await save(file, encoded);
      const decoded = decodePng(await readLimited(file)); ensure(pixelDiff(image, decoded).changedPixels === 0, 'PREVIEW_ROUNDTRIP_FAILED');
      previews.push({ name, path: file, sha256: sha256(encoded), width: image.width, height: image.height });
    }
    for (let t = 0; t < textures.length; t++) {
      await preview(`texture-${t}-original.png`, textures[t]!, textureBuffers[t]);
      await preview(`texture-${t}-original-checkerboard.png`, checkerboard(textures[t]!));
      await preview(`texture-${t}-ownership.png`, ownershipPreview(inventory, own.masks, t, textures[t]!.width, textures[t]!.height));
    }
    await preview('outfit-uv-mask.png', maskImage);
    await preview('outfit-overlap.png', overlapPreview(own.targetMask, own.others, own.width, own.height));
    await preview('outfit-sampling-guard-overlap.png', overlapPreview(own.guards[own.target.index]!, own.othersGuard, own.width, own.height));
    const phaseA = {
      status: phaseAPassed ? 'OWNERSHIP_PASS' : 'ERROR', evidenceSource: 'official Cubism Core, current frozen MOC3',
      sdkVersion: sdk.sdkVersion, coreVersion: reader.version, sourceModel3: modelPath, mocSha256: sha256(mocBytes),
      mapping: { layerId: layer.record.id, layerName: layer.record.name, drawableId: own.target.id, method: 'exact unique Drawable ID equals normalized Outfit layer name', candidateCount: 1 },
      textureIndex: own.target.textureIndex, texturePath: targetRef.relativePath, textureSha256: targetRef.sha256,
      textureResolution: { width: own.width, height: own.height }, partId: own.target.partId, partIndex: own.target.partIndex,
      maskPath: 'masks/outfit-uv-mask.png', maskSha256: sha256(maskBytes), maskPixels: countMask(own.targetMask),
      directOverlapPixels: own.directOverlapPixels, guardedOverlapPixels: own.guardedOverlapPixels, otherDrawableComparisons: own.comparisons, sharedColorDrawables, parameterChecks,
      rasterization: 'UV -> x=u*width, y=(1-v)*height. Union of triangles intersecting each closed texel square (conservative coverage, both windings, boundary included).',
      samplingGuard: 'Chebyshev dilation radius 1 on every Drawable; stronger than base-level bilinear sampling support.',
      proofScope: 'Original-resolution UV texels and base-level bilinear neighborhood; not arbitrary mipmap/anisotropic filtering or Viewer/VTS runtime certification.',
      legend: inventory.drawables.map(d => ({ id: d.id, rgb: palette[d.index % palette.length], textureIndex: d.textureIndex })),
    };
    await saveJson(path.join(output, 'ownership-check.json'), phaseA);
    await save(path.join(output, 'ownership-report.md'), ownershipReport(phaseA));
    const binding = { schemaVersion: '1.0.0', layerId: layer.record.id, drawableId: own.target.id, textureIndex: own.target.textureIndex,
      texturePath: targetRef.relativePath, texturePathBase: 'model directory', maskPath: 'masks/outfit-uv-mask.png', maskPathBase: 'run directory',
      originalColor: config.originalColor, newColor: requestedColor, modifiedPixelCount: 0, maskSha256: sha256(maskBytes), originalTextureSha256: targetRef.sha256,
      mocSha256: sha256(mocBytes), ownershipVerified: phaseAPassed, proofFile: 'ownership-check.json', permittedOperation: 'RGB replacement only where UV mask=1 AND source alpha>0' };
    if (!phaseAPassed || options.stageAOnly) {
      await saveJson(path.join(output, 'runtime-texture-bindings.json'), binding);
      ensure(isDeepStrictEqual(sourceBefore, await snapshot(sourceRoots)), 'SOURCE_CHANGED'); ensure(isDeepStrictEqual(sdkBefore, await snapshot([sdk.root])), 'SDK_CHANGED');
      await saveJson(path.join(output, 'sdk-audit.json'), { sdk, gitBefore, sdkFilesUnchanged: true, sourceFilesUnchanged: true, modelCreated: false });
      return { status: phaseAPassed ? 'STAGE_A_PASS_ONLY' : 'ERROR', output, phaseA, modelCreated: false };
    }
    // The stage B entry is below all ownership checks; no model directory exists on a failed gate.
    const recolored = recolorWithinMask(originalTexture, own.targetMask, requestedColor), changedPng = encodePng(recolored.image);
    const diskMask = decodePng(await readLimited(path.join(output, binding.maskPath)));
    for (let p = 0; p < own.targetMask.length; p++) ensure(diskMask.data[p * 4] === (own.targetMask[p] ? 255 : 0), 'MASK_WRITE_MISMATCH');
    const textureDiff = pixelDiff(originalTexture, recolored.image, (x, y) => !!own.targetMask[y * own.width + x]);
    ensure(textureDiff.alphaChangedPixels === 0 && textureDiff.outsideAllowedChangedPixels === 0, 'TEXTURE_BOUNDARY_VIOLATION');
    const changedTextures = textures.map((t, i) => i === own.target.textureIndex ? recolored.image : t);
    const originalPreview = renderPreview(inventory, textures), changedPreview = renderPreview(inventory, changedTextures);
    ensure(pixelDiff(originalPreview, changedPreview).alphaChangedPixels === 0, 'PREVIEW_ALPHA_CHANGED');
    const modelDirectory = path.join(output, 'model'), importDirectory = path.join(output, 'vts-import', outputModelName), entryName = outputModelName + '.model3.json';
    await mkdir(modelDirectory); await mkdir(importDirectory, { recursive: true });
    const copiedFiles = [];
    const uniqueReferences = [...new Map(references.records.map(r => [r.relativePath, r])).values()];
    for (const dir of [modelDirectory, importDirectory]) {
      await save(path.join(dir, entryName), modelBytes);
      for (const ref of uniqueReferences) {
        const source = await readLimited(ref.path); ensure(sha256(source) === ref.sha256, 'SOURCE_CHANGED_DURING_COPY');
        const bytes = ref.field === `Textures[${own.target.textureIndex}]` ? changedPng : source;
        const filename = path.join(dir, ref.relativePath); await save(filename, bytes);
        const actual = await readLimited(filename); ensure(actual.equals(bytes), 'COPIED_FILE_MISMATCH');
        copiedFiles.push({ relativePath: path.relative(output, filename).replaceAll('\\', '/'), sourceSha256: sha256(source), outputSha256: sha256(actual), isChangedTexture: ref.field === `Textures[${own.target.textureIndex}]` });
      }
      await inspectReferences(path.join(dir, entryName));
    }
    const copiedMoc = await readLimited(path.join(modelDirectory, mocRef.relativePath));
    ensure(copiedMoc.equals(mocBytes), 'MOC_BYTES_CHANGED');
    ensure(isDeepStrictEqual(reader.extract(copiedMoc), inventory), 'COPIED_MOC_INVENTORY_CHANGED');
    const textureOnDisk = decodePng(await readLimited(path.join(modelDirectory, targetRef.relativePath)));
    ensure(pixelDiff(recolored.image, textureOnDisk).changedPixels === 0, 'TEXTURE_PNG_CHANGED');
    await preview(`texture-${own.target.textureIndex}-recolored.png`, textureOnDisk, changedPng);
    await preview(`texture-${own.target.textureIndex}-recolored-checkerboard.png`, checkerboard(textureOnDisk));
    await preview('texture-difference.png', differencePreview(originalTexture, textureOnDisk));
    await preview('character-original.png', originalPreview);
    await preview('character-recolored.png', changedPreview);
    await preview('character-recolored-checkerboard.png', checkerboard(changedPreview));
    await preview('character-side-by-side.png', sideBySide(checkerboard(originalPreview), checkerboard(changedPreview)));
    const sourceAfter = await snapshot(sourceRoots), sdkAfter = await snapshot([sdk.root]);
    ensure(isDeepStrictEqual(sourceBefore, sourceAfter), 'ORIGINALS_CHANGED'); ensure(isDeepStrictEqual(sdkBefore, sdkAfter), 'SDK_CHANGED');
    const gitAfter = await auditSdkIsolation(workspaceRoot, moduleRoot, sdk.root, sdkAfter);
    const modelListing = await snapshot([modelDirectory]), importListing = await snapshot([importDirectory]);
    ensure(modelListing.length === uniqueReferences.length + 1 && importListing.length === modelListing.length, 'MODEL_FOLDER_INCOMPLETE');
    ensure(!modelListing.some(f => f.path.toLowerCase().endsWith('.vtube.json')) && !importListing.some(f => f.path.toLowerCase().endsWith('.vtube.json')), 'OLD_VTUBE_CONFIG_COPIED');
    const checks = {
      officialCoreMocConsistency: inventory.mocConsistency, outfitUniqueId: true, uvOwnershipExclusive: phaseAPassed,
      allOriginalSha256Unchanged: isDeepStrictEqual(sourceBefore, sourceAfter), entireSdkSha256Unchanged: isDeepStrictEqual(sdkBefore, sdkAfter),
      noSdkCopiedOrTracked: gitAfter.copiedSdkFiles.length === 0 && gitAfter.sdkLinks.length === 0,
      copiedMocByteIdentical: copiedMoc.equals(mocBytes), parameterIdsAndModelDataUnchanged: isDeepStrictEqual(reader.extract(copiedMoc), inventory),
      allAlphaUnchanged: textureDiff.alphaChangedPixels === 0, outsideMaskRgbaUnchanged: textureDiff.outsideAllowedChangedPixels === 0,
      otherReferencedFilesUnchanged: copiedFiles.filter(f => !f.isChangedTexture).every(f => f.sourceSha256 === f.outputSha256),
      model3ContentsUnchanged: (await readLimited(path.join(modelDirectory, entryName))).equals(modelBytes),
      allRelativeReferencesExist: true, oldVtubeConfigAbsent: true, modelFoldersComplete: modelListing.length === uniqueReferences.length + 1,
      identicalInputIdenticalTexture: changedPng.equals(encodePng(recolorWithinMask(originalTexture, own.targetMask, requestedColor).image)),
      diskTexturePixelsExact: pixelDiff(recolored.image, textureOnDisk).changedPixels === 0, previewAlphaUnchanged: pixelDiff(originalPreview, changedPreview).alphaChangedPixels === 0,
    };
    ensure(Object.values(checks).every(Boolean), 'AUTO_ACCEPTANCE_FAILED');
    const finalBinding = { ...binding, modifiedPixelCount: recolored.changedPixels, outputTextureSha256: sha256(changedPng), allowedNonTransparentPixels: recolored.allowedVisiblePixels,
      preservedTransparentMaskPixels: recolored.preservedTransparentMaskPixels, originalColors: recolored.originalColors };
    await saveJson(path.join(output, 'runtime-texture-bindings.json'), finalBinding);
    await saveJson(path.join(output, 'sdk-audit.json'), { sdk, gitBefore, gitAfter, sdkFilesUnchanged: true, sdkFileCount: sdkBefore.length, sdkFingerprints: sdkBefore, sourceFilesUnchanged: true });
    const report = {
      schemaVersion: '1.0.0', status: 'AUTO_CHECKS_PASS_MANUAL_RUNTIME_PENDING', phaseA: phaseA.status, modelCreated: true, output,
      sdkVersion: sdk.sdkVersion, coreVersion: reader.version, sourceModel3: modelPath, originalFiles, modelDirectory, importDirectory,
      viewerFile: path.join(modelDirectory, entryName), vtsFolder: importDirectory, modelName: outputModelName,
      changedPixels: recolored.changedPixels, originalColor: config.originalColor, newColor: requestedColor, textureDiff,
      alphaBeforeSha256: alphaHash(originalTexture), alphaAfterSha256: alphaHash(textureOnDisk), checks, passedChecks: Object.values(checks).filter(Boolean).length,
      errors: [] as string[], warnings: [
        'MANUAL_RUNTIME_PENDING: 尚未在用户 Cubism Viewer / VTube Studio 中加载，不能宣布运行时集成完成。',
        'SAMPLING_SCOPE: 归属证明覆盖原始图集和 1 像素边缘；缩小模型时的 mipmap/各向异性滤波须人工检查。',
        'TRANSPARENT_RGB_PRESERVED: 按要求保留 mask 内 Alpha=0 像素的原始 RGB，不重做防漏色；实际软件中的细边效果须人工检查。',
      ],
      previewMethod: 'Official Core default vertex positions + UV + triangle indices + render order; local CPU premultiplied base-level bilinear rasterizer. Not a Viewer/VTS screenshot, not the PSD-layer preview.',
      binding: finalBinding, previews, copiedFiles,
      protectedFiles: sourceBefore.map((f, i) => ({ ...f, afterSha256: sourceAfter[i]!.sha256, unchanged: true })), sdkFileCount: sdkBefore.length,
      manualAcceptance: { cubismViewer: 'PENDING', vTubeStudio: 'PENDING', overallComplete: false },
    };
    await saveJson(path.join(output, 'run-config.json'), { schemaVersion: '1.0.0', templateId: 'reference-v1', layerId: layer.record.id,
      drawableId: own.target.id, color: requestedColor, modelName: outputModelName, output, outputDirectory: path.dirname(output),
      sdkRoot: sdk.root, sdkVersion: sdk.sdkVersion, coreVersion: reader.version, sourceModel3: modelPath,
      sourceTextureSha256: targetRef.sha256, mocSha256: sha256(mocBytes), maskSha256: sha256(maskBytes),
      overwrite: false, runtimeRecolor: false, createdModel: true });
    await saveJson(path.join(output, 'acceptance.json'), report);
    await save(path.join(output, 'acceptance.md'), acceptanceReport(report));
    return { status: report.status, output, phaseA, modelCreated: true, report };
  } catch (error) {
    // A GUI/CLI failure must not leave a half-built model. The target was proven
    // absent and disjoint from every protected source before this flag was set.
    if (outputCreatedByThisRun) await rm(output, { recursive: true, force: true });
    throw error;
  }
}

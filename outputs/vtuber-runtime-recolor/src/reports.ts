import path from 'node:path';

interface PhaseA {
  status: string; sdkVersion: string; coreVersion: string; sourceModel3: string; mocSha256: string;
  mapping: { layerId: string; drawableId: string; candidateCount: number };
  textureIndex: number; texturePath: string; textureResolution: { width: number; height: number };
  partId: string | null; maskPixels: number; directOverlapPixels: number; guardedOverlapPixels: number;
  otherDrawableComparisons: { drawableId: string; directOverlapPixels: number; guardedOverlapPixels: number }[];
  parameterChecks: { id: string; value: number; uvTextureAndIndicesUnchanged: boolean }[];
  sharedColorDrawables: { id: string; matchingPixels: number }[];
  legend: { id: string; rgb: number[] | undefined; textureIndex: number }[];
}
export function ownershipReport(p: PhaseA) {
  return `# Outfit 运行时纹理归属检查（阶段 A）\n\n结论：${p.status}。只证明本报告定义的纹理像素归属，不代表实际软件加载或动作测试已经通过。\n\n` +
    `## 官方只读解析\n\n- SDK：Cubism SDK for Web ${p.sdkVersion}。Core：${p.coreVersion}。\n- 模型入口：${p.sourceModel3}\n- 原 MOC3 SHA-256：${p.mocSha256}\n` +
    `- 从 model3.json 读取 Moc 与 Textures，使用 SDK 外部目录里的 Core 在内存中加载，未写回 MOC3，也没有复制 SDK/Core。\n` +
    `- 对应关系：规范化图层 ${p.mapping.layerId} / Outfit → 严格匹配且唯一的 Drawable ID ${p.mapping.drawableId}，候选 ${p.mapping.candidateCount} 个。不是颜色匹配、PSD 坐标映射或肉眼猜测。\n` +
    `- Part：${p.partId ?? '无父 Part（索引 -1）；模型没有 Part 分组，不虚构所属分组'}。\n- 纹理索引 ${p.textureIndex}：${p.texturePath}，${p.textureResolution.width}×${p.textureResolution.height}。\n\n` +
    `## 像素级归属依据\n\n将每个 Drawable 的全部 UV 三角形映射到实际图集：x=u×宽，y=(1-v)×高。以三角形与像素方格是否相交生成保守 mask，包含边界，不用外接矩形替代三角形。隐藏/透明 Drawable 也纳入使用区域检查。\n\n` +
    `Outfit mask 共 ${p.maskPixels} 像素；与其他 Drawable 直接重叠 ${p.directOverlapPixels} 像素。双方各扩展 1 像素形成原始分辨率双线性采样保护范围，重叠 ${p.guardedOverlapPixels} 像素。\n\n` +
    `| 其他 Drawable | 直接重叠像素 | 扩展后重叠像素 |\n|---|---:|---:|\n${p.otherDrawableComparisons.map(r => `| ${r.drawableId} | ${r.directOverlapPixels} | ${r.guardedOverlapPixels} |`).join('\n')}\n\n` +
    `另外检查原蓝色是否落在其他 Drawable 的可见像素使用区：${p.sharedColorDrawables.length ? JSON.stringify(p.sharedColorDrawables) : '未发现'}。此项仅作防误改补充，不用于建立归属。\n\n` +
    `六个已制作参数各测试最小/最大值，共 ${p.parameterChecks.length} 次内存计算，UV、纹理索引与三角形索引${p.parameterChecks.every(c => c.uvTextureAndIndicesUnchanged) ? '全部保持一致' : '存在变化'}；这不替代人工动作检查。\n\n` +
    `## 看哪些图\n\n- masks/outfit-uv-mask.png：白色是 Outfit 的 UV 使用区；黑色禁止修改。蒙版形状由网格决定，因此可能包含透明像素。\n` +
    `- previews/texture-${p.textureIndex}-ownership.png：全部 Drawable 的三角形使用区域；红色表示多个 Drawable 重叠。\n` +
    `- previews/outfit-overlap.png：紫色 Outfit、蓝色其他部件、红色重叠、深色未使用。\n- previews/outfit-sampling-guard-overlap.png：扩展 1 像素后的同类检查。\n\n` +
    `| Drawable | 图例 RGB |\n|---|---|\n${p.legend.map(l => `| ${l.id} | ${l.rgb?.join(', ')} |`).join('\n')}\n\n` +
    `完整 Vertex UV、Vertex Position、Triangle Indices、Texture Index、Render Order 和 Part 信息见 drawable-inventory.json。绑定和校验值见 runtime-texture-bindings.json。\n\n` +
    `## 证明范围与限制\n\n证明针对原始图集及基础双线性采样保护范围；不声称任意 mipmap 层级、各向异性采样或外部软件的所有缩放设置都无边缘影响。最终应在 Viewer/VTS 中检查缩放与动作组合。Core 和 SDK 的版本不代表重新导出的模型版本；MOC3 保持原导出字节。\n`;
}
interface Acceptance {
  status: string; sdkVersion: string; coreVersion: string; passedChecks: number; errors: string[]; warnings: string[];
  output: string; sourceModel3: string;
  changedPixels: number; originalColor: string; newColor: string;
  textureDiff: { alphaChangedPixels: number; outsideAllowedChangedPixels: number };
  modelDirectory: string; importDirectory: string; viewerFile: string; modelName: string;
  originalFiles: { path: string; sha256: string }[];
  protectedFiles: unknown[]; sdkFileCount: number; checks: Record<string, boolean>;
  alphaBeforeSha256: string; alphaAfterSha256: string;
  binding: { maskSha256: string; originalTextureSha256: string; outputTextureSha256: string; preservedTransparentMaskPixels: number; originalColors: { hex: string; pixels: number }[] };
  previews: { name: string; path: string }[];
}
const checkNames: Record<string, string> = {
  officialCoreMocConsistency: '官方 Core 一致性检查', outfitUniqueId: 'Outfit Drawable ID 唯一', uvOwnershipExclusive: 'UV 与基础采样保护范围独占',
  allOriginalSha256Unchanged: '所有受保护原始/历史文件 SHA-256 不变', entireSdkSha256Unchanged: '整个 SDK 文件校验值不变', noSdkCopiedOrTracked: '没有 SDK 副本或 Git 跟踪',
  copiedMocByteIdentical: '复制后的 MOC3 逐字节一致', parameterIdsAndModelDataUnchanged: '参数 ID 及 Core 解析结果不变', allAlphaUnchanged: '所有纹理 Alpha 完全不变',
  outsideMaskRgbaUnchanged: 'mask 外 RGBA 完全不变', otherReferencedFilesUnchanged: '非目标文件校验值不变', model3ContentsUnchanged: '入口 JSON 仅改文件名、内容不变',
  allRelativeReferencesExist: '全部相对文件引用有效', oldVtubeConfigAbsent: '没有复制旧 VTube 配置', modelFoldersComplete: '测试模型与导入副本完整',
  identicalInputIdenticalTexture: '相同输入生成相同纹理字节', diskTexturePixelsExact: '纹理写盘重读逐像素一致', previewAlphaUnchanged: '角色诊断预览 Alpha 不变',
};
export function acceptanceReport(r: Acceptance) {
  return `# Outfit ${r.newColor} Live2D 测试模型自动验收\n\n状态：${r.status}。自动检查 ${r.passedChecks} 项通过，错误 ${r.errors.length}，待确认提醒 ${r.warnings.length}。**Cubism Viewer / VTube Studio 人工运行验收尚未完成，整轮未完成。**\n\n` +
    `## 本轮结果\n\n- SDK ${r.sdkVersion}；Core ${r.coreVersion}，作为本机外部只读依赖。整个 SDK ${r.sdkFileCount} 个文件校验值不变，无 SDK/Core 副本进入项目或模型。\n` +
    `- ${r.originalFiles.length} 个原始模型文件匹配冻结清单；${r.protectedFiles.length} 个受保护文件前后不变。原 PSD、cmo3、moc3、model3.json、纹理和旧 .vtube.json 均未修改。\n` +
    `- Outfit 从原始主色 ${r.originalColor} 换为 ${r.newColor}；修改 ${r.changedPixels} 个纹理像素。原图集经导出存在抗锯齿边缘颜色，允许区共有 ${r.binding.originalColors.length} 种原 RGB，完整列表在绑定 JSON。\n` +
    `- Alpha 改动 ${r.textureDiff.alphaChangedPixels} 像素；mask 外 RGBA 改动 ${r.textureDiff.outsideAllowedChangedPixels} 像素。mask 内 ${r.binding.preservedTransparentMaskPixels} 个全透明像素也逐字节保留。\n` +
    `- 保留原 MOC3 与参数，不重新导出。新的 model3.json 文件名用于区分模型，JSON 内容及内部相对路径不变。\n\n` +
    `## 自动检查\n\n${Object.entries(r.checks).map(([k, ok]) => `- ${checkNames[k] ?? k}：${ok ? '通过' : '失败'}`).join('\n')}\n\n` +
    `## 检查预览\n\n先看 character-side-by-side.png：左原始运行时纹理、右 ${r.newColor} 纹理。此图由官方 Core 的默认网格位置、UV、三角形、绘制顺序进行本地 CPU 诊断渲染，不是 PSD 重组图，也不是 Viewer/VTS 实测截图。基础双线性采样、预乘 Alpha，无 mipmap，不用它认证外部运行时。\n\n` +
    `${r.previews.map(p => `- ${p.name}：${p.path}`).join('\n')}\n\n` +
    `## Cubism Viewer 人工检查\n\n1. 启动你之前验证过的 Cubism Viewer (for OW)。\n2. 将下面这个入口 JSON 拖入窗口（不是 moc3，不是 PNG）：\n\n${r.viewerFile}\n\n` +
    `3. 确认衣服是 ${r.newColor}，其他部位与原模型一致，且无加载错误。\n4. 在参数面板分别拖动 ParamAngleX、ParamAngleY、ParamAngleZ、ParamEyeLOpen、ParamEyeROpen、ParamMouthOpenY，再回到默认值。\n` +
    `5. 检查左右眼能独立眨眼、嘴能张闭、头部三轴动作保留；组合转头+张嘴+眨眼，检查衣服边缘及颈部遮挡。\n6. 放大和缩小角色，特别检查紫色边缘是否残留蓝线、白线、黑线或颜色渗入邻近部件。只观察，不点击保存或重新导出到原模型目录。\n\n` +
    `## VTube Studio 导入与动作检查\n\n为避免把通用名称 model 文件夹与现有目录混淆，额外提供同字节的独立命名导入副本：\n\n${r.importDirectory}\n\n` +
    `1. 在资源管理器中复制上面整个 ${r.modelName} 文件夹，不要只复制一个 JSON 或纹理。\n2. 在 VTube Studio 的模型设置中使用打开模型文件夹按钮，进入 Live2DModels，再粘贴。若已有同名文件夹，先停止，不覆盖旧测试结果。\n` +
    `3. 返回 VTube Studio，必要时重启，在模型列表选择 ${r.modelName}。可凭模型名和 ${r.newColor} 衣服与原蓝色模型区分。\n4. 首次加载运行 Auto-Setup，让 VTS 创建新的 .vtube.json。我们没有复制旧配置；因此面捕灵敏度、映射范围可能需要重新校准，不等于 MOC3 动作丢失。\n` +
    `5. 选择之前的摄像头，开启追踪并校准中立姿势。分别测试：左眼眨、右眼眨、双眼眨、张嘴闭嘴、头部左右/上下/侧倾，以及转头+张嘴+眨眼组合。\n6. 检查眼睛、嘴与三个角度映射到上述对应参数；不要因为未制作的眼球、眉毛、头发、呼吸等参数没有动作就判断换色失败。\n` +
    `7. 放大/缩小、拖动角色；持续运行 5 分钟，检查边缘、遮挡、加载报错、闪烁和动作是否与原模型一致。5 分钟仅为本轮冒烟检查，不是长期稳定性认证。\n8. VTS 新配置只应写入复制到 Live2DModels 的测试文件夹，不要覆盖原模型目录。\n\n` +
    `## 请回传的人工验收记录\n\n- Viewer：加载成功/失败；衣服颜色；其他部位；六个动作；缩放边缘。\n- VTS：显示的测试名称；Auto-Setup；摄像头追踪；六个动作及组合；缩放边缘；运行 5 分钟是否异常。\n- 有问题时发截图及对应操作；未确认前状态保持 PENDING，不宣布完成。\n\n` +
    `## 待确认提醒\n\n${r.warnings.map(w => '- ' + w).join('\n')}\n\n` +
    `## 校验值\n\n原纹理 SHA-256：${r.binding.originalTextureSha256}\n\n新纹理 SHA-256：${r.binding.outputTextureSha256}\n\nUV mask SHA-256：${r.binding.maskSha256}\n\nAlpha 前：${r.alphaBeforeSha256}\n\nAlpha 后：${r.alphaAfterSha256}\n\n` +
    `| 原始文件 | SHA-256 |\n|---|---|\n${r.originalFiles.map(f => `| ${f.path} | ${f.sha256} |`).join('\n')}\n\n` +
    `## 可复制复现命令\n\n\`\`\`powershell\n& 'C:\\Users\\34154\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe' 'C:\\Users\\34154\\Documents\\Codex\\2026-08-26\\new-chat\\outputs\\vtuber-runtime-recolor\\src\\runtime-cli.ts' --sdk 'D:\\live 2D\\CubismSdkForWeb' --source-model '${r.sourceModel3}' --color '${r.newColor}' --output-name '${r.modelName}' --output-dir '${path.dirname(r.output)}'\n\`\`\`\n\n该命令在同名输出已存在时会停止；复现时应使用新的输出名称。\n\n` +
    `规范输出模型目录：${r.modelDirectory}\n\n完整机器记录：acceptance.json、run-config.json、runtime-texture-bindings.json、drawable-inventory.json、ownership-check.json、sdk-audit.json。\n\n` +
    `参考：[Live2D Viewer 模型加载](https://docs.live2d.com/en/cubism-editor-manual/load-model-and-motion/)、[VTube Studio 官方导入说明](https://github.com/DenchiSoft/VTubeStudio/wiki/Loading-your-own-Models)。\n`;
}

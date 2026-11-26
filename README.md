# 虚拟角色交互原型与本地 HTTP 服务

陈昭晖的个人交互原型。项目围绕摄像头驱动角色预览、个人设置保存与恢复、OBS 纯角色画面输出，验证从用户操作到角色响应的流程。

本人负责需求梳理、操作流程设计、问题反馈与人工验收。代码在 Codex 辅助下实现。曾复现角色转头方向与预期不一致的问题，反馈触发步骤和表现差异，调整后复测方向、闭眼、输出启停和设置恢复。

这份源码快照保留原来的模块结构。当前画面运行仍依赖开发机配置、外部 Live2D SDK 和合法取得的模型素材，完整画面复现前需完成下述本机配置。

| 模块 | 用途 |
| --- | --- |
| [vtuber-obs-output](outputs/vtuber-obs-output/src/server.ts) | OBS 只读输出页、输出状态、启停和连接失效处理 |
| [vtuber-camera-tracking](outputs/vtuber-camera-tracking/src/server.ts) | MediaPipe 追踪、本地 HTTP 服务、请求校验和设置保存 |
| [vtuber-local-preview](outputs/vtuber-local-preview/src/server.ts) | Live2D 角色预览、SDK 只读接入和模型资源读取 |
| [vtuber-runtime-recolor](outputs/vtuber-runtime-recolor/src/core-reader.ts) | 现有模型与外部 Cubism Core 的读取工具 |
| [vtuber-controlled-recolor](outputs/vtuber-controlled-recolor/src/files.ts) | 路径、文件、图像与配置辅助工具 |

源码中的设置服务校验 JSON、来源和会话令牌，设置带版本保存，异常配置回退默认值。输出服务在开始后传递六个角色参数，失联或停止时恢复默认姿势。原型按单机、单人、前台控制页范围实现，后台切换会停止追踪或输出。

## 本地准备与启动

需要 Windows、Node.js 24 或更新版本、pnpm、Microsoft Edge，以及按需使用的摄像头和 OBS。查看 [MediaPipe 与 Live2D 的第三方依赖记录](outputs/vtuber-camera-tracking/THIRD_PARTY_NOTICES.md)。

在仓库根目录安装所需 npm 依赖。以下命令需要网络，由使用者在本机执行。

```powershell
pnpm --dir outputs/vtuber-controlled-recolor install --frozen-lockfile --ignore-scripts
pnpm --dir outputs/vtuber-camera-tracking install --frozen-lockfile --ignore-scripts
node outputs/vtuber-camera-tracking/scripts/download-model.mjs
```

追踪下载器使用官方来源并核对 [模型锁定信息](outputs/vtuber-camera-tracking/models/model-lock.json)。仓库保留版本与哈希信息，模型二进制由本机下载。

完整画面运行还需要处理这些现有约定。

- 外部 Live2D Cubism SDK 保持在仓库外，原型按 SDK 5-r.5 / Core 6.0.1 接入。需要使用者接受适用的官方许可并自行取得 SDK。
- `vtuber-local-preview/src/server.ts` 中的 `defaultSdk`、`originalRoot` 和 `modelPresets` 保留原开发机路径及模型名称。需对应本机合法模型设置，原版同时读取原始、紫色、红色、绿色和金色预设。
- 追踪服务启动时校验 `vtuber-local-preview/releases/local-preview-v0.1/implementation-fingerprints.json` 中的预览器文件。更换预览器代码或本机路径后，需要复核这份基线并重新检查相应行为。保留的哈希对应原始源码，不表示迁移后的环境已经验收。
- 两个换色模块的 `config` 是历史本机流程配置。个人根路径已改成示例值，其他相对引用仍指向当时的模型快照、图层清单和生成目录。这些材料需要使用者自行准备，换色集成脚本也需要对应的本机输入。
- 历史验证脚本中仍有原开发机路径和保护目录约定。它们可用于阅读当时的检查方法，移植后需要逐项核对再运行。

完成配置后，从根目录启动 OBS 控制页。

```powershell
node outputs/vtuber-obs-output/src/server.ts --open
```

控制页中手动开启摄像头、校准，再选择开始输出。OBS 使用浏览器源打开 `http://127.0.0.1:43127/obs/output`。保持控制页在前台，用完关闭网页并在 Node 窗口按 Ctrl+C 停止本地服务。

## 验证范围

测试源码保留在各模块的 `tests` 目录。可以先运行独立的状态协议和前端控制测试，检查输出参数、序号、连接与停止行为。

```powershell
node --test outputs/vtuber-obs-output/tests/state.test.mjs outputs/vtuber-obs-output/tests/controller.test.mjs
```

发布准备时已在这份源码副本执行上述命令，72 项通过，覆盖状态协议和浏览器控制模拟。

设置、HTTP、完整渲染及换色的集成检查涉及外部 SDK、模型预设、历史保护目录或指纹基线，需要完整配置。旧开发机的手动反馈与测试次数不作为这个源码副本的新验收结果。相机效果、OBS 显示和设置重启恢复仍应在目标机器实际操作检查。

仓库内容为项目自有代码和依赖元数据。SDK/Core、纹理、角色模型、用户个人设置、运行生成物和人工截图由本地工作目录保管。各第三方依赖按其自身许可使用。

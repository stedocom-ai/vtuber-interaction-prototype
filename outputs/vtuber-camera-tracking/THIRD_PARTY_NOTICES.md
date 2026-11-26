# 第三方依赖记录（本机验证）

## MediaPipe

开发期于 2026-09-16 从官方 npm 包下载 `@mediapipe/tasks-vision@0.10.35`，为这次接口兼容性固定的版本，不宣称是最新版本。包元数据声明 Apache-2.0。项目没有修改该依赖包。

- 官方仓库及许可：https://github.com/google-ai-edge/mediapipe / https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE
- 官方 Web 指南：https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js
- 官方模型说明：https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker
- npm：https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.35
- 锁定 tarball 完整性：`sha512-HOvadwVRE6JC+45nyYhmnywnr5h/J8KZvOeUNVOG9q/0875pZgItznFB9bRTvLc264YSJqiZ1NsIpCStJw/egg==`。

Face Landmarker 模型包：3,758,596 字节，SHA-256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`。初次下载的官方 latest 来源及对象 generation 保留在 `models/model-lock.json`；后续下载器改用 `float16/1` 版本路径并核对同一 SHA-256，不更改已经下载的文件。

官方模型卡声明 Apache-2.0：

- [BlazeFace Short Range](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf)
- [Face Mesh V2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf)
- [Blendshape V2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf)

模型仅用于单人动作驱动；不作身份识别、医学或其他高风险决策。光照、遮挡和姿态会影响结果。包内 WASM 为依赖的一部分，本轮只在开发机运行，不制作发行安装包。未来分发前需附完整 Apache 2.0 许可文本及适用的版权/NOTICE，重新核对每项模型和依赖的分发要求；本记录不代替发行许可审查。

矩阵列主序依据：[MatrixData proto](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/framework/formats/matrix_data.proto)。参数映射是本项目实验实现，不是 Live2D 或 MediaPipe 对追踪方向/精度的认证。

## Live2D

继续遵守用户已接受的官方许可。SDK 5-r.5 / Cubism Core 6.0.1 仅作为外部只读依赖，位于 `D:\live 2D\CubismSdkForWeb\CubismSdkForWeb-5-r.5`。

不复制 SDK、Core、Framework 或 shaders 到本项目、outputs、测试夹具或 Git；浏览器通过本机服务获得 no-store 响应，Framework 转换只在内存完成。具体 SDK 自带 README/LICENSE/NOTICE 信息沿用已验收预览器的读取和审计记录。本原型通过不代表产品发行授权已完成。

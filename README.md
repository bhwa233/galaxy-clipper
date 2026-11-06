# Galaxy Clipper

独立的 Electron 剪辑客户端。复用 Galaxy 已有的字幕、ASR、云端选片、草稿、FFmpeg 和实时封面实现；不启动或依赖下载器、AutoClip，不提供发布功能。

```sh
pnpm install
pnpm dev
```

开发要求 Node.js 24、pnpm 11 和 Python 3.12+。媒体引擎仅使用 Python 标准库；本地 ASR 使用 sherpa-onnx-node。pnpm engine:dev 准备本项目的 Python 环境、FFmpeg 和字体。

`pnpm check` 执行类型检查、lint和构建。此阶段不新增正式测试规格，真实客户端验证记录见 docs/test-links.md。

推送到 `main` 后，GitHub Actions 会先运行 `pnpm check`；当 `package.json` 中的版本尚无同名标签、且 `docs/releases/<版本>.md` 有发布说明时，再分别构建 Windows、macOS、Linux 安装包，全部成功后创建同版本 GitHub Release。仅需构建验证时不修改版本号；要发布新版本时同时更新版本号和发布说明。0.x 构建作为未经签名的开发预览发布。

应用身份为 com.bhwa233.galaxy-clipper；默认数据保存在系统应用数据目录的 galaxy-clipper 下，与下载器隔离。原片只引用、不覆盖。通过“导入旧项目”显式选择旧数据目录及项目，不自动发现/读取下载器资料或密钥；已有模型可通过设置导入。

规划和进度见 docs/TODO.md。AGPL-3.0-only；复用模块中的 VidBee / AutoClip MIT 说明随源码保留。

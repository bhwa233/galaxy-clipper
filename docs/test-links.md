# Galaxy Clipper 验证记录

验证日期：2026-11-05（Asia/Shanghai）

## 自动检查

- `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`：通过。
- `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit`：通过。
- `node node_modules/eslint/bin/eslint.js .`：通过。
- `node node_modules/vite/bin/vite.js build`：通过；同时生成 renderer、Electron main 和 preload 构建产物。
- `node node_modules/vite/bin/vite.js build --config vite.processing.config.ts`：通过。
- `pnpm check`：通过（已在 `pnpm-workspace.yaml` 明确允许 `electron-winstaller` 和 `ffmpeg-static` 构建脚本）。
- `.venv/Scripts/python.exe engine/main.py` 输入 `{"operation":"version"}`：返回 `{"version":"clipper-1"}`。

## Electron 启动探针

- 使用本项目 dev server 和本地 Electron 44.4.5 启动真实窗口，主进程完成媒体引擎 `version` 请求。
- 首屏显示独立的 Galaxy Clipper 三栏工作台：左侧素材/工具，中间固定原片预览，右侧属性；没有底部时间线区域。
- 打开“设置”后可看到常规、模型、云端三个区段，输出目录显示为新客户端独立目录，页面明确提示原片只引用、密钥在本机独立保存。
- 用临时 2 秒 MP4 验证了导入入口会进入主进程文件选择流程；未把临时媒体或运行时目录留在项目中。

## 尚未完成的实测

- 当前课程素材的完整链路（导入 → 字幕 → AI 候选 → 多草稿 → 预览 → 成片/封面导出）仍待下一轮在用户指定素材上验证。
- 远端转写未执行；需要用户明确服务地址和允许上传音频后再验证。
- 下载器剪辑入口已在独立下载器项目的 0.8.0 中清理，下载器现有门禁已通过。

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

## 自动构建与开发预览发布

验证日期：2026-11-06（Asia/Shanghai）

- 本机 Windows：`pnpm check` 通过；`pnpm engine:build` 与 `pnpm exec electron-builder --publish never` 通过，生成 x64 NSIS 安装包。
- GitHub Actions [运行 42176515966](https://github.com/bhwa233/galaxy-clipper/actions/runs/42176515966)：`verify`、Windows、macOS、Linux 构建及 Release 任务全部成功，基于提交 `924575aea5c587057def0ce5ba81cd4f6069f679`。
- [0.1.0 开发预览](https://github.com/bhwa233/galaxy-clipper/releases/tag/0.1.0) 已发布 Windows x64 NSIS、macOS arm64 DMG 和 Linux x64 AppImage。
- 该发布未验证课程素材完整流程、远端转写或云端服务；三个平台安装包尚未逐一进行安装后运行验收。

## 平台字幕与字幕视频导出（自下载器 0.8.0 迁入）

验证日期：2026-11-06（Asia/Shanghai）

- 下载器 0.8.0 对 processing `service.ts`、`pipeline-sherpa.ts`、`worker.ts` 和 `engine.ts` 的修复（导出/关闭等待、原片签名校验、VAD 静音段不送识别、分块清单 v2 键、taskkill 等待进程树结束）本项目已包含，无需再迁。
- `pnpm check`：通过。`pnpm engine:dev` 现会按 `engine/requirements.txt` 安装 `yt-dlp[default]==2026.8.19`；`pnpm engine:build` 增加 `--collect-all yt_dlp yt_dlp_ejs`（本轮未重新打包安装包）。
- 引擎直接调用 `captions`：<https://www.youtube.com/watch?v=jNQXAC9IVRw> 取回人工英文字幕 1 轨；YouTube 在本机网络对默认客户端要求 PO Token，自动翻译字幕被丢弃，因此该视频没有中文轨，这是平台限制而不是客户端错误。获取只需字幕，已设置 `ignore_no_formats_error`，媒体格式受限时不再中断。
- 真实客户端探针（Playwright 启动 Electron，隔离 `CLIENT_TEST_DATA`，仅替换系统文件对话框）：
  - 导入嵌入元数据的 `jNQXAC9IVRw.mp4`（AV1 + Opus），字幕页链接自动填入原视频地址；点击“获取平台字幕”得到 `Platform · en`；导出软字幕 MP4（mov_text，eng，标题 English）和烧录当前字幕 MP4（H.264 + AAC，截帧确认底部白字描边英文）。
  - 导入 TED 演讲 <https://www.youtube.com/watch?v=arj7oStGLkU>（14:04）：得到 `Platform · zh-CN`（人工）与 `Platform · en`（人工）两轨；软字幕 MP4 含 中文 / English / 中文 + English 三轨，双语轨为默认、语言标记 zho/eng；双语轨内容按时间扫描合成（中文在上、英文在下）；烧录中英双语 MP4 用时 98 秒，截帧确认中英两行 Noto Sans CJK SC Bold；界面导出中显示进度条与“约剩 0:45”。
  - 引擎直接验证软字幕 MKV：三条 subrip 轨，标题与默认轨正确。
- 探针中发现并修复三个原有界面问题：字幕页与剪辑页同级组件共用 `key`，切换工具后旧面板残留叠在网格里（界面错乱）；左右面板缺少纵向 flex，内容超出格子无法滚动；进度只更新摘要，打开的文档不刷新，进度条与剩余时间不动。修复后网格内只剩 3 个面板、控制台无重复 key 警告。
- 未验证：远端转写（按范围不测）；需要登录的平台字幕（客户端不带 Cookie）；各平台安装包内的 yt-dlp 打包结果。探针脚本与测试媒体已删除。

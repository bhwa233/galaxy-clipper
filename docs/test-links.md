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

## 流程化界面与风格库

验证日期：2026-11-06（Asia/Shanghai）

- `pnpm check`：通过。
- 真实客户端探针（Playwright 启动 Electron，隔离 `CLIENT_TEST_DATA`，只替换系统文件对话框；测试素材为 TED 演讲 arj7oStGLkU 与 jNQXAC9IVRw 的 360p 下载）：
  - 左侧六个步骤：导入前 4 个步骤置灰（`aria-disabled`）；导入后“下一步：字幕”可用；字幕获取完成后可进入导出，选片因无候选仍锁定。
  - 字幕页：两张字幕轨卡片显示“zh-CN 人工 316 条”“en 人工 315 条”；预览叠加当前字幕；选中字幕后预览下方出现编辑条（起点 / 终点设为当前、保存）；“生成真实帧”返回实际烧录的一帧。
  - 新建自定义字幕风格（字号 8%、黄色）并设为素材默认风格；导出页默认沿用，双语模式列出“中文 zh-CN 人工 / 英文 en 人工”；软字幕 MP4 含 中文 / English / 中文 + English 三轨；另一素材用自定义风格烧录当前轨，截帧确认黄色大字。
  - 设置 → 风格库：新建自定义封面风格（游戏高光版式、自定义颜色、标题 1.2 倍）并保存，删除时提示使用情况，删除后列表移除。
  - 全程控制台无错误。
- 引擎直接验证：`caption-frame` 输出综艺风格中英双语帧；`clip-render` 用底框风格渲染竖屏模糊背景草稿，长句按两行换行。
- 探针中发现并修复：下一步栏与属性栏共享网格单元时自动排布把面板挤到新行（改为每个面板固定列）；侧边抽屉宽度被组件默认 `max-w-sm` 覆盖；空任务卡留下空白条。
- 未验证：AI 选片、草稿页与封面页的实际操作（需要云端文字模型配置，本轮未配置）；封面 JPG 导出；远端转写（按范围不测）。探针脚本与测试媒体已删除。

## 命令行 `clipper`

验证日期：2026-11-06（Asia/Shanghai）

- `pnpm check`：通过，同时产出 `dist-electron/cli/clipper.mjs`。
- 用隔离数据目录和 `CLIPPER_SOCKET` 启动一个 `--background` 客户端（不显示窗口），用构建出的 CLI 跑完整流程：
  - `status`：显示版本、引擎就绪、输出目录、字幕语言、“AI 选片未配置”。
  - `media import` 导入两个 YouTube 下载文件，`--json` 返回 id、时长、来源链接；`media list` 列出两项。
  - `subtitles fetch` 自动使用元数据里的链接：TED 得到 zh-CN（人工 316 条）、en（人工 315 条），jNQXAC9IVRw 得到 en；`subtitles use … en`、`subtitles show --limit 3`、`subtitles style … variety` 均生效；`styles list` / `styles show classic` 正常。
  - `export captions` 写出 SRT；`export video --captions bilingual --method soft` 写出 MKV（zho / eng / zho 默认三条字幕轨）；`export video --method burn --style large` 写出 MP4，截帧确认大字风格。
  - 失败路径：输出文件已存在 → 退出码 1；无中英双语轨 → 2；未配置云端模型执行 `analyze` → 2；无候选执行 `drafts create` → 2；模型未安装执行 `subtitles recognize --wait` → 2；未知素材 → 1；通道地址不可达 → 4。
- 未验证：安装版的命令注册与 PATH 写入（开发实例按设计不改 PATH，本轮未打包安装）；`analyze`、`drafts set`、`export clip`、`export cover` 的成功路径（需要云端文字模型配置）；客户端未运行时由安装版启动器自动后台启动。探针数据已删除。

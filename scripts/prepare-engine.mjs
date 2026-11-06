import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, copyFileSync } from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..'), windows = process.platform === 'win32'
const python = path.join(root, '.venv', windows ? 'Scripts/python.exe' : 'bin/python')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status) process.exit(result.status)
}
if (!existsSync(python)) run(windows ? 'python' : 'python3', ['-m', 'venv', '.venv'])
// yt-dlp fetches platform subtitle files for the `captions` operation; the rest of the engine is stdlib.
run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', 'engine/requirements.txt'])
const directory = path.join(root, 'resources/engine')
mkdirSync(directory, { recursive: true })
copyFileSync(path.join(root, 'node_modules/ffmpeg-static', windows ? 'ffmpeg.exe' : 'ffmpeg'), path.join(directory, windows ? 'ffmpeg.exe' : 'ffmpeg'))
cpSync(path.join(root, 'engine/fonts'), path.join(directory, 'fonts'), { recursive: true })
if (process.argv.includes('--bundle')) {
  run(python, ['-m', 'pip', 'install', 'pyinstaller'])
  run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--name', 'media-engine', '--collect-all', 'yt_dlp', '--collect-all', 'yt_dlp_ejs', '--distpath', 'resources/engine', '--workpath', 'engine-build/work', '--specpath', 'engine-build', 'engine/main.py'])
}

import { BrowserWindow, nativeImage, session } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { coverSettingsSchema, type Draft } from '../../../shared/clipping'
import { clipError } from './cloud'
import { coverArtworkHTML, coverDimensions, layoutCoverArtwork } from '../../../shared/cover-artwork'

// Adapted from AutoClip's MIT cover styles, palettes and editorial layout.
// Reuse bundled FFmpeg/fonts and Electron's Chromium/NativeImage. The downloader's
// cover validator only checks downloaded images; Pillow, a canvas package or an
// image SDK would duplicate the installed renderer. No AutoClip runtime is used.
export async function readCoverFrame(ffmpeg: string, input: string, frameMs: number, signal: AbortSignal) {
  const { stdout } = await promisify(execFile)(ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(frameMs / 1000), '-i', input, '-frames:v', '1', '-vf', "scale=w='min(1920,iw)':h=-2", '-q:v', '2', '-f', 'image2pipe', 'pipe:1'], { windowsHide: true, signal, timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' })
  const dimensions = nativeImage.createFromBuffer(stdout).getSize()
  if (!stdout.length || !dimensions.width || !dimensions.height) throw clipError('coverFrame')
  return { data: stdout, ...dimensions }
}
export async function renderCover(ffmpeg: string, input: string, frameMs: number, draft: Draft, directory: string, videoSize: { width: number; height: number } | undefined, signal: AbortSignal) {
  const settings = coverSettingsSchema.parse(draft.settings.cover || {})
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)])
  requestSignal.throwIfAborted()
  const frame = path.join(directory, 'frame.jpg')
  const imageFrame = await readCoverFrame(ffmpeg, input, frameMs, requestSignal)
  await writeFile(frame, imageFrame.data, { flag: 'wx' })
  const dimensions = videoSize || imageFrame
  const { width, height } = coverDimensions(settings.aspect, dimensions)
  const font = path.join(path.dirname(ffmpeg), 'fonts', 'NotoSansCJKsc-Bold.otf')
  await readFile(font)
  const portrait = height > width
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; font-src file:; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body>${coverArtworkHTML('export', settings, width, height, draft.settings.cropX, 'frame.jpg', pathToFileURL(font).href)}</body></html>`
  const file = path.join(directory, 'cover.html')
  await writeFile(file, html, { flag: 'wx' })
  const partition = session.fromPartition('cover-' + path.basename(directory), { cache: false })
  partition.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }))
  partition.setPermissionRequestHandler((_contents, _permission, done) => done(false))
  const window = new BrowserWindow({ width, height, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  // Windows clamps a new hidden window to the display's work area. Resize the
  // content after creation so portrait covers use a real portrait viewport.
  window.setContentSize(width, height)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const abort = () => { if (!window.isDestroyed()) window.destroy() }
  requestSignal.addEventListener('abort', abort, { once: true })
  try {
    await window.loadFile(file)
    // Electron's in-process debugger captures the document's actual layout. Its
    // fixed private commands are not exposed through IPC or a debugging port.
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    requestSignal.throwIfAborted()
    const text = { title: settings.title || draft.title, subtitle: settings.subtitle, badge: settings.badge, portrait, style: settings.style, height }
    // User strings reach textContent through JSON; they never become HTML or CSS.
    const fit = await window.webContents.executeJavaScript(`(${layoutCoverArtwork.toString()})(document.querySelector('[data-cover-artwork="export"]'), ${JSON.stringify(text)})`)
    if (!fit) throw clipError('coverText')
    requestSignal.throwIfAborted()
    const image = await window.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 92, fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }) as { data: string }
    const data = Buffer.from(image.data, 'base64'), captured = nativeImage.createFromBuffer(data)
    const capturedSize = captured.getSize()
    if (capturedSize.width !== width || capturedSize.height !== height) throw clipError('coverCanvas')
    if (!data.length || captured.isEmpty()) throw clipError('coverFrame')
    return { data, width, height }
  } finally {
    requestSignal.removeEventListener('abort', abort)
    if (!window.isDestroyed() && window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    if (!window.isDestroyed()) window.destroy()
  }
}

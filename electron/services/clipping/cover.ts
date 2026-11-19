import { BrowserWindow, nativeImage, session } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { coverSettingsSchema, type Draft } from '../../../shared/clipping'
import { coverDefaults, type CoverStyleParams } from '../../../shared/styles'
import { clipError } from './cloud'
import { coverArtworkHTML, coverDimensions, layoutCoverArtwork } from '../../../shared/cover-artwork'

// Adapted from AutoClip's MIT cover styles, palettes and editorial layout.
// Reuse bundled FFmpeg/fonts and Electron's Chromium/NativeImage. The downloader's
// cover validator only checks downloaded images; Pillow, a canvas package or an
// image SDK would duplicate the installed renderer. No AutoClip runtime is used.
export async function readCoverFrame(ffmpeg: string, input: string, frameMs: number, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(30000)
  try {
    const { stdout } = await promisify(execFile)(ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(frameMs / 1000), '-i', input, '-frames:v', '1', '-vf', "scale=w='min(1920,iw)':h=-2", '-q:v', '2', '-f', 'image2pipe', 'pipe:1'], { windowsHide: true, signal: AbortSignal.any([signal, timeout]), maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' })
    const dimensions = nativeImage.createFromBuffer(stdout).getSize()
    if (!stdout.length || !dimensions.width || !dimensions.height) throw clipError('coverFrame')
    return { data: stdout, ...dimensions }
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) throw clipError('coverFrameTimeout')
    throw error
  }
}
export async function renderCover(ffmpeg: string, input: string, frameMs: number, draft: Draft, coverStyle: CoverStyleParams | undefined, directory: string, videoSize: { width: number; height: number } | undefined, signal: AbortSignal) {
  const settings = coverSettingsSchema.parse(draft.settings.cover || {})
  const look = coverStyle || coverDefaults.knowledge
  const timeout = AbortSignal.timeout(45000)
  const requestSignal = AbortSignal.any([signal, timeout])
  let timeoutKey = 'coverFrameTimeout'
  let window: BrowserWindow | undefined
  const aborted = Promise.withResolvers<never>()
  const abort = () => aborted.reject(requestSignal.reason)
  try {
    const imageFrame = await readCoverFrame(ffmpeg, input, frameMs, requestSignal)
    await writeFile(path.join(directory, 'frame.jpg'), imageFrame.data, { flag: 'wx', signal: requestSignal })
    timeoutKey = 'coverLayoutTimeout'
    const { width, height } = coverDimensions(settings.aspect, videoSize || imageFrame)
    const font = path.join(path.dirname(ffmpeg), 'fonts', 'NotoSansCJKsc-Bold.otf')
    await readFile(font, { signal: requestSignal })
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; font-src file:; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body>${coverArtworkHTML('export', { params: look, palette: settings.palette }, width, height, draft.settings.cropX, 'frame.jpg', pathToFileURL(font).href)}</body></html>`
    const file = path.join(directory, 'cover.html')
    await writeFile(file, html, { flag: 'wx', signal: requestSignal })
    requestSignal.throwIfAborted()
    const partition = session.fromPartition('cover-' + path.basename(directory), { cache: false })
    partition.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }))
    partition.setPermissionRequestHandler((_contents, _permission, done) => done(false))
    const surface = window = new BrowserWindow({ width, height, useContentSize: true, show: false, focusable: false, skipTaskbar: true, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    // Windows clamps a new hidden window to the display's work area. Resize the
    // content after creation so portrait covers use a real portrait viewport.
    surface.setContentSize(width, height)
    surface.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    surface.webContents.on('will-navigate', event => event.preventDefault())
    requestSignal.addEventListener('abort', abort, { once: true })
    const image = await Promise.race([aborted.promise, (async () => {
      await surface.loadFile(file)
      const contents = surface.webContents
      contents.debugger.attach('1.3')
      await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      requestSignal.throwIfAborted()
      const text = { title: settings.title || draft.title, subtitle: settings.subtitle, badge: settings.badge, portrait: height > width, style: look.layout, height }
      // User strings reach textContent through JSON; they never become HTML or CSS.
      const fit = await contents.executeJavaScript(`(${layoutCoverArtwork.toString()})(document.querySelector('[data-cover-artwork="export"]'), ${JSON.stringify(text)})`)
      requestSignal.throwIfAborted()
      if (!fit) throw clipError('coverText')
      timeoutKey = 'coverCaptureTimeout'
      return contents.capturePage(undefined, { stayHidden: true })
    })()])
    requestSignal.throwIfAborted()
    if (image.isEmpty()) throw clipError('coverFrame')
    const size = image.getSize()
    if (size.width < width || size.height < height || Math.abs(size.height - size.width * height / width) > 2) throw clipError('coverCanvas')
    const artwork = size.width === width && size.height === height ? image : image.resize({ width, height, quality: 'best' })
    const data = artwork.toJPEG(92), captured = nativeImage.createFromBuffer(data)
    if (captured.isEmpty()) throw clipError('coverFrame')
    const capturedSize = captured.getSize()
    if (capturedSize.width !== width || capturedSize.height !== height) throw clipError('coverCanvas')
    return { data, width, height }
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) throw clipError(timeoutKey)
    throw error
  } finally {
    requestSignal.removeEventListener('abort', abort)
    if (window && !window.isDestroyed()) window.destroy()
  }
}

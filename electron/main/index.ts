import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { Controller } from './controller'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
app.setName('galaxy-clipper')
app.setPath('userData', !app.isPackaged && process.env.CLIENT_TEST_DATA || path.join(app.getPath('appData'), 'galaxy-clipper'))
app.setAppUserModelId('com.bhwa233.galaxy-clipper')
protocol.registerSchemesAsPrivileged([{ scheme: 'galaxy-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }])
const development = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined
const rendererUrl = development || pathToFileURL(path.join(root, 'dist/index.html')).href
let window: BrowserWindow | null = null, controller: Controller, quitting = false
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if(window) {window.restore(); window.show(); window.focus()} })
  void app.whenReady().then(async () => {
    controller = new Controller(() => window)
    protocol.handle('galaxy-media', async request => {
      try {
        if(!['GET','HEAD'].includes(request.method)) return new Response(null,{status:404})
        const url = new URL(request.url), source = url.hostname === 'processing' && /^\/[0-9a-f-]{36}$/.test(url.pathname)
        const clip = url.hostname === 'clipping' && url.pathname.match(/^\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/)
        const cover = url.hostname === 'cover' && url.pathname.match(/^\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/)
        const font = url.hostname === 'cover-font' && url.pathname === '/bold'
        if(!source && !clip && !cover && !font) return new Response(null,{status:404})
        const file = font ? controller.clippingCoverFont() : cover ? controller.clippingCover(cover[1],cover[2]) : clip ? controller.clippingMedia(clip[1],clip[2]) : controller.processingMedia(url.pathname.slice(1))
        const info = await stat(file), types:Record<string,string> = {'.jpg':'image/jpeg','.otf':'font/otf','.mp4':'video/mp4','.mkv':'video/x-matroska','.webm':'video/webm','.mov':'video/quicktime','.m4v':'video/mp4','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.ogg':'audio/ogg','.flac':'audio/flac'}
        const headers = new Headers({'Content-Type':types[path.extname(file).toLowerCase()] || 'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store'})
        if(font) {headers.set('Access-Control-Allow-Origin','*');headers.set('Cache-Control','public, max-age=86400')}
        const range = request.headers.get('range'), match = range?.match(/^bytes=(\d*)-(\d*)$/)
        let start=0,end=info.size-1
        if(range) {
          if(!match || !match[1] && !match[2]) return new Response(null,{status:416})
          start=match[1] ? Number(match[1]) : Math.max(0,info.size-Number(match[2])); end=match[1] && match[2] ? Math.min(end,Number(match[2])) : end
          if(!Number.isSafeInteger(start) || start>end || end<0) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}})
          headers.set('Content-Range',`bytes ${start}-${end}/${info.size}`)
        }
        headers.set('Content-Length',String(end-start+1))
        return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file,{start,end})) as ReadableStream<Uint8Array>,{status:range ? 206 : 200,headers})
      } catch { return new Response(null,{status:404}) }
    })
    ipcMain.handle('desktop:command',(event,name:unknown,input:unknown) => {
      if(!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== rendererUrl.split('#')[0]) return {ok:false,message:'Untrusted page'}
      return controller.command(name,input)
    })
    session.defaultSession.setPermissionRequestHandler((_contents,_permission,done) => done(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    window = new BrowserWindow({title:'Galaxy Clipper',width:1600,height:1000,minWidth:1100,minHeight:700,backgroundColor:'#171717',show:false,webPreferences:{preload:path.join(root,'dist-electron/preload/index.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}})
    window.setMenuBarVisibility(false)
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}))
    window.webContents.on('will-navigate',event => event.preventDefault())
    window.once('ready-to-show',() => window?.show())
    window.on('closed',() => {window=null})
    await window.loadURL(rendererUrl)
    await controller.initialize()
  }).catch(error => {console.error(error instanceof Error ? error.message : 'Startup failed');app.quit()})
}
app.on('window-all-closed',() => app.quit())
app.on('before-quit',event => {
  if(quitting || !controller) return
  event.preventDefault(); quitting=true
  void controller.stop().finally(() => app.quit())
})

import { app, BrowserWindow, dialog, net, shell } from 'electron'
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { commandSchemas, settingsSchema, type Settings, type Command, type ClientState, type Reply } from '../../shared/contracts'
import { legacyDocumentSchema, legacyProjectSchema } from '../../shared/project-import'
import { setLocale, i18n } from '../../shared/i18n'
import { Engine, redact } from '../services/engine'
import { ProcessingService } from '../services/processing/service'
import { CloudServices } from '../services/clipping/cloud'
import { RemoteTranscription } from '../services/clipping/transcription'
import { ClippingService } from '../services/clipping/service'
import { logger } from '../services/log'
const log = logger('clipper')
export class Controller {
  private directory = app.getPath('userData')
  private settingsFile = path.join(this.directory, 'settings.json')
  private settings: Settings = settingsSchema.parse(existsSync(this.settingsFile) ? JSON.parse(readFileSync(this.settingsFile, 'utf8')) : { outputDirectory: path.join(app.getPath('videos'), 'Galaxy Clips') })
  private engine = new Engine(app.getAppPath(), process.resourcesPath, app.isPackaged, () => this.settings.locale)
  private cloud = new CloudServices(path.join(this.directory, 'cloud'), () => this.emit())
  private remote = new RemoteTranscription(this.engine, this.cloud)
  private processing = new ProcessingService(path.join(this.directory, 'processing'), this.engine, app.getAppPath(), () => this.settings, (url, init) => net.fetch(url instanceof URL ? url.href : url, init), () => this.emit(), { snapshot: () => this.cloud.state().route === 'remote' ? this.cloud.snapshot('transcription') : undefined, run: (...args) => this.remote.run(...args) })
  private clipping = new ClippingService(path.join(this.directory, 'clipping'), this.processing, this.engine, this.cloud, () => this.emit(), () => ({ ...this.settings.clipDefaults, resolution: this.settings.outputResolution }))
  private tools: ClientState['tools'] = { engine: false, ffmpeg: false }
  private stopping = false
  constructor(private window: () => BrowserWindow | null) { setLocale(this.settings.locale) }
  state(): ClientState { return { settings: this.settings, processing: this.processing.state(), clipping: this.clipping.state(), tools: this.tools, version: app.getVersion() } }
  private emit(): void { const window = this.window(); if (window && !window.isDestroyed()) window.webContents.send('desktop:state', this.state()) }
  async initialize(): Promise<void> {
    try { await this.engine.request({operation:'version'}); this.tools = { engine: true, ffmpeg: existsSync(this.engine.ffmpeg) } }
    catch(error) { this.tools.error = redact(error instanceof Error ? error.message : String(error)) }
    this.emit()
  }
  private saveSettings(): void { mkdirSync(this.directory, { recursive: true }); writeFileSync(this.settingsFile + '.tmp', JSON.stringify(this.settings), {mode:0o600}); renameSync(this.settingsFile + '.tmp', this.settingsFile) }
  private async importProjects(): Promise<import('../../shared/processing').ProcessingDocument | undefined> {
    const chosen = await dialog.showOpenDialog(this.window()!, { title: '选择旧项目数据目录（包含 processing 与 clipping）', properties: ['openDirectory'] })
    if (chosen.canceled || !chosen.filePaths[0]) return
    const folder = chosen.filePaths[0], processingRoot = path.join(folder, 'processing')
    const ids = (await readdir(processingRoot)).filter(id => /^[0-9a-f-]{36}$/i.test(id))
    let first: import('../../shared/processing').ProcessingDocument | undefined
    for(const id of ids) {
      const file = path.join(processingRoot,id,'document.json')
      if ((await stat(file)).size > 32*1024*1024) throw new Error('Project metadata exceeds limit')
      const value = legacyDocumentSchema.parse(JSON.parse(await readFile(file,'utf8')))
      if(value.id !== id) throw new Error('Project identity mismatch')
      const projectFile = path.join(folder,'clipping',id,'project.json')
      let project: ReturnType<typeof legacyProjectSchema.parse> | undefined
      if(existsSync(projectFile)) {
        if((await stat(projectFile)).size > 32*1024*1024) throw new Error('Project metadata exceeds limit')
        project = legacyProjectSchema.parse(JSON.parse(await readFile(projectFile,'utf8')))
        if(project.documentId !== id) throw new Error('Project identity mismatch')
      }
      const imported = await this.processing.importSnapshot(value)
      try { if(project) this.clipping.importSnapshot(imported.id, project) }
      catch(error) { this.processing.remove(imported.id); throw error }
      first ||= imported
    }
    if(!first) throw new Error('没有找到可导入的项目')
    return first
  }
  async command(name: unknown, raw: unknown): Promise<Reply> {
    let document: import('../../shared/processing').ProcessingDocument | undefined
    let clipProject: import('../../shared/clipping').ClipProject | undefined
    let cloudConnection: import('../../shared/clipping').CloudConnection | undefined
    try {
      if(this.stopping) throw new Error('Application is closing')
      if(typeof name !== 'string' || !Object.hasOwn(commandSchemas,name)) throw new Error('Unsupported command')
      const command = name as Command, input = commandSchemas[command].parse(raw)
      switch(command) {
        case 'state:get': return {ok:true,state:this.state()}
        case 'settings:save': this.settings = settingsSchema.parse(input); this.saveSettings(); setLocale(this.settings.locale); break
        case 'settings:directory': {
          const chosen = await dialog.showOpenDialog(this.window()!, {properties:['openDirectory','createDirectory']})
          if(!chosen.canceled && chosen.filePaths[0]) {this.settings.outputDirectory = chosen.filePaths[0]; this.saveSettings()}
          break
        }
        case 'project:import': document = await this.importProjects(); break
        case 'models:import': {
          const chosen = await dialog.showOpenDialog(this.window()!, {title:'选择已有转写模型目录',properties:['openDirectory']})
          if(!chosen.canceled && chosen.filePaths[0]) await this.processing.models.importFrom(chosen.filePaths[0])
          break
        }
        case 'processing:import': {
          const chosen = await dialog.showOpenDialog(this.window()!, {properties:['openFile'],filters:[{name:'Media',extensions:['mp4','mkv','webm','mov','avi','m4v','ts','mp3','m4a','wav','flac','ogg','opus','aac']}]})
          if(!chosen.canceled && chosen.filePaths[0]) document = await this.processing.importFile(chosen.filePaths[0])
          break
        }
        case 'cloud:save': this.cloud.save(input); break
        case 'cloud:check': cloudConnection = await this.cloud.check(commandSchemas[command].parse(input).kind); break
        case 'clipping:get': clipProject = this.clipping.get(commandSchemas[command].parse(input).documentId); break
        case 'clipping:analyze': { const value = commandSchemas[command].parse(input); clipProject = await this.clipping.analyze(value.documentId, value.options, value.retryRunId); break }
        case 'clipping:create': { const value = commandSchemas[command].parse(input); clipProject = this.clipping.create(value.documentId, value.candidateIds, value.separate); break }
        case 'clipping:save': clipProject = this.clipping.saveDraft(input); break
        case 'clipping:duplicate': { const value = commandSchemas[command].parse(input); clipProject = this.clipping.duplicate(value.documentId, value.draftId, value.draft); break }
        case 'clipping:remove': { const value = commandSchemas[command].parse(input); clipProject = this.clipping.remove(value.documentId, value.draftId); break }
        case 'clipping:cancel': { const value = commandSchemas[command].parse(input); this.clipping.cancel(value.documentId, value.taskId); break }
        case 'clipping:cover': { const value = commandSchemas[command].parse(input); clipProject = this.clipping.cover(value.documentId, value.draftId, value.revision); break }
        case 'clipping:cover-frame': {
          const value = commandSchemas[command].parse(input)
          const coverFrame = await this.clipping.coverFrame(value.documentId, value.draftId, value.scenes, value.frameMs)
          return { ok: true, state: this.state(), coverFrame }
        }
        case 'clipping:cover-render': { const value = commandSchemas[command].parse(input); clipProject = this.clipping.coverForRender(value.documentId, value.taskId); break }
        case 'clipping:cover-export': {
          const value = commandSchemas[command].parse(input), project = this.clipping.get(value.documentId), cover = project.covers?.find(job => job.id === value.coverId)
          if (!cover) throw new Error(i18n.t('clipping:errors.notFound'))
          const file = this.clipping.coverMedia(value.documentId, value.coverId)
          const title = cover.snapshot.title.replace(/[<>:"/\\|?*]/g, '_')
          const selected = await dialog.showSaveDialog(this.window()!, { defaultPath: path.join(this.settings.outputDirectory, title + '.cover.jpg'), filters: [{ name: 'JPEG', extensions: ['jpg'] }] })
          if (!selected.canceled && selected.filePath) await writeFile(selected.filePath, await readFile(file), { flag: 'wx', mode: 0o600 })
          break
        }
        case 'clipping:render': {
          const value = commandSchemas[command].parse(input)
          if (value.preview) clipProject = await this.clipping.render(value.documentId, value.draftId, value.revision, true)
          else {
            const project = this.clipping.get(value.documentId), draft = project.drafts.find(item => item.id === value.draftId)
            if (!draft) throw new Error(i18n.t('clipping:errors.notFound'))
            const selected = await dialog.showSaveDialog(this.window()!, { defaultPath: path.join(this.settings.outputDirectory, draft.title.replace(/[<>:"/\\|?*]/g, '_') + '.clip.mp4'), filters: [{ name: 'MP4', extensions: ['mp4'] }] })
            if (!selected.canceled && selected.filePath) clipProject = await this.clipping.render(value.documentId, value.draftId, value.revision, false, selected.filePath)
          }
          break
        }
        case 'clipping:open': {
          const value = commandSchemas[command].parse(input), file = this.clipping.media(value.documentId, value.taskId)
          if (value.reveal) shell.showItemInFolder(file)
          else { const failure = await shell.openPath(file); if (failure) throw new Error(failure) }
          break
        }
        case 'clipping:captions': {
          const value = commandSchemas[command].parse(input), text = this.clipping.exportText(value.documentId, value.draftId, value.format)
          const selected = await dialog.showSaveDialog(this.window()!, { defaultPath: path.join(this.settings.outputDirectory, 'clip.' + value.format), filters: [{ name: value.format.toUpperCase(), extensions: [value.format] }] })
          if (!selected.canceled && selected.filePath) await writeFile(selected.filePath, text, { flag: 'wx', mode: 0o600 })
          break
        }
        case 'processing:get': document = this.processing.get(commandSchemas[command].parse(input).id); break
        case 'processing:run': {
          const value = commandSchemas[command].parse(input)
          document = this.processing.enqueue(value.id, value.action, value.model || this.settings.transcriptionModel, value.speakers ?? this.settings.transcriptionSpeakers); break
        }
        case 'processing:cancel': this.processing.cancel(commandSchemas[command].parse(input).id); break
        case 'processing:retry': document = this.processing.retry(commandSchemas[command].parse(input).id); break
        case 'processing:remove': {
          const { id } = commandSchemas[command].parse(input)
          if (this.clipping.isBusy(id)) throw new Error(i18n.t('clipping:errors.busy'))
          this.processing.remove(id); break
        }
        case 'processing:track': { const value = commandSchemas[command].parse(input); document = this.processing.switchTrack(value.id, value.trackId); break }
        case 'processing:edit': document = this.processing.edit(commandSchemas[command].parse(input)); break
        case 'processing:speaker': { const value = commandSchemas[command].parse(input); document = this.processing.speaker(value.id, value.speakerId, value.name); break }
        case 'processing:captions': {
          const { id } = commandSchemas[command].parse(input)
          const selected = await dialog.showOpenDialog(this.window()!, { properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'ass'] }] })
          if (!selected.canceled && selected.filePaths[0]) document = this.processing.importCaptions(id, selected.filePaths[0]); break
        }
        case 'processing:export': {
          const { id, format } = commandSchemas[command].parse(input), doc = this.processing.get(id)
          const ext = format === 'soft' || format === 'video' && this.settings.outputFormat === 'mkv' ? 'mkv' : ['burn', 'video'].includes(format) ? 'mp4' : format
          const selected = await dialog.showSaveDialog(this.window()!, { defaultPath: path.join(this.settings.outputDirectory, doc.title.replace(/[<>:"/\\|?*]/g, '_') + '.processed.' + ext), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
          if (!selected.canceled && selected.filePath) document = await this.processing.export(id, format, selected.filePath); break
        }
        case 'processing:open-export': { const value = commandSchemas[command].parse(input); const message = await shell.openPath(this.processing.exportPath(value.id, value.index)); if (message) throw new Error(message); break }
        case 'models:download': {
          const { id } = commandSchemas[command].parse(input)
          void this.processing.models.download(id).catch(error => log.warn('Model download failed', error)); break
        }
        case 'models:cancel': this.processing.models.cancel(commandSchemas[command].parse(input).id); break
        case 'models:remove': {
          const { id } = commandSchemas[command].parse(input)
          if (this.processing.modelInUse(id)) throw new Error('This model is used by a processing task')
          this.processing.models.remove(id); break
        }
      }
      this.emit(); return {ok:true,state:this.state(),document,clipProject,cloudConnection}
    } catch(error) { return {ok:false,message:redact(error instanceof Error ? error.message : String(error))} }
  }
  processingMedia(id: string): string {return this.processing.media(id)}
  clippingMedia(id:string,taskId:string):string {return this.clipping.media(id,taskId)}
  clippingCover(id:string,coverId:string):string {return this.clipping.coverMedia(id,coverId)}
  clippingCoverFont():string {return path.join(path.dirname(this.engine.ffmpeg),'fonts','NotoSansCJKsc-Bold.otf')}
  async stop():Promise<void> {this.stopping = true; await Promise.allSettled([this.clipping.stop(),this.processing.stop(),this.cloud.stop()])}
}

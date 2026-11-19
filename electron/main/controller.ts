import { app, BrowserWindow, dialog, net, shell } from 'electron'
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { commandSchemas, settingsSchema, type Settings, type Command, type ClientState, type Reply } from '../../shared/contracts'
import { legacyDocumentSchema, legacyProjectSchema } from '../../shared/project-import'
import { setLocale, i18n } from '../../shared/i18n'
import { Engine, redact } from '../services/engine'
import { ProcessingService } from '../services/processing/service'
import { CloudServices } from '../services/clipping/cloud'
import { RemoteTranscription } from '../services/clipping/transcription'
import { ClippingService } from '../services/clipping/service'
import { StyleLibrary } from '../services/styles'
import { ControlServer } from '../services/control'
import { CommandLine } from '../services/command-line'
import { controlAddress, cliCommands, type ControlReply } from '../../shared/control'
import { logger } from '../services/log'
const log = logger('clipper')
// Window commands the command line may also send: none of them opens a dialog or takes a path.
const CLI_FORWARDED = new Set(['state:get', 'processing:get', 'processing:run', 'processing:cancel', 'processing:retry', 'processing:remove', 'processing:platform', 'processing:track', 'processing:style', 'processing:edit', 'clipping:get', 'clipping:analyze', 'clipping:create', 'clipping:save', 'clipping:remove', 'clipping:cancel', 'clipping:cover', 'clipping:render'])
export class Controller {
  private directory = app.getPath('userData')
  private settingsFile = path.join(this.directory, 'settings.json')
  private settings: Settings = settingsSchema.parse(existsSync(this.settingsFile) ? JSON.parse(readFileSync(this.settingsFile, 'utf8')) : { outputDirectory: path.join(app.getPath('videos'), 'Galaxy Clips') })
  private engine = new Engine(app.getAppPath(), process.resourcesPath, app.isPackaged, () => this.settings.locale)
  private cloud = new CloudServices(path.join(this.directory, 'cloud'), () => this.emit())
  private remote = new RemoteTranscription(this.engine, this.cloud)
  private processing = new ProcessingService(path.join(this.directory, 'processing'), this.engine, app.getAppPath(), () => this.settings, (url, init) => net.fetch(url instanceof URL ? url.href : url, init), () => this.emit(), { snapshot: () => this.cloud.state().route === 'remote' ? this.cloud.snapshot('transcription') : undefined, run: (...args) => this.remote.run(...args) })
  private styles = new StyleLibrary(path.join(this.directory, 'styles.json'))
  private clipping = new ClippingService(path.join(this.directory, 'clipping'), this.processing, this.engine, this.cloud, () => this.emit(), () => ({ ...this.settings.clipDefaults, resolution: this.settings.outputResolution }), this.styles)
  private tools: ClientState['tools'] = { engine: false, ffmpeg: false }
  private stopping = false
  // `clipper`: the local channel and the command that drives it. Only the commands listed here are
  // reachable from it; the cli:* ones take explicit file paths and are never exposed to the window.
  private commandLine = new CommandLine(this.directory, app.getAppPath(), app.isPackaged, () => this.emit())
  private control = new ControlServer((name, input) => this.cliCommand(name, input))
  private controlError?: string
  private controlSync = Promise.resolve()
  constructor(private window: () => BrowserWindow | null) { setLocale(this.settings.locale) }
  state(): ClientState { return { settings: this.settings, processing: this.processing.state(), clipping: this.clipping.state(), styles: this.styles.state(), commandLine: { ...this.commandLine.state(), listening: this.control.listening, error: this.controlError || this.commandLine.state().error }, tools: this.tools, version: app.getVersion() } }
  private emit(): void { const window = this.window(); if (window && !window.isDestroyed()) window.webContents.send('desktop:state', this.state()) }
  async initialize(): Promise<void> {
    try { await this.engine.request({operation:'version'}); this.tools = { engine: true, ffmpeg: existsSync(this.engine.ffmpeg) } }
    catch(error) { this.tools.error = redact(error instanceof Error ? error.message : String(error)) }
    await this.syncControl()
    // Development builds never touch the user's PATH; an installed client keeps its launcher current.
    if (app.isPackaged) void this.commandLine.configure(this.settings.allowControl)
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
        case 'settings:save': {
          const previous = this.settings.allowControl
          this.settings = settingsSchema.parse(input); this.saveSettings(); setLocale(this.settings.locale)
          if (previous !== this.settings.allowControl) { await this.syncControl(); if (app.isPackaged) void this.commandLine.configure(this.settings.allowControl) }
          break
        }
        case 'commandLine:configure':
          if (!this.settings.allowControl) throw new Error(i18n.t('settings:tools.commandLine.enableFirst'))
          await this.syncControl(); await this.commandLine.configure(true); break
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
        case 'styles:save': this.styles.save(commandSchemas[command].parse(input)); break
        case 'styles:usage': { const value = commandSchemas[command].parse(input); return { ok: true, state: this.state(), usage: this.clipping.styleUsage(value.kind, value.id) + (value.kind === 'subtitle' ? this.processing.styleUsage(value.id) : 0) } }
        case 'styles:remove': {
          const value = commandSchemas[command].parse(input), base = this.styles.remove(value.kind, value.id)
          this.clipping.replaceStyle(value.kind, value.id, base)
          if (value.kind === 'subtitle') this.processing.replaceStyle(value.id, base)
          break
        }
        case 'processing:style': { const value = commandSchemas[command].parse(input); document = this.processing.setStyle(value.id, value.style); break }
        case 'processing:frame': {
          const value = commandSchemas[command].parse(input), doc = this.processing.get(value.id)
          const frame = await this.processing.frame(value.id, value.timeMs, { captions: value.captions, style: this.styles.subtitleParams(value.style || doc.subtitleStyle) })
          return { ok: true, state: this.state(), frame }
        }
        case 'processing:platform': { const value = commandSchemas[command].parse(input); document = await this.processing.platform(value.id, value.url, value.automatic); break }
        case 'processing:export': {
          const { id, draftId, format, captions, style } = commandSchemas[command].parse(input), doc = this.processing.get(id)
          const video = ['soft', 'burn', 'video'].includes(format), ext = video ? this.settings.outputFormat : format
          const title = (video && draftId ? this.clipping.get(id).drafts.find(draft => draft.id === draftId)?.title.trim() : undefined) || doc.title
          const selected = await dialog.showSaveDialog(this.window()!, { defaultPath: path.join(this.settings.outputDirectory, title.replace(/[<>:"/\\|?*]/g, '_') + '.processed.' + ext), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
          if (!selected.canceled && selected.filePath) document = await this.processing.export(id, format, selected.filePath, { captions, style: this.styles.subtitleParams(style || doc.subtitleStyle) }); break
        }
        case 'processing:open-export': {
          const value = commandSchemas[command].parse(input), file = this.processing.exportPath(value.id, value.index)
          if (value.reveal) shell.showItemInFolder(file)
          else { const message = await shell.openPath(file); if (message) throw new Error(message) }
          break
        }
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
  processingExport(id: string, index: number): string {return this.processing.exportPath(id, index)}
  clippingMedia(id:string,taskId:string):string {return this.clipping.media(id,taskId)}
  clippingCover(id:string,coverId:string):string {return this.clipping.coverMedia(id,coverId)}
  clippingCoverFont(weight: 'bold' | 'regular' = 'bold'):string {return path.join(path.dirname(this.engine.ffmpeg),'fonts',weight === 'bold' ? 'NotoSansCJKsc-Bold.otf' : 'NotoSansCJKsc-Regular.otf')}
  /** Start or stop listening to follow the setting; serialized so quick toggles settle on the last one. */
  private syncControl(): Promise<void> {
    this.controlSync = this.controlSync.then(async () => {
      this.controlError = undefined
      if (this.settings.allowControl && !this.stopping && !this.control.listening) {
        try { await this.control.start(controlAddress(!app.isPackaged)) }
        catch { this.controlError = i18n.t('settings:tools.commandLine.channelFailed') }
      }
      if (this.stopping || !this.settings.allowControl) this.control.stop()
      this.emit()
    })
    return this.controlSync
  }
  /** Checks an output path the command line names: absolute, a new file, in an existing folder, of the right type. */
  private outputPath(file: string, extensions: string[]): string {
    const target = path.resolve(file)
    if (!path.isAbsolute(file) || existsSync(target)) throw new Error('Output must be a new absolute file path; existing files are never overwritten')
    if (!existsSync(path.dirname(target)) || !statSync(path.dirname(target)).isDirectory()) throw new Error('The output folder does not exist')
    if (!extensions.includes(path.extname(target).slice(1).toLowerCase())) throw new Error(`Output must end in .${extensions.join(' or .')}`)
    return target
  }
  async cliCommand(name: string, raw: unknown): Promise<Omit<ControlReply, 'id'>> {
    if (this.stopping) return { ok: false, message: 'Application is closing' }
    if (name === 'cli:hello') return { ok: true, state: this.state(), version: app.getVersion() }
    if (Object.hasOwn(cliCommands, name)) {
      try {
        const input = cliCommands[name as keyof typeof cliCommands].parse(raw) as Record<string, string>
        let document: import('../../shared/processing').ProcessingDocument | undefined, clipProject: import('../../shared/clipping').ClipProject | undefined
        switch (name) {
          case 'cli:media-import': document = await this.processing.importFile(path.resolve(input.file)); break
          case 'cli:captions-import': document = this.processing.importCaptions(input.id, path.resolve(input.file)); break
          case 'cli:export': {
            const value = cliCommands['cli:export'].parse(raw), doc = this.processing.get(value.id)
            const output = this.outputPath(value.output, ['soft', 'burn', 'video'].includes(value.format) ? ['mp4', 'mkv'] : [value.format])
            document = await this.processing.export(value.id, value.format, output, { captions: value.captions, style: this.styles.subtitleParams(value.style || doc.subtitleStyle) })
            break
          }
          case 'cli:clip-export': {
            const project = this.clipping.get(input.documentId), draft = project.drafts.find(item => item.id === input.draftId)
            if (!draft) throw new Error(i18n.t('clipping:errors.notFound'))
            clipProject = await this.clipping.render(input.documentId, draft.id, draft.revision, false, this.outputPath(input.output, ['mp4']))
            break
          }
          case 'cli:clip-captions': {
            const value = cliCommands['cli:clip-captions'].parse(raw)
            await writeFile(this.outputPath(value.output, [value.format]), this.clipping.exportText(value.documentId, value.draftId, value.format), { flag: 'wx', mode: 0o600 })
            break
          }
          case 'cli:cover-export':
            await writeFile(this.outputPath(input.output, ['jpg', 'jpeg']), await readFile(this.clipping.coverMedia(input.documentId, input.coverId)), { flag: 'wx', mode: 0o600 })
            break
        }
        this.emit(); return { ok: true, state: this.state(), document, clipProject }
      } catch (error) { return { ok: false, message: redact(error instanceof Error ? error.message : String(error)) } }
    }
    if (!CLI_FORWARDED.has(name)) return { ok: false, message: 'Unsupported command' }
    // Final renders choose a file in a dialog in the window; the command line uses cli:clip-export.
    if (name === 'clipping:render' && !(raw as { preview?: boolean } | undefined)?.preview) return { ok: false, message: 'Use cli:clip-export with an output path' }
    return this.command(name, raw)
  }
  async stop():Promise<void> {this.stopping = true; this.control.stop(); await Promise.allSettled([this.clipping.stop(),this.processing.stop(),this.cloud.stop()])}
}

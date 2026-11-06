import { legacyProjectSchema } from '../../../shared/project-import'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { link, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { analysisOptionsSchema, coverSettingsSchema, draftSaveSchema, draftSettingsSchema, type ClipProject, type CoverJob, type Draft, type RenderJob, type RenderedMedia, type TranscriptSnapshot, type ClippingState } from '../../../shared/clipping'
import type { Caption } from '../../../shared/processing'
import { Engine } from '../engine'
import { ProcessingService, exportCaptions } from '../processing/service'
import { analyzeWindow, analysisWindows, selectCandidates } from './analysis'
import { CloudServices, clipError, fingerprint } from './cloud'
import { logger } from '../log'
import { readCoverFrame, renderCover } from './cover'
import type { CoverFrame } from '../../../shared/clipping'

type StoredProject = ClipProject & { paths: Record<string, string> }
const log = logger('clipping')
const RENDERER_VERSION = 3
export class ClippingService {
  private projects = new Map<string, StoredProject>()
  private active = new Map<string, { documentId: string; controller: AbortController }>()
  private renderTail: Promise<void> = Promise.resolve()
  private draining = new Set<Promise<void>>()
  private reserved = new Map<string, string>()
  private frames = new Map<string, CoverFrame>()
  private frameRequests = new Map<string, Promise<CoverFrame>>()
  private frameAbort = new AbortController()
  private frameTail: Promise<unknown> = Promise.resolve()
  private version = 0
  private stopped = false
  constructor(private directory: string, private processing: ProcessingService, private engine: Engine, readonly cloud: CloudServices, private changed: () => void, private defaults: () => Omit<Draft['settings'], 'title'> = () => draftSettingsSchema.parse({})) {}
  state(): ClippingState { return { version: this.version, settings: this.cloud.state() } }
  private signature(id: string): string {
    try { const file = this.processing.media(id), info = statSync(file); return fingerprint([file, info.size, info.mtimeMs]) } catch { throw clipError('sourceChanged') }
  }
  private file(id: string): string { return path.join(this.directory, id, 'project.json') }
  private require(id: string): StoredProject {
    this.processing.get(id)
    let project = this.projects.get(id)
    if (project) return project
    const file = this.file(id)
    if (existsSync(file)) {
      const value = JSON.parse(readFileSync(file, 'utf8')) as StoredProject
      if (value.schemaVersion !== 1 || value.documentId !== id || !Array.isArray(value.drafts) || !Array.isArray(value.runs) || !Array.isArray(value.renders)) throw clipError('response')
      project = value
      project.covers ||= []
      let interrupted = false
      for (const task of [...project.runs, ...project.renders, ...project.covers]) if (task.status === 'running' || task.status === 'queued') { task.status = 'interrupted'; task.error = clipError('interrupted').message; interrupted = true }
      let indexed = false
      for (const run of project.runs) if (!Array.isArray(run.candidateIds) || run.status === 'interrupted') {
        const selected = selectCandidates(run.windows.filter(window => window.status === 'completed').flatMap(window => window.candidates), run.options.count)
        run.candidateIds = selected.map(candidate => candidate.id)
        for (const candidate of selected) if (!project.candidates.some(value => value.id === candidate.id)) project.candidates.push(candidate)
        indexed = true
      }
      this.projects.set(id, project)
      if (interrupted || indexed) this.save(project)
      for (const job of [...project.renders, ...project.covers].filter(value => value.status !== 'completed')) {
        const restored = project
        this.renderTail = this.renderTail.then(() => this.cleanupRender(restored, job)).catch(() => { log.warn('Could not clean interrupted clip task ' + job.id) })
      }
    } else {
      project = { schemaVersion: 1, documentId: id, sourceSignature: this.signature(id), transcripts: [], runs: [], candidates: [], drafts: [], renders: [], paths: {}, updatedAt: new Date().toISOString() }
      this.projects.set(id, project)
    }
    return project
  }
  get(id: string): ClipProject {
    const value = structuredClone(this.require(id)) as Partial<StoredProject> & ClipProject
    delete value.paths
    return value
  }
  importSnapshot(id: string, input: unknown): ClipProject {
    const value = legacyProjectSchema.parse(input), project: StoredProject = { ...value, documentId:id, sourceSignature:this.signature(id), paths:{} }
    // Drafts and transcripts transfer. Generated files stay with the old client;
    // imported history is explicitly unavailable until rendered again here.
    for(const job of [...project.renders,...(project.covers || [])]) {job.status='interrupted'; job.error='历史输出保留在原目录，请在此重新生成。'}
    for(const run of project.runs) if(run.status === 'queued' || run.status === 'running') {run.status='interrupted';run.error=clipError('interrupted').message}
    for(const draft of project.drafts) this.validate(project,draft)
    this.projects.set(id,project); this.save(project); return this.get(id)
  }
  private save(project: StoredProject): void {
    project.updatedAt = new Date().toISOString()
    const file = this.file(project.documentId); mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file + '.tmp', JSON.stringify(project), { mode: 0o600 }); renameSync(file + '.tmp', file)
    this.version++; this.changed()
  }
  private source(project: StoredProject): string {
    if (this.signature(project.documentId) !== project.sourceSignature) throw clipError('sourceChanged')
    return this.processing.media(project.documentId)
  }
  isBusy(id: string): boolean { return [...this.active.values()].some(value => value.documentId === id) }
  private transcript(project: StoredProject): TranscriptSnapshot {
    const doc = this.processing.get(project.documentId)
    const captions = doc.captions.filter(cue => cue.text.trim() && Number.isSafeInteger(cue.startMs) && Number.isSafeInteger(cue.endMs) && cue.startMs >= 0 && cue.endMs > cue.startMs).sort((a, b) => a.startMs - b.startMs)
    if (!captions.length) throw clipError('empty')
    const hash = fingerprint([doc.activeTrack, captions, doc.speakers, doc.language])
    const held = project.transcripts.find(value => value.fingerprint === hash)
    if (held) return held
    const value: TranscriptSnapshot = { id: randomUUID(), trackId: doc.activeTrack, revision: doc.revision, captions: structuredClone(captions), speakers: structuredClone(doc.speakers), language: doc.language, fingerprint: hash }
    project.transcripts.push(value)
    return value
  }
  async analyze(id: string, input: unknown, retryRunId?: string): Promise<ClipProject> {
    if (this.stopped || [...this.active.values()].some(value => value.documentId === id)) throw clipError('busy')
    if ([...this.active.keys()].filter(key => key.startsWith('analysis:')).length >= 2) throw clipError('busy')
    const project = this.require(id), inputFile = this.source(project)
    const media = await this.engine.request<{ durationSeconds: number; video: boolean }>({ operation: 'inspect', input: inputFile })
    if (this.stopped) throw clipError('busy')
    if (!media.video) throw clipError('videoOnly')
    if ([...this.active.values()].some(value => value.documentId === id)) throw clipError('busy')
    const options = analysisOptionsSchema.parse(input), provider = this.cloud.snapshot('analysis')
    if (!provider.baseUrl || !provider.model) throw clipError('config')
    const snapshot = this.transcript(project), key = fingerprint([snapshot.fingerprint, options, provider.baseUrl, provider.model, provider.contextChars, 'clip-v1'])
    let run = retryRunId ? project.runs.find(value => value.id === retryRunId) : project.runs.find(value => value.cacheKey === key && value.status === 'completed')
    if (run && run.cacheKey !== key) throw clipError('conflict')
    if (run && project.runs[0] !== run) {
      // The candidate workspace follows runs[0], including a restored cache or retry.
      project.runs.splice(project.runs.indexOf(run), 1)
      project.runs.unshift(run)
      if (run.status === 'completed') this.save(project)
    }
    if (run?.status === 'completed') return this.get(id)
    if (!run) {
      const publicProvider = { baseUrl: provider.baseUrl, model: provider.model, contextChars: provider.contextChars }
      run = { id: randomUUID(), transcriptId: snapshot.id, cacheKey: key, options, provider: publicProvider, windows: analysisWindows(snapshot, provider.contextChars), status: 'queued', createdAt: new Date().toISOString() }
      project.runs.unshift(run)
    }
    const task = run, controller = new AbortController(), taskKey = 'analysis:' + task.id
    this.active.set(taskKey, { documentId: id, controller }); task.status = 'running'; task.error = undefined
    this.save(project)
    const work = (async () => {
      try {
        for (const window of task.windows) {
          controller.signal.throwIfAborted()
          if (window.status === 'completed') continue
          try {
            window.candidates = await analyzeWindow(this.cloud, provider, snapshot, window, options, task.id, Math.round(media.durationSeconds * 1000), controller.signal)
            window.status = 'completed'; window.error = undefined
          } catch (error) {
            controller.signal.throwIfAborted()
            window.status = 'failed'; window.error = error instanceof Error ? error.message : clipError('response').message
          }
          this.save(project)
        }
        const done = task.windows.filter(window => window.status === 'completed').length
        task.status = done === task.windows.length ? 'completed' : done ? 'partial' : 'failed'
        task.error = task.windows.find(window => window.error)?.error
      } catch (error) {
        task.status = controller.signal.aborted ? 'cancelled' : 'failed'
        task.error = controller.signal.aborted ? undefined : error instanceof Error ? error.message : clipError('response').message
      } finally {
        const selected = selectCandidates(task.windows.filter(window => window.status === 'completed').flatMap(window => window.candidates), options.count)
        task.candidateIds = selected.map(candidate => candidate.id)
        // Keep IDs already referenced by edited drafts when retrying failed windows.
        for (const candidate of selected) if (!project.candidates.some(value => value.id === candidate.id)) project.candidates.push(candidate)
        this.active.delete(taskKey); this.save(project)
      }
    })().catch(() => { log.error('Could not persist clip analysis state') })
    this.draining.add(work)
    void work.then(() => { this.draining.delete(work) })
    return this.get(id)
  }
  create(id: string, candidateIds: string[], separate: boolean): ClipProject {
    const project = this.require(id); this.source(project)
    const candidates = candidateIds.map(candidateId => project.candidates.find(value => value.id === candidateId))
    if (candidates.some(value => !value) || new Set(candidates.map(value => value!.transcriptId)).size !== 1) throw clipError('candidate')
    const groups = separate ? candidates.map(value => [value!]) : [candidates.map(value => value!)]
    for (const group of groups) {
      const draft: Draft = { id: randomUUID(), title: group[0].title, revision: 0, transcriptId: group[0].transcriptId, scenes: group.map(value => ({ id: randomUUID(), candidateId: value.id, startMs: value.startMs, endMs: value.endMs })), settings: draftSettingsSchema.parse(this.defaults()), updatedAt: new Date().toISOString() }
      this.validate(project, draft); project.drafts.unshift(draft)
    }
    this.save(project); return this.get(id)
  }
  private validate(project: StoredProject, draft: Draft): void {
    const durationMs = this.processing.get(project.documentId).durationSeconds * 1000
    if (draft.scenes.reduce((sum, scene) => sum + scene.endMs - scene.startMs, 0) > 1800000) throw clipError('range')
    const frameMs = draft.settings.cover?.frameMs
    if (frameMs !== undefined && draft.scenes.length && !draft.scenes.some(scene => scene.startMs <= frameMs && scene.endMs > frameMs)) throw clipError('coverRange')
    for (const scene of draft.scenes) {
      if (!project.candidates.some(value => value.id === scene.candidateId && value.transcriptId === draft.transcriptId)) throw clipError('candidate')
      if (scene.endMs > durationMs || scene.endMs <= scene.startMs || scene.startMs < 0) throw clipError('range')
    }
  }
  saveDraft(input: unknown): ClipProject {
    const value = draftSaveSchema.parse(input), project = this.require(value.documentId); this.source(project)
    const index = project.drafts.findIndex(draft => draft.id === value.id), previous = project.drafts[index]
    if (!previous) throw clipError('notFound')
    if (previous.revision !== value.revision) throw clipError('conflict')
    const draft: Draft = { ...previous, title: value.title, scenes: value.scenes, settings: value.settings, revision: previous.revision + 1, updatedAt: new Date().toISOString() }
    this.validate(project, draft); project.drafts[index] = draft
    this.save(project); return this.get(value.documentId)
  }
  duplicate(id: string, draftId: string, input?: unknown): ClipProject {
    const project = this.require(id), value = project.drafts.find(draft => draft.id === draftId)
    if (!value) throw clipError('notFound')
    const patch = input ? draftSaveSchema.parse(input) : undefined
    if (patch && (patch.id !== draftId || patch.documentId !== id)) throw clipError('notFound')
    const draft: Draft = { ...structuredClone(value), ...(patch ? { title: patch.title, scenes: patch.scenes, settings: patch.settings } : {}), id: randomUUID(), revision: 0, updatedAt: new Date().toISOString() }
    this.validate(project, draft); project.drafts.unshift(draft)
    this.save(project); return this.get(id)
  }
  remove(id: string, draftId: string): ClipProject {
    const project = this.require(id)
    if ([...project.renders, ...(project.covers || [])].some(job => job.draftId === draftId && (job.status === 'running' || job.status === 'queued'))) throw clipError('busy')
    project.drafts = project.drafts.filter(draft => draft.id !== draftId); this.save(project); return this.get(id)
  }
  captions(id: string, draftId: string): { captions: Caption[]; speakers: TranscriptSnapshot['speakers']; language?: string } {
    const project = this.require(id), draft = project.drafts.find(value => value.id === draftId)
    if (!draft) throw clipError('notFound')
    return this.mappedCaptions(project, draft)
  }
  private mappedCaptions(project: StoredProject, draft: Draft) {
    const transcript = project.transcripts.find(value => value.id === draft.transcriptId)
    if (!transcript) throw clipError('notFound')
    let offsetFrames = 0
    const captions: Caption[] = []
    for (const scene of draft.scenes) {
      const frames = Math.max(1, Math.round((scene.endMs - scene.startMs) * 30 / 1000))
      const offsetMs = offsetFrames * 1000 / 30, durationMs = frames * 1000 / 30
      for (const cue of transcript.captions) {
        const start = Math.max(scene.startMs, cue.startMs), end = Math.min(scene.endMs, cue.endMs)
        const startMs = Math.round(start - scene.startMs + offsetMs)
        const endMs = Math.round(Math.min(end - scene.startMs, durationMs) + offsetMs)
        if (end > start && endMs > startMs) captions.push({ ...cue, id: randomUUID(), startMs, endMs, words: undefined })
      }
      offsetFrames += frames
    }
    return { captions, speakers: transcript.speakers, language: transcript.language }
  }
  private async cleanupRender(project: StoredProject, job: Pick<RenderJob, 'id'>): Promise<void> {
    // Recovery reads persisted jobs: constrain deletion to this task's UUID directory.
    if (!/^[0-9a-f-]{36}$/i.test(job.id)) throw clipError('output')
    const root = path.resolve(path.dirname(this.file(project.documentId)), 'tasks')
    const folder = path.resolve(root, job.id)
    if (!folder.startsWith(root + path.sep)) throw clipError('output')
    const target = project.paths[job.id]
    await Promise.all([
      rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      target ? rm(path.join(path.dirname(target), '.galaxy-clip-' + job.id + '.part.mp4'), { force: true, maxRetries: 10, retryDelay: 100 }) : Promise.resolve(),
    ])
  }
  async render(id: string, draftId: string, revision: number, preview: boolean, output?: string): Promise<ClipProject> {
    if (this.stopped) throw clipError('busy')
    const project = this.require(id), input = this.source(project), draft = project.drafts.find(value => value.id === draftId)
    if (!draft) throw clipError('notFound')
    if (draft.revision !== revision) throw clipError('conflict')
    if (!draft.scenes.length) throw clipError('empty')
    this.validate(project, draft)
    const same = project.renders.find(job => job.draftId === draftId && job.revision === revision && job.preview === preview && (job.status === 'queued' || job.status === 'running'))
    if (same) return this.get(id)
    if (preview) {
      const cached = project.renders.find(job => job.draftId === draftId && job.revision === revision && job.preview && job.status === 'completed' && job.rendererVersion === RENDERER_VERSION && job.media)
      const file = cached && project.paths[cached.id]
      try { if (file && statSync(file).isFile() && statSync(file).size > 0) return this.get(id) } catch { /* Missing previews are rendered again. */ }
    }
    const job: RenderJob = { id: randomUUID(), draftId, revision, snapshot: structuredClone(draft), preview, status: 'queued', createdAt: new Date().toISOString(), rendererVersion: RENDERER_VERSION }
    const target = preview ? path.join(path.dirname(this.file(id)), 'previews', job.id + '.mp4') : output
    if (!target || path.resolve(target) === path.resolve(input) || existsSync(target) || this.reserved.has(path.resolve(target))) throw clipError('output')
    this.reserved.set(path.resolve(target), job.id); project.renders.unshift(job); project.paths[job.id] = target
    const controller = new AbortController()
    const taskDirectory = path.resolve(path.dirname(this.file(id)), 'tasks', job.id)
    const taskRoot = path.resolve(path.dirname(this.file(id)), 'tasks') + path.sep
    if (!taskDirectory.startsWith(taskRoot)) throw clipError('output')
    this.active.set(job.id, { documentId: id, controller }); this.save(project)
    this.renderTail = this.renderTail.catch(() => {}).then(async () => {
      let failure: 'cancelled' | 'failed' | undefined
      try {
        controller.signal.throwIfAborted(); this.source(project)
        job.status = 'running'; job.stage = 'exporting'; this.save(project)
        mkdirSync(path.dirname(target), { recursive: true })
        mkdirSync(taskDirectory, { recursive: true })
        const mapped = this.mappedCaptions(project, job.snapshot)
        const result = await this.engine.request<{ durationMs: number; media?: RenderedMedia }>({ operation: 'clip-render', input, output: target, scenes: job.snapshot.scenes, clipSettings: job.snapshot.settings, clipCaptions: mapped.captions, preview, clipTaskId: job.id, workDirectory: taskDirectory }, controller.signal, event => {
          if (event.kind === 'processing') { job.progress = event.progress; this.version++; this.changed() }
        })
        controller.signal.throwIfAborted(); this.source(project)
        if (!existsSync(target) || !statSync(target).size) throw clipError('output')
        project.paths[job.id] = target; job.status = 'completed'; job.progress = 1; job.name = path.basename(target); job.durationMs = result.durationMs; job.media = result.media
        if (job.snapshot.settings.cover?.enabled !== false) {
          // A cover is a separate queued task; a cover failure never invalidates a completed video.
          try { this.coverForRender(id, job.id) } catch { log.warn('Could not queue clip cover') }
        }
      } catch (error) {
        failure = controller.signal.aborted ? 'cancelled' : 'failed'
        job.stage = controller.signal.aborted ? 'cancelling' : 'cleanup'
        job.error = controller.signal.aborted ? undefined : error instanceof Error ? error.message : clipError('response').message
        // A file created by another process after dispatch must never be deleted.
        // The engine removes its private staging file and commits only complete output.
      } finally {
        try {
          await this.cleanupRender(project, job)
        } catch (error) { log.warn('Could not remove temporary files for clip task ' + job.id + ': ' + (error as NodeJS.ErrnoException).code) }
        if (failure) job.status = failure
        if (this.reserved.get(path.resolve(target)) === job.id) this.reserved.delete(path.resolve(target))
        this.active.delete(job.id); this.save(project)
      }
    }).catch(() => { log.error('Could not persist clip render state') })
    return this.get(id)
  }
  media(id: string, taskId: string): string {
    const project = this.require(id), job = project.renders.find(value => value.id === taskId)
    const file = project.paths[taskId]
    if (job?.status !== 'completed' || !file || !existsSync(file)) throw clipError('notFound')
    return file
  }
  coverMedia(id: string, coverId: string): string {
    const project = this.require(id), job = project.covers?.find(value => value.id === coverId)
    const file = project.paths[coverId]
    if (job?.status !== 'completed' || !file || !existsSync(file)) throw clipError('notFound')
    return file
  }
  cover(id: string, draftId: string, revision: number): ClipProject {
    const project = this.require(id), input = this.source(project), draft = project.drafts.find(value => value.id === draftId)
    if (!draft) throw clipError('notFound')
    if (draft.revision !== revision) throw clipError('conflict')
    this.validate(project, draft)
    return this.queueCover(project, draft, input)
  }
  async coverFrame(id: string, draftId: string, scenes: Draft['scenes'], frameMs: number): Promise<CoverFrame> {
    if (this.stopped) throw clipError('busy')
    const project = this.require(id), input = this.source(project), draft = project.drafts.find(value => value.id === draftId)
    if (!draft) throw clipError('notFound')
    this.validate(project, { ...draft, scenes, settings: { ...draft.settings, cover: coverSettingsSchema.parse({ frameMs }) } })
    const key = fingerprint([project.sourceSignature, frameMs]), cached = this.frames.get(key)
    if (cached) return cached
    const pending = this.frameRequests.get(key)
    if (pending) return pending
    if (this.frameRequests.size >= 6) throw clipError('busy')
    // Reuse export's bounded FFmpeg read, serialize work, and keep only six frames.
    // Preview never saves a draft or adds a render/cover job to project history.
    const work = this.frameTail.catch(() => {}).then(async () => {
      this.frameAbort.signal.throwIfAborted(); this.source(project)
      const frame = await readCoverFrame(this.engine.ffmpeg, input, frameMs, this.frameAbort.signal)
      this.frameAbort.signal.throwIfAborted(); this.source(project)
      const value = { dataUrl: 'data:image/jpeg;base64,' + frame.data.toString('base64'), width: frame.width, height: frame.height, frameMs }
      this.frames.set(key, value)
      if (this.frames.size > 6) this.frames.delete(this.frames.keys().next().value!)
      return value
    }).finally(() => { this.frameRequests.delete(key) })
    this.frameTail = work
    this.frameRequests.set(key, work)
    return work
  }
  coverForRender(id: string, taskId: string): ClipProject {
    const project = this.require(id), job = project.renders.find(value => value.id === taskId)
    if (job?.status !== 'completed') throw clipError('notFound')
    return this.queueCover(project, job.snapshot, this.media(id, taskId), job)
  }
  private queueCover(project: StoredProject, draft: Draft, input: string, render?: RenderJob): ClipProject {
    if (this.stopped) throw clipError('busy')
    if (!draft.scenes.length) throw clipError('empty')
    const settings = coverSettingsSchema.parse(draft.settings.cover || {})
    const first = draft.scenes[0]
    const frameMs = settings.frameMs ?? Math.round(first.startMs + (first.endMs - first.startMs) * .2)
    const chosen = draft.scenes.find(scene => scene.startMs <= frameMs && scene.endMs > frameMs)
    if (!chosen) throw clipError('coverRange')
    let seekMs = frameMs
    if (render) {
      let frames = 0
      for (const scene of draft.scenes) {
        if (scene === chosen) { seekMs = Math.round(frames * 1000 / 30 + frameMs - scene.startMs); break }
        frames += Math.max(1, Math.round((scene.endMs - scene.startMs) * 30 / 1000))
      }
    }
    const key = fingerprint([draft.id, draft.revision, settings, frameMs, render?.id || project.sourceSignature, 'cover-v5'])
    const held = project.covers?.find(job => job.cacheKey === key && ['queued', 'running', 'completed'].includes(job.status))
    if (held && (held.status !== 'completed' || existsSync(project.paths[held.id] || ''))) return this.get(project.documentId)
    const job: CoverJob = { id: randomUUID(), draftId: draft.id, revision: draft.revision, snapshot: structuredClone(draft), renderId: render?.id, cacheKey: key, status: 'queued', createdAt: new Date().toISOString(), frameMs }
    const folder = path.dirname(this.file(project.documentId)), directory = path.join(folder, 'tasks', job.id)
    const target = path.join(folder, 'covers', job.id + '.jpg'), controller = new AbortController()
    ;(project.covers ||= []).unshift(job); project.paths[job.id] = target
    this.active.set(job.id, { documentId: project.documentId, controller }); this.save(project)
    this.renderTail = this.renderTail.catch(() => {}).then(async () => {
      try {
        controller.signal.throwIfAborted()
        if (!render) this.source(project)
        job.status = 'running'; this.save(project)
        mkdirSync(directory, { recursive: true }); mkdirSync(path.dirname(target), { recursive: true })
        const videoSize = render?.media || (draft.settings.aspect === 'portrait' ? { width: 720, height: 1280 } : draft.settings.aspect === 'landscape' ? { width: 1280, height: 720 } : undefined)
        const image = await renderCover(this.engine.ffmpeg, input, seekMs, job.snapshot, directory, videoSize, controller.signal)
        controller.signal.throwIfAborted()
        if (!render) this.source(project)
        const staged = path.join(directory, 'result.jpg')
        await writeFile(staged, image.data, { flag: 'wx', mode: 0o600 }); await link(staged, target)
        job.width = image.width; job.height = image.height; job.name = path.basename(target); job.status = 'completed'
        if (render && !render.preview) {
          const video = path.parse(input), preferred = path.join(video.dir, video.name + '.cover.jpg')
          try {
            await writeFile(preferred, image.data, { flag: 'wx', mode: 0o600 })
            job.name = path.basename(preferred)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              const unique = path.join(video.dir, video.name + '.cover-' + job.id + '.jpg')
              try { await writeFile(unique, image.data, { flag: 'wx', mode: 0o600 }); job.name = path.basename(unique) }
              catch { job.warning = clipError('coverSidecar').message }
            } else job.warning = clipError('coverSidecar').message
          }
        }
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = controller.signal.aborted ? undefined : error instanceof Error ? error.message : clipError('coverFrame').message
      } finally {
        try { await this.cleanupRender(project, job) } catch { log.warn('Could not clean clip cover task') }
        this.active.delete(job.id); this.save(project)
      }
    }).catch(() => { log.error('Could not persist clip cover task') })
    return this.get(project.documentId)
  }
  cancel(id: string, taskId: string): void {
    const active = this.active.get(taskId) || this.active.get('analysis:' + taskId)
    if (!active || active.documentId !== id) throw clipError('notFound')
    active.controller.abort()
    const project = this.require(id), render = project.renders.find(job => job.id === taskId) || project.covers?.find(job => job.id === taskId)
    if (render?.status === 'queued') {
      render.status = 'cancelled'; this.active.delete(taskId)
      const file = project.paths[taskId]
      if (file && this.reserved.get(path.resolve(file)) === taskId) this.reserved.delete(path.resolve(file))
      this.save(project)
    }
  }
  exportText(id: string, draftId: string, format: 'srt' | 'vtt'): string {
    const doc = this.processing.get(id), mapped = this.captions(id, draftId)
    return exportCaptions({ ...doc, ...mapped }, format)
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.frameAbort.abort(); this.frames.clear()
    for (const task of this.active.values()) task.controller.abort()
    await Promise.allSettled([this.renderTail, this.frameTail, ...this.draining])
  }
}

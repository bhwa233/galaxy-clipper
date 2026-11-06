import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Settings } from '../../../shared/contracts'
import type { Caption, ProcessingDocument, ProcessingState, ProcessingSummary, ModelId } from '../../../shared/processing'
import { Engine, redact, runProcess } from '../engine'
import { ModelManager } from './models'
import { parseCaptionTrack, type CaptionTrack as RawTrack } from './vendor/captions'
import type { PipelineResult } from './vendor/types'
import { legacyDocumentSchema } from '../../../shared/project-import'

type ExportFormat = 'txt' | 'md' | 'srt' | 'vtt' | 'soft' | 'burn' | 'video'
/** Which tracks a subtitle video uses, and the resolved library style for burn-in. */
export type VideoCaptions = { captions: 'current' | 'bilingual'; style?: import('../../../shared/styles').SubtitleStyleParams }
type CaptionMode = 'soft' | 'soft-bilingual' | 'burn' | 'burn-bilingual'
const trackRole = (language: string) => /^zh(?:-|$)/i.test(language) ? 'zh' as const : /^en(?:-|$)/i.test(language) ? 'en' as const : 'other' as const
type StoredDocument = ProcessingDocument & { sourcePath: string; sourceSignature: string; trackData: Record<string, Caption[]>; trackSpeakers: Record<string, ProcessingDocument['speakers']>; exportPaths: string[]; pending?: { action: 'transcribe' | 'recognize' | 'speakers'; speakers: Settings['transcriptionSpeakers']; remote?: import('../../../shared/clipping').ProviderSnapshot; resuming?: boolean } }
const extensions = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.aac', '.ts'])
const busy = (doc: ProcessingDocument) => doc.status === 'running' || doc.status === 'queued'
const signature = (file: string) => { const info = statSync(file); return `${info.size}:${info.mtimeMs}` }
const clock = (ms: number, vtt = false) => { const whole = Math.max(0, Math.round(ms)); return `${String(Math.floor(whole / 3600000)).padStart(2, '0')}:${String(Math.floor(whole / 60000) % 60).padStart(2, '0')}:${String(Math.floor(whole / 1000) % 60).padStart(2, '0')}${vtt ? '.' : ','}${String(whole % 1000).padStart(3, '0')}` }
export function exportCaptions(doc: ProcessingDocument, format: 'srt' | 'vtt' | 'txt' | 'md'): string {
  if (format === 'srt' || format === 'vtt') return (format === 'vtt' ? 'WEBVTT\n\n' : '') + doc.captions.map((cue, index) => `${format === 'srt' ? index + 1 + '\n' : ''}${clock(cue.startMs, format === 'vtt')} --> ${clock(cue.endMs, format === 'vtt')}\n${cue.text}`).join('\n\n') + '\n'
  const speaker = (cue: Caption) => doc.speakers.find(speaker => speaker.id === cue.speakerId)?.name
  return (format === 'md' ? `# ${doc.title}\n\n` : '') + doc.captions.map(cue => `${format === 'md' ? `**${clock(cue.startMs).split(',')[0]}** ` : ''}${speaker(cue) ? speaker(cue) + ': ' : ''}${cue.text}`).join('\n\n') + '\n'
}

export class ProcessingService {
  readonly models: ModelManager
  private documents = new Map<string, StoredDocument>()
  private active = new Map<string, AbortController>()
  private draining = new Set<Promise<unknown>>()
  private stopped = false
  constructor(private directory: string, private engine: Engine, private root: string, private settings: () => Settings, fetcher: typeof fetch, private changed: () => void, private remote?: { snapshot: () => import('../../../shared/clipping').ProviderSnapshot | undefined; run: (input: string, directory: string, provider: import('../../../shared/clipping').ProviderSnapshot, signal: AbortSignal, changed: (stage: string, progress: number) => void, force: boolean) => Promise<import('../clipping/transcription').RemoteTranscript> }) {
    mkdirSync(directory, { recursive: true })
    this.models = new ModelManager(path.join(directory, 'models'), fetcher, async (input, output, archiveFiles, signal) => { await engine.request({ operation: 'unpack', input, output, archiveFiles }, signal) }, () => { this.changed(); this.pump() })
    for (const id of readdirSync(directory).filter(id => /^[0-9a-f-]{36}$/.test(id))) {
      try {
        const doc = JSON.parse(readFileSync(path.join(directory, id, 'document.json'), 'utf8')) as StoredDocument
        if (doc.id !== id || !Array.isArray(doc.captions) || typeof doc.sourcePath !== 'string') continue
        if (doc.status === 'running' || doc.status === 'queued') { doc.status = 'cancelled'; doc.error = 'Processing interrupted; start again to resume.' }
        doc.trackData ||= {}; doc.trackSpeakers ||= {}; doc.exportPaths ||= []; doc.exports ||= []
        this.documents.set(id, doc)
      } catch { /* Preserve unreadable documents on disk without exposing partial state. */ }
    }
  }
  state(): ProcessingState {
    return { documents: [...this.documents.values()].map(doc => this.summary(doc)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), models: this.models.statuses(this.settings().captionLanguages[0] || this.settings().locale), runtime: 'sherpa-onnx · CPU · offline' }
  }
  private summary(doc: StoredDocument): ProcessingSummary { return { id: doc.id, title: doc.title, sourceName: doc.sourceName, jobId: doc.jobId, durationSeconds: doc.durationSeconds, status: doc.status, stage: doc.stage, progress: doc.progress, eta: doc.eta, error: doc.error, updatedAt: doc.updatedAt, captionCount: doc.captions.length, language: doc.language, model: doc.model, retryable: Boolean(doc.pending && (doc.status === 'failed' || doc.status === 'cancelled')) } }
  get(id: string): ProcessingDocument { const doc = this.require(id); return { ...this.summary(doc), revision: doc.revision, captions: doc.captions, speakers: doc.speakers, tracks: doc.tracks.map(track => ({ ...track, count: (track.id === doc.activeTrack ? doc.captions : doc.trackData[track.id])?.length || 0 })), activeTrack: doc.activeTrack, sourceUrl: doc.sourceUrl, subtitleStyle: doc.subtitleStyle, bilingual: this.bilingual(doc), exports: doc.exports } }
  /** The zh and en tracks a bilingual export would pair, for the live export preview. */
  private bilingual(doc: StoredDocument): ProcessingDocument['bilingual'] {
    try { const [first, second] = this.exportTracks(doc, 'burn-bilingual'); return first.role === 'zh' ? { zh: first.captions, en: second.captions } : { zh: second.captions, en: first.captions } } catch { return undefined }
  }
  private require(id: string): StoredDocument { const doc = this.documents.get(id); if (!doc) throw new Error('Media document not found'); return doc }
  media(id: string): string { const doc = this.require(id); if (!existsSync(doc.sourcePath) || signature(doc.sourcePath) !== doc.sourceSignature) throw new Error('Source media is missing or changed'); return doc.sourcePath }
  private folder(id: string): string { const directory = path.join(this.directory, id); mkdirSync(directory, { recursive: true }); return directory }
  private save(doc: StoredDocument): void {
    doc.updatedAt = new Date().toISOString()
    const target = path.join(this.folder(doc.id), 'document.json')
    writeFileSync(target + '.tmp', JSON.stringify(doc), { mode: 0o600 }); renameSync(target + '.tmp', target); this.changed()
  }
  private editable(doc: StoredDocument): void { if (busy(doc) || this.active.has(doc.id)) throw new Error('Wait for processing to finish first') }
  async importFile(file: string): Promise<ProcessingDocument> {
    const sourcePath = realpathSync(file)
    if (!extensions.has(path.extname(sourcePath).toLowerCase()) || !statSync(sourcePath).isFile() || !statSync(sourcePath).size) throw new Error('Choose a non-empty video or audio file')
    const sourceSignature = signature(sourcePath)
    const existing = [...this.documents.values()].find(doc => doc.sourcePath === sourcePath && doc.sourceSignature === sourceSignature)
    if (existing) return this.get(existing.id)
    const metadata = await this.engine.request<{ durationSeconds: number; sourceUrl?: string }>({ operation: 'inspect', input: sourcePath })
    const doc: StoredDocument = { sourceUrl: metadata.sourceUrl, id: randomUUID(), title: path.basename(sourcePath, path.extname(sourcePath)), sourceName: path.basename(sourcePath), sourcePath, sourceSignature, durationSeconds: metadata.durationSeconds, status: 'idle', updatedAt: new Date().toISOString(), captionCount: 0, revision: 0, captions: [], speakers: [], tracks: [], trackData: {}, trackSpeakers: {}, exportPaths: [], exports: [] }
    this.documents.set(doc.id, doc)
    try { await this.localCaptions(doc) } catch (error) { this.documents.delete(doc.id); rmSync(this.folder(doc.id), { recursive: true, force: true }); throw error }
    this.save(doc); return this.get(doc.id)
  }
  async importSnapshot(input: unknown): Promise<ProcessingDocument> {
    const value = legacyDocumentSchema.parse(input), sourcePath = realpathSync(value.sourcePath)
    if(!extensions.has(path.extname(sourcePath).toLowerCase()) || !statSync(sourcePath).isFile()) throw new Error('Imported source is unavailable')
    const metadata = await this.engine.request<{durationSeconds:number}>({operation:'inspect',input:sourcePath})
    const active = value.tracks.find(track => track.id === value.activeTrack)
    const doc: StoredDocument = { ...value, id:randomUUID(), sourcePath, sourceName:path.basename(sourcePath), sourceSignature:signature(sourcePath),
      durationSeconds:metadata.durationSeconds, status:'completed', captionCount:value.captions.length, updatedAt:new Date().toISOString(),
      activeTrack:active?.id, exportPaths:[],exports:[] }
    this.documents.set(doc.id,doc); this.save(doc); return this.get(doc.id)
  }
  private addTrack(doc: StoredDocument, text: string, format: RawTrack['format'], language: string, source: 'platform' | 'file', name: string, deduplicate = true, automatic = false): void {
    const cues = parseCaptionTrack(text, format).filter(cue => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) && cue.endMs > cue.startMs && cue.text.trim())
    if (!cues.length) return
    const held = doc.tracks.find(track => track.language === language && track.source === source)
    if (held && deduplicate) return
    const id = randomUUID(), speakers = new Map<string, string>()
    const captions = cues.map(cue => { if (cue.speaker && !speakers.has(cue.speaker)) speakers.set(cue.speaker, randomUUID()); return { id: randomUUID(), text: cue.text, startMs: Math.round(cue.startMs), endMs: Math.round(cue.endMs), speakerId: cue.speaker ? speakers.get(cue.speaker)! : null } })
    doc.tracks.push({ id, language, source, name, ...(automatic ? { automatic } : {}) }); doc.trackData[id] = captions; doc.trackSpeakers[id] = [...speakers].map(([name, id]) => ({ id, name }))
    if (!doc.activeTrack) {
      doc.activeTrack = id; doc.captions = captions; doc.language = language; doc.status = 'completed'; doc.captionCount = captions.length
      doc.speakers = doc.trackSpeakers[id]
    }
  }
  private async localCaptions(doc: StoredDocument): Promise<void> {
    const stem = path.basename(doc.sourcePath, path.extname(doc.sourcePath)), parent = path.dirname(doc.sourcePath)
    const languageOrder = this.settings().captionLanguages
    const files = readdirSync(parent).filter(file => (file.startsWith(stem + '.') || file === stem + '.srt') && /\.(?:srt|vtt|ass)$/i.test(file)).sort((a, b) => {
      const score = (file: string) => { const language = file.slice(stem.length + 1).split('.')[0]; const index = languageOrder.findIndex(value => language.toLowerCase().startsWith(value.toLowerCase())); return index < 0 ? 100 : index }
      return score(a) - score(b)
    })
    for (const file of files.slice(0, 20)) {
      const full = path.join(parent, file)
      if (statSync(full).size > 16 * 1024 * 1024) continue
      this.addTrack(doc, readFileSync(full, 'utf8'), path.extname(file).slice(1).toLowerCase() as RawTrack['format'], file.slice(stem.length + 1, -path.extname(file).length) || 'und', 'file', file)
    }
    if (!doc.tracks.length) {
      const result = await this.engine.request<{ tracks: { file: string; language: string }[] }>({ operation: 'embedded-captions', input: doc.sourcePath, output: this.folder(doc.id) })
      for (const track of result.tracks) this.addTrack(doc, readFileSync(track.file, 'utf8'), 'srt', track.language, 'file', `Embedded · ${track.language}`)
    }
  }
  importCaptions(id: string, file: string): ProcessingDocument {
    const doc = this.require(id); this.editable(doc)
    const format = path.extname(file).slice(1).toLowerCase()
    if (!['srt', 'vtt', 'ass'].includes(format) || statSync(file).size > 16 * 1024 * 1024) throw new Error('Choose an SRT, VTT or ASS subtitle file under 16 MB')
    if (doc.activeTrack) { doc.trackData[doc.activeTrack] = doc.captions; doc.trackSpeakers[doc.activeTrack] = doc.speakers }
    const old = doc.activeTrack; doc.activeTrack = undefined
    const language = path.basename(file).match(/\.([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.(?:srt|vtt|ass)$/i)?.[1] || 'und'
    this.addTrack(doc, readFileSync(file, 'utf8'), format as RawTrack['format'], language, 'file', path.basename(file), false)
    if (!doc.activeTrack) { doc.activeTrack = old; throw new Error('No usable captions found') }
    doc.revision++; this.save(doc); return this.get(id)
  }
  platform(id: string, url: string, automatic: boolean): Promise<ProcessingDocument> { return this.track(this.fetchPlatform(id, url, automatic)) }
  /** Platform captions for the source's page: manual first per chosen language, automatic only when allowed. */
  private async fetchPlatform(id: string, url: string, automatic: boolean): Promise<ProcessingDocument> {
    const doc = this.require(id); this.editable(doc)
    const controller = new AbortController(), directory = path.join(this.folder(id), `platform-${randomUUID()}`)
    this.active.set(id, controller); doc.status = 'running'; doc.stage = 'platform-captions'; doc.progress = undefined; doc.error = undefined; this.changed()
    try {
      const result = await this.engine.request<{ tracks: { file: string; language: string; automatic: boolean }[] }>({ operation: 'captions', url, output: directory, captionLanguages: this.settings().captionLanguages, subtitleAutoGenerated: automatic, subtitleNormalizeOverlaps: true }, controller.signal)
      if (!result.tracks.length) throw new Error('No platform subtitles were found for the chosen languages')
      if (doc.activeTrack) { doc.trackData[doc.activeTrack] = doc.captions; doc.trackSpeakers[doc.activeTrack] = doc.speakers }
      const known = new Set(doc.tracks.map(track => track.id))
      for (const track of result.tracks) this.addTrack(doc, readFileSync(track.file, 'utf8'), 'srt', track.language, 'platform', `Platform · ${track.language}`, true, track.automatic)
      const added = doc.tracks.find(track => !known.has(track.id))
      if (added) { doc.activeTrack = added.id; doc.captions = doc.trackData[added.id]; doc.speakers = doc.trackSpeakers[added.id] || []; doc.language = added.language; doc.captionCount = doc.captions.length }
      doc.sourceUrl = url; doc.revision++; doc.status = 'completed'; doc.stage = undefined; doc.progress = 1
    } catch (error) { doc.status = controller.signal.aborted ? 'cancelled' : 'failed'; doc.error = controller.signal.aborted ? undefined : redact(error instanceof Error ? error.message : String(error)); throw error }
    finally { this.active.delete(id); rmSync(directory, { recursive: true, force: true }); this.save(doc); this.pump() }
    return this.get(id)
  }
  switchTrack(id: string, trackId: string): ProcessingDocument {
    const doc = this.require(id); this.editable(doc)
    const track = doc.tracks.find(track => track.id === trackId)
    if (!track || !doc.trackData[trackId]) throw new Error('Subtitle track not found')
    if (doc.activeTrack) { doc.trackData[doc.activeTrack] = doc.captions; doc.trackSpeakers[doc.activeTrack] = doc.speakers }
    doc.activeTrack = trackId; doc.captions = doc.trackData[trackId]; doc.speakers = doc.trackSpeakers[trackId] || []; doc.language = track.language; doc.captionCount = doc.captions.length; doc.revision++; this.save(doc); return this.get(id)
  }
  edit(input: { id: string; revision: number; captionId: string; text: string; startMs: number; endMs: number; speakerId: string | null }): ProcessingDocument {
    const doc = this.require(input.id); this.editable(doc)
    if (doc.revision !== input.revision) throw new Error('This transcript changed; reload before saving')
    const cue = doc.captions.find(cue => cue.id === input.captionId)
    if (!cue || input.speakerId && !doc.speakers.some(speaker => speaker.id === input.speakerId)) throw new Error('Subtitle or speaker not found')
    Object.assign(cue, { text: input.text, startMs: input.startMs, endMs: input.endMs, speakerId: input.speakerId, words: cue.text === input.text && cue.startMs === input.startMs && cue.endMs === input.endMs ? cue.words : [] })
    doc.captions.sort((a, b) => a.startMs - b.startMs); doc.revision++; this.save(doc); return this.get(input.id)
  }
  speaker(id: string, speakerId: string, name: string): ProcessingDocument { const doc = this.require(id); this.editable(doc); const speaker = doc.speakers.find(speaker => speaker.id === speakerId); if (!speaker) throw new Error('Speaker not found'); speaker.name = name; doc.revision++; this.save(doc); return this.get(id) }
  enqueue(id: string, action: 'transcribe' | 'recognize' | 'speakers', model: ModelId, speakers: Settings['transcriptionSpeakers']): ProcessingDocument {
    const doc = this.require(id); this.editable(doc)
    if (action === 'speakers' && !doc.captions.length) throw new Error('Read or recognize subtitles first')
    doc.model = model; doc.pending = { action, speakers, remote: action === 'speakers' ? undefined : this.remote?.snapshot() }; doc.status = 'queued'; doc.error = undefined; doc.progress = 0; this.save(doc); this.pump(); return this.get(id)
  }
  cancel(id: string): void { const doc = this.require(id); this.active.get(id)?.abort(); doc.status = 'cancelled'; doc.error = undefined; this.save(doc) }
  retry(id: string): ProcessingDocument {
    const doc = this.require(id); this.editable(doc)
    if (!doc.pending) throw new Error('No interrupted transcription to retry')
    doc.pending.resuming = true; doc.status = 'queued'; doc.error = undefined; doc.progress = 0
    this.save(doc); this.pump(); return this.get(id)
  }
  remove(id: string): void { const doc = this.require(id); this.editable(doc); this.documents.delete(id); rmSync(this.folder(id), { recursive: true, force: true }); this.changed() }
  modelInUse(id: string): boolean { return [...this.documents.values()].some(doc => (busy(doc) || this.active.has(doc.id)) && (id === 'speaker' || doc.model === id)) }
  private pump(): void {
    if (this.stopped) return
    for (const doc of this.documents.values()) {
      if (this.active.size >= this.settings().transcriptionConcurrency) break
      if (this.active.has(doc.id) || !['queued', 'waiting-model'].includes(doc.status) || !doc.pending) continue
      if (doc.status === 'waiting-model' && !doc.pending.remote && !this.models.ready(doc.model!)) continue
      const controller = new AbortController(); this.active.set(doc.id, controller)
      const work = this.run(doc, controller.signal).catch(error => { doc.status = controller.signal.aborted ? 'cancelled' : 'failed'; doc.error = controller.signal.aborted ? undefined : redact(error instanceof Error ? error.message : String(error)); this.save(doc) }).finally(() => { this.active.delete(doc.id); this.draining.delete(work); this.pump() })
      this.draining.add(work)
    }
  }
  private async run(doc: StoredDocument, signal: AbortSignal): Promise<void> {
    doc.status = 'running'; doc.stage = 'captions'; this.save(doc)
    if (signature(doc.sourcePath) !== doc.sourceSignature) throw new Error('Source file changed; import it again')
    const pending = doc.pending!
    if (pending.action === 'transcribe') {
      if (!doc.captions.length) await this.localCaptions(doc)
      if (doc.captions.length) { doc.status = 'completed'; doc.stage = undefined; doc.progress = 1; doc.pending = undefined; this.save(doc); return }
    }
    if (pending.remote && this.remote) {
      const result = await this.remote.run(doc.sourcePath, this.folder(doc.id), pending.remote, signal, (stage, progress) => { doc.stage = stage; doc.progress = progress; this.changed() }, pending.action === 'recognize' && !pending.resuming)
      signal.throwIfAborted()
      if (signature(doc.sourcePath) !== doc.sourceSignature) throw new Error('Source media changed')
      if (doc.activeTrack) { doc.trackData[doc.activeTrack] = doc.captions; doc.trackSpeakers[doc.activeTrack] = doc.speakers }
      const trackId = randomUUID()
      doc.captions = result.captions; doc.speakers = result.speakers; doc.language = result.language
      doc.tracks.push({ id: trackId, source: 'remote', language: result.language || 'und', name: 'Remote · ' + pending.remote.model })
      doc.activeTrack = trackId; doc.trackData[trackId] = doc.captions; doc.trackSpeakers[trackId] = doc.speakers
      doc.captionCount = doc.captions.length; doc.revision++; doc.status = 'completed'; doc.progress = 1
      doc.stage = doc.captions.length ? undefined : 'no-speech'; doc.pending = undefined; this.save(doc); return
    }
    if (pending.action !== 'speakers' && !this.models.ready(doc.model!)) { doc.status = 'waiting-model'; doc.stage = 'models'; this.save(doc); return }
    if (pending.action !== 'speakers' || pending.speakers !== 1) {
      doc.stage = 'models'; this.save(doc)
      const ready = this.models.ensureReady({ groups: pending.action === 'speakers' ? ['speaker'] : pending.speakers === 1 ? ['vad'] : ['vad', 'speaker'] })
      // Model downloads are shared. Cancelling this document releases its queue slot immediately.
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(signal.reason)
        signal.addEventListener('abort', cancel, { once: true })
        ready.then(() => { signal.removeEventListener('abort', cancel); resolve() }, error => { signal.removeEventListener('abort', cancel); reject(error) })
        if (signal.aborted) cancel()
      })
    }
    signal.throwIfAborted()
    doc.stage = 'preparing-audio'; this.save(doc)
    const wav = path.join(this.folder(doc.id), 'audio.wav')
    const audio = await this.engine.request<{ durationSeconds: number }>({ operation: 'audio', input: doc.sourcePath, output: wav }, signal)
    const previous = doc.captions.map(cue => ({ ...cue })), oldSpeakers = doc.speakers
    if (pending.action === 'recognize' && !pending.resuming) rmSync(path.join(this.folder(doc.id), `chunks-${doc.model}.json`), { force: true })
    if (doc.activeTrack) doc.trackSpeakers[doc.activeTrack] = oldSpeakers
    const request = {
      sourceFilePath: doc.sourcePath, wavPath: wav, durationMs: Math.round(audio.durationSeconds * 1000), modelsDirectory: this.models.directory,
      skipVad: false, autoSkipAllowed: true, asrTier: doc.model, speakerCount: pending.speakers, language: this.settings().captionLanguages[0],
      manifestPath: pending.action === 'speakers' ? undefined : path.join(this.folder(doc.id), `chunks-${doc.model}.json`),
      existingTranscript: pending.action === 'speakers' ? { language: doc.language || null, modelVersion: 'galaxy-transcript', asrTier: doc.model!, speakers: oldSpeakers.map(speaker => ({ speakerKey: speaker.id, displayName: speaker.name })), segments: previous.map(cue => ({ ...cue, speakerKey: cue.speakerId, confidence: null })) } : undefined,
    }
    const result = await runProcess<PipelineResult>(process.execPath, [path.join(this.root, 'dist-electron/processing/worker.mjs')], request, signal, event => {
      if (event.kind === 'processing') { doc.stage = event.status; doc.progress = typeof event.progress === 'number' ? event.progress : undefined; this.changed() }
    }, 24 * 60 * 60 * 1000)
    signal.throwIfAborted()
    doc.durationSeconds = audio.durationSeconds; doc.language = result.language || doc.language
    doc.speakers = result.speakers.map(speaker => ({ id: speaker.speakerKey, name: oldSpeakers.find(old => old.id === speaker.speakerKey)?.name || speaker.displayName }))
    if (pending.action === 'speakers') {
      // Re-diarization overlays ownership only: keep every id, timestamp, word and human edit.
      doc.captions = previous.map(cue => { const middle = (cue.startMs + cue.endMs) / 2; const assigned = result.segments.find(segment => segment.startMs <= middle && segment.endMs >= middle) || result.segments.find(segment => segment.startMs < cue.endMs && segment.endMs > cue.startMs); return { ...cue, speakerId: assigned?.speakerKey || null } })
    } else {
      if (doc.activeTrack) doc.trackData[doc.activeTrack] = previous
      doc.captions = result.segments.map(segment => ({ id: randomUUID(), text: segment.text, startMs: segment.startMs, endMs: segment.endMs, speakerId: segment.speakerKey, words: segment.words }))
      const id = randomUUID(); doc.tracks.push({ id, source: 'asr', language: doc.language || 'und', name: `ASR · ${doc.model}` }); doc.activeTrack = id; doc.trackData[id] = doc.captions; doc.trackSpeakers[id] = doc.speakers
    }
    doc.captionCount = doc.captions.length; doc.revision++; doc.status = 'completed'; doc.progress = 1; doc.stage = result.resultKind === 'no-speech' ? 'no-speech' : undefined; doc.pending = undefined; this.save(doc)
    rmSync(wav, { force: true })
  }
  export(id: string, format: ExportFormat, output: string, options: VideoCaptions = { captions: 'current' }): Promise<ProcessingDocument> {
    return this.track(this.exportDocument(id, format, output, options))
  }
  /** Default subtitle style for this media; drafts created afterwards start with it. */
  setStyle(id: string, styleId: string): ProcessingDocument { const doc = this.require(id); doc.subtitleStyle = styleId; this.save(doc); return this.get(id) }
  replaceStyle(id: string, base: string): void { for (const doc of this.documents.values()) if (doc.subtitleStyle === id) { doc.subtitleStyle = base; this.save(doc) } }
  styleUsage(id: string): number { return [...this.documents.values()].filter(doc => doc.subtitleStyle === id).length }
  /** One real burned frame, rendered exactly like a burn-in export. */
  async frame(id: string, timeMs: number, options: VideoCaptions): Promise<string> {
    const doc = this.require(id)
    if (!doc.captions.length) throw new Error('No subtitles to export')
    const chosen = this.exportTracks(doc, options.captions === 'bilingual' ? 'burn-bilingual' : 'burn'), folder = this.folder(id)
    const captionTracks = chosen.map((track, index) => ({ file: path.join(folder, `frame-${index}.srt`), language: track.language, role: track.role }))
    const output = path.join(folder, `frame-${randomUUID()}.jpg`)
    try {
      chosen.forEach((track, index) => writeFileSync(captionTracks[index].file, exportCaptions({ ...this.get(id), captions: track.captions }, 'srt'), { mode: 0o600 }))
      await this.engine.request({ operation: 'caption-frame', input: this.media(id), output, timeMs: Math.max(0, Math.round(timeMs)), renderMode: options.captions === 'bilingual' ? 'burn-bilingual' : 'burn', captionTracks, subtitleStyle: options.style })
      return 'data:image/jpeg;base64,' + readFileSync(output).toString('base64')
    } finally { rmSync(output, { force: true }); for (const track of captionTracks) rmSync(track.file, { force: true }) }
  }
  /** Shutdown waits for exports and platform fetches that own files in the document folder. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.draining.add(work)
    const settled = () => { this.draining.delete(work) }
    void work.then(settled, settled)
    return work
  }
  /** zh and en tracks (active first) pair into bilingual output; other languages travel as-is. */
  private exportTracks(doc: StoredDocument, format: CaptionMode): { language: string; role: 'zh' | 'en' | 'other'; captions: Caption[] }[] {
    const role = trackRole
    if (format === 'burn' || format === 'soft') { const language = doc.tracks.find(track => track.id === doc.activeTrack)?.language || doc.language || 'und'; return [{ language, role: role(language), captions: doc.captions }] }
    const ordered = [...doc.tracks.filter(track => track.id === doc.activeTrack), ...doc.tracks.filter(track => track.id !== doc.activeTrack)]
    const chosen: ReturnType<ProcessingService['exportTracks']> = [], languages = new Set<string>()
    for (const track of ordered) {
      const captions = track.id === doc.activeTrack ? doc.captions : doc.trackData[track.id], kind = role(track.language)
      if (!captions?.length || (kind === 'other' ? languages.has(track.language.toLowerCase()) : chosen.some(item => item.role === kind))) continue
      if (kind === 'other' && (format !== 'soft-bilingual' || chosen.filter(item => item.role === 'other').length >= 2)) continue
      chosen.push({ language: track.language, role: kind, captions }); languages.add(track.language.toLowerCase())
    }
    if (!(chosen.some(item => item.role === 'zh') && chosen.some(item => item.role === 'en'))) throw new Error('Bilingual subtitles need a Chinese and an English subtitle track')
    return chosen
  }
  private async exportDocument(id: string, format: ExportFormat, output: string, options: VideoCaptions): Promise<ProcessingDocument> {
    const doc = this.require(id); this.editable(doc)
    if (format !== 'txt' && format !== 'md' && format !== 'video' && !doc.captions.length) throw new Error('No subtitles to export')
    if (path.resolve(output) === path.resolve(doc.sourcePath) || existsSync(output)) throw new Error('Choose a new output file; originals are never overwritten')
    if (format === 'txt' || format === 'md' || format === 'srt' || format === 'vtt') {
      writeFileSync(output, exportCaptions(this.get(id), format), { flag: 'wx', mode: 0o600 })
    } else {
      const bilingual = options.captions === 'bilingual'
      const chosen = format === 'video' ? [] : this.exportTracks(doc, format === 'soft' ? bilingual ? 'soft-bilingual' : 'soft' : bilingual ? 'burn-bilingual' : 'burn')
      const captionTracks = chosen.map((track, index) => ({ file: path.join(this.folder(id), `export-${index}.srt`), language: track.language, role: track.role }))
      const controller = new AbortController(); this.active.set(id, controller); doc.status = 'running'; doc.stage = 'exporting'; doc.progress = 0; doc.eta = undefined; doc.error = undefined; this.changed()
      try {
        chosen.forEach((track, index) => writeFileSync(captionTracks[index].file, exportCaptions({ ...this.get(id), captions: track.captions }, 'srt'), { mode: 0o600 }))
        await this.engine.request({ operation: 'render', input: doc.sourcePath, output, renderMode: format === 'burn' && bilingual ? 'burn-bilingual' : format, captionTracks, subtitleStyle: options.style, outputResolution: this.settings().outputResolution }, controller.signal, event => { if (event.kind === 'processing') { doc.progress = typeof event.progress === 'number' ? event.progress : undefined; doc.eta = typeof event.eta === 'number' ? event.eta : undefined; this.changed() } })
        doc.status = 'completed'; doc.stage = undefined; doc.progress = 1
      } catch (error) { doc.status = controller.signal.aborted ? 'cancelled' : 'failed'; doc.error = controller.signal.aborted ? undefined : redact(error instanceof Error ? error.message : String(error)); throw error }
      finally { this.active.delete(id); doc.eta = undefined; for (const track of captionTracks) rmSync(track.file, { force: true }); this.save(doc); this.pump() }
    }
    doc.exportPaths.push(output); doc.exports.push({ name: path.basename(output), createdAt: new Date().toISOString() }); this.save(doc); return this.get(id)
  }
  exportPath(id: string, index: number): string { const file = this.require(id).exportPaths[index]; if (!file || !existsSync(file)) throw new Error('Exported file is missing'); return file }
  async stop(): Promise<void> {
    this.stopped = true; this.models.stop()
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled(this.draining)
  }
  refresh(): void { this.pump(); this.changed() }
}

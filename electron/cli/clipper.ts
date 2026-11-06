import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Command, Option } from 'commander'
import { controlAddress, type ControlReply } from '../../shared/control'
import type { ClientState } from '../../shared/contracts'
import type { ProcessingDocument } from '../../shared/processing'
import type { ClipProject, Draft } from '../../shared/clipping'

// `clipper`: the command line for Galaxy Clipper, for scripts and agents. It does no media work of its
// own - it drives the running client (starting it in the background when it is not) through the local
// control channel, so a command uses the same media, subtitles, models, styles and queue as the window.
// Every command takes --json, which prints one JSON object to stdout and nothing else; progress goes
// to stderr.
//
// Exit codes: 0 done; 1 failed; 2 a precondition is missing (no subtitles, no cloud model, no source
// URL, model not installed); 4 the client could not be reached.
const EXIT = { failed: 1, precondition: 2, unreachable: 4 } as const
const development = process.env.CLIPPER_DEV === '1'
const address = controlAddress(development)

class Failure extends Error {
  constructor(message: string, readonly code: number = EXIT.failed, readonly detail: Record<string, unknown> = {}) { super(message) }
}

let nextId = 1
function request(socket: net.Socket, command: string, input: unknown): Promise<ControlReply> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.off('data', onData); socket.off('error', reject)
      try { resolve(JSON.parse(buffer.slice(0, newline)) as ControlReply) } catch (error) { reject(error) }
    }
    socket.on('data', onData); socket.once('error', reject)
    socket.write(`${JSON.stringify({ id, command, input })}\n`)
  })
}
function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address)
    socket.setEncoding('utf8')
    socket.once('connect', () => { socket.off('error', reject); resolve(socket) })
    socket.once('error', reject)
  })
}
// The `clipper` launcher of an installed client passes CLIPPER_APP, so a stopped client can be started.
async function client(): Promise<net.Socket> {
  try { return await connect() } catch { /* Not running yet. */ }
  const app = process.env.CLIPPER_APP
  if (!app) throw new Failure(`Galaxy Clipper is not running, and CLIPPER_APP does not say where it is installed (${address}).`, EXIT.unreachable)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(app, ['--background'], { detached: true, stdio: 'ignore', env }).unref()
  process.stderr.write('Starting Galaxy Clipper in the background…\n')
  for (let waited = 0; waited < 60_000; waited += 500) {
    await new Promise(resolve => setTimeout(resolve, 500))
    try { return await connect() } catch { /* Still starting. */ }
  }
  throw new Failure('Galaxy Clipper did not start within 60 seconds.', EXIT.unreachable)
}
type Ok = { state: ClientState; document?: ProcessingDocument; clipProject?: ClipProject; version?: string }
async function call(command: string, input: unknown): Promise<Ok> {
  const socket = await client()
  try {
    const reply = await request(socket, command, input)
    if (reply.ok) return reply as unknown as Ok
    throw new Failure(String(reply.message || 'The client refused the command.'))
  } finally { socket.destroy() }
}

let json = false
function output(value: Record<string, unknown>, human: () => void): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, ...value })}\n`)
  else human()
}
const table = (rows: string[][]) => {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(row => [...row[column]].length))) || []
  for (const row of rows) console.log(row.map((cell, column) => cell + ' '.repeat(widths[column] - [...cell].length)).join('  ').trimEnd())
}
const clock = (ms: number) => { const seconds = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
const progress = (text: string) => { if (!json) process.stderr.write(`\r${text}`.padEnd(70) + ' ') }
const done = () => { if (!json) process.stderr.write('\n') }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// --- Lookups. Ids may be shortened to any unique prefix. ---
async function state(): Promise<ClientState> { return (await call('state:get', null)).state }
async function media(prefix: string): Promise<ProcessingDocument> {
  const found = (await state()).processing.documents.filter(doc => doc.id.startsWith(prefix))
  if (found.length !== 1) throw new Failure(found.length ? `More than one media id starts with ${prefix}.` : `No media ${prefix}; see \`clipper media list\`.`)
  return (await call('processing:get', { id: found[0].id })).document!
}
async function project(documentId: string): Promise<ClipProject> { return (await call('clipping:get', { documentId })).clipProject! }
async function draft(prefix: string, mediaPrefix?: string): Promise<{ document: ProcessingDocument; project: ClipProject; draft: Draft }> {
  const documents = mediaPrefix ? [await media(mediaPrefix)] : await Promise.all((await state()).processing.documents.map(doc => call('processing:get', { id: doc.id }).then(reply => reply.document!)))
  const found: { document: ProcessingDocument; project: ClipProject; draft: Draft }[] = []
  for (const document of documents) { const current = await project(document.id); for (const item of current.drafts) if (item.id.startsWith(prefix)) found.push({ document, project: current, draft: item }) }
  if (found.length !== 1) throw new Failure(found.length ? `More than one draft id starts with ${prefix}.` : `No draft ${prefix}; see \`clipper drafts list <media>\`.`)
  return found[0]
}
const latestCandidates = (current: ClipProject) => {
  const run = current.runs[0]
  return run?.candidateIds ? run.candidateIds.flatMap(id => current.candidates.find(item => item.id === id) || []) : current.candidates.filter(item => item.runId === run?.id)
}
const busy = (doc: ProcessingDocument) => doc.status === 'running' || doc.status === 'queued'
// Polls a document while `work` (a blocking request, or nothing) runs, writing progress to stderr.
async function follow(id: string, work?: Promise<Ok>, timeout = 0): Promise<ProcessingDocument> {
  const started = Date.now()
  let settled = !work, failure: unknown
  void work?.then(() => { settled = true }, error => { settled = true; failure = error })
  for (;;) {
    await sleep(1000)
    const doc = (await call('processing:get', { id })).document!
    progress(`${doc.stage || doc.status} ${doc.progress !== undefined ? Math.round(doc.progress * 100) + '%' : ''}${doc.eta !== undefined ? ` · ${clock(doc.eta * 1000)} left` : ''}`)
    if (settled && !busy(doc)) {
      done()
      if (failure) throw failure
      if (doc.status === 'waiting-model') throw new Failure(`Model ${doc.model} is not installed; download it in the client (Settings → Models).`, EXIT.precondition)
      if (doc.status === 'failed') throw new Failure(doc.error || 'Processing failed.')
      if (doc.status === 'cancelled') throw new Failure('Processing was cancelled.')
      return doc
    }
    if (timeout && Date.now() - started > timeout * 1000) { done(); throw new Failure(`Still running after ${timeout} seconds.`, EXIT.failed, { status: doc.status, progress: doc.progress }) }
  }
}
async function followTask(documentId: string, taskId: string, kind: 'run' | 'render' | 'cover', timeout = 0) {
  const started = Date.now()
  for (;;) {
    const current = await project(documentId)
    const task = kind === 'run' ? current.runs.find(item => item.id === taskId) : kind === 'render' ? current.renders.find(item => item.id === taskId) : current.covers?.find(item => item.id === taskId)
    if (!task) throw new Failure('The task disappeared.')
    const share = 'progress' in task && typeof task.progress === 'number' ? ` ${Math.round(task.progress * 100)}%` : 'windows' in task ? ` ${task.windows.filter(window => window.status === 'completed').length}/${task.windows.length}` : ''
    progress(`${task.status}${share}`)
    if (!['queued', 'running'].includes(task.status)) {
      done()
      if (task.status !== 'completed' && task.status !== 'partial') throw new Failure(task.error || `Task ${task.status}.`, EXIT.failed, { project: current.documentId })
      return { project: current, task }
    }
    if (timeout && Date.now() - started > timeout * 1000) { done(); throw new Failure(`Still running after ${timeout} seconds.`) }
    await sleep(1000)
  }
}

// --- Views. ---
const mediaView = (doc: ProcessingDocument) => ({ id: doc.id, title: doc.title, source: doc.sourceName, durationSeconds: doc.durationSeconds, status: doc.status, captions: doc.captions.length, activeTrack: doc.activeTrack, tracks: doc.tracks.length, subtitleStyle: doc.subtitleStyle || 'classic', sourceUrl: doc.sourceUrl })
const trackView = (doc: ProcessingDocument) => doc.tracks.map(track => ({ id: track.id, language: track.language, source: track.source === 'platform' ? track.automatic ? 'automatic' : 'human' : track.source, name: track.name, captions: track.count, active: track.id === doc.activeTrack }))
const draftView = (item: Draft) => ({ id: item.id, title: item.title, revision: item.revision, scenes: item.scenes.length, durationMs: item.scenes.reduce((sum, scene) => sum + scene.endMs - scene.startMs, 0), settings: item.settings })
const outPath = (file: string) => path.resolve(file)

const program = new Command('clipper')
  .description('Drive Galaxy Clipper from a terminal or an agent: media, subtitles, AI selection, drafts and exports.')
  .option('--json', 'print one JSON object to stdout (for scripts and agents)')
  .hook('preAction', command => { json = Boolean(command.opts().json) })
  .showHelpAfterError()

program.command('status').description('the client version, media engine and output folder').action(async () => {
  const reply = await call('cli:hello', null), { tools, settings, processing, styles } = reply.state
  output({ version: reply.version, engine: tools.engine, ffmpeg: tools.ffmpeg, outputDirectory: settings.outputDirectory, captionLanguages: settings.captionLanguages, analysisConfigured: Boolean(reply.state.clipping.settings.analysis.baseUrl), media: processing.documents.length, subtitleStyles: styles.subtitle.length, coverStyles: styles.cover.length }, () => {
    console.log(`Galaxy Clipper ${reply.version}`)
    console.log(`engine    ${tools.engine ? 'ready' : `unavailable ${tools.error || ''}`}`)
    console.log(`output    ${settings.outputDirectory}`)
    console.log(`languages ${settings.captionLanguages.join(', ')}`)
    console.log(`AI picks  ${reply.state.clipping.settings.analysis.baseUrl ? 'configured' : 'not configured (Settings → Cloud)'}`)
  })
})

// ① Media
const mediaCommand = program.command('media').description('① import and list source media')
mediaCommand.command('import').argument('<file>', 'a local video or audio file; it is referenced, never copied').description('import a source file').action(async (file: string) => {
  const doc = (await call('cli:media-import', { file: outPath(file) })).document!
  output({ media: mediaView(doc) }, () => console.log(`${doc.id}  ${doc.title}  ${clock(doc.durationSeconds * 1000)}  ${doc.captions.length} captions`))
})
mediaCommand.command('list').description('every imported media').action(async () => {
  const list = (await state()).processing.documents
  output({ media: list.map(doc => ({ id: doc.id, title: doc.title, source: doc.sourceName, durationSeconds: doc.durationSeconds, status: doc.status, captions: doc.captionCount })) }, () => table([['id', 'length', 'captions', 'status', 'title'], ...list.map(doc => [doc.id.slice(0, 8), clock(doc.durationSeconds * 1000), String(doc.captionCount), doc.status, doc.title.slice(0, 60)])]))
})
mediaCommand.command('show').argument('<media>', 'media id or prefix').description('one media in full').action(async (prefix: string) => {
  const doc = await media(prefix)
  output({ media: mediaView(doc), tracks: trackView(doc) }, () => { for (const [key, value] of Object.entries(mediaView(doc))) if (value !== undefined) console.log(`${key.padEnd(14)}${value}`) })
})
mediaCommand.command('remove').argument('<media>', 'media id or prefix').description('remove the record (the source file stays)').action(async (prefix: string) => {
  const doc = await media(prefix)
  await call('processing:remove', { id: doc.id })
  output({ removed: doc.id }, () => console.log(`removed ${doc.title}`))
})

// ② Subtitles
const subtitles = program.command('subtitles').description('② get, choose and read subtitle tracks')
subtitles.command('fetch').argument('<media>', 'media id or prefix').description('fetch platform subtitles (files only, no media) for the caption languages in Settings')
  .option('--url <url>', 'the source page; defaults to the URL found in the media metadata')
  .option('--no-auto', 'only human subtitles, never automatic ones')
  .action(async (prefix: string, options: { url?: string; auto: boolean }) => {
    const doc = await media(prefix), url = options.url || doc.sourceUrl
    if (!url) throw new Failure('This media has no source URL in its metadata; pass --url.', EXIT.precondition)
    const result = await follow(doc.id, call('processing:platform', { id: doc.id, url, automatic: options.auto }))
    output({ media: mediaView(result), tracks: trackView(result) }, () => table([['id', 'language', 'source', 'captions', ''], ...trackView(result).map(track => [track.id.slice(0, 8), track.language, track.source, String(track.captions), track.active ? 'active' : ''])]))
  })
subtitles.command('recognize').argument('<media>', 'media id or prefix').description('recognize speech with a local (or the configured remote) model')
  .option('--model <id>', 'a model id from Settings → Models; defaults to the setting')
  .option('--speakers <n>', "speaker count, or 'auto'")
  .option('--wait', 'wait for recognition to finish')
  .option('--timeout <seconds>', 'give up waiting after this long (0: never)', '0')
  .action(async (prefix: string, options: { model?: string; speakers?: string; wait?: boolean; timeout: string }) => {
    const doc = await media(prefix)
    const speakers = options.speakers === undefined ? undefined : options.speakers === 'auto' ? 'auto' : Number(options.speakers)
    await call('processing:run', { id: doc.id, action: 'recognize', model: options.model, speakers })
    if (!options.wait) { output({ media: doc.id, queued: true }, () => console.log(`queued recognition for ${doc.title}; follow with \`clipper media show ${doc.id.slice(0, 8)}\``)); return }
    const result = await follow(doc.id, undefined, Number(options.timeout))
    output({ media: mediaView(result), tracks: trackView(result) }, () => console.log(`${result.captions.length} captions recognized`))
  })
subtitles.command('import').argument('<media>', 'media id or prefix').argument('<file>', 'an SRT, VTT or ASS file').description('add a subtitle file as a track').action(async (prefix: string, file: string) => {
  const doc = await media(prefix), result = (await call('cli:captions-import', { id: doc.id, file: outPath(file) })).document!
  output({ media: mediaView(result), tracks: trackView(result) }, () => console.log(`${result.captions.length} captions imported`))
})
subtitles.command('tracks').argument('<media>', 'media id or prefix').description('the subtitle tracks of a media').action(async (prefix: string) => {
  const doc = await media(prefix)
  output({ tracks: trackView(doc) }, () => table([['id', 'language', 'source', 'captions', ''], ...trackView(doc).map(track => [track.id.slice(0, 8), track.language, track.source, String(track.captions), track.active ? 'active' : ''])]))
})
subtitles.command('use').argument('<media>', 'media id or prefix').argument('<track>', 'track id prefix or language').description('make a track the active one (used by AI selection and exports)').action(async (prefix: string, wanted: string) => {
  const doc = await media(prefix), found = doc.tracks.filter(track => track.id.startsWith(wanted) || track.language.toLowerCase() === wanted.toLowerCase())
  if (found.length !== 1) throw new Failure(found.length ? `More than one track matches ${wanted}.` : `No track ${wanted}.`)
  const result = (await call('processing:track', { id: doc.id, trackId: found[0].id })).document!
  output({ tracks: trackView(result) }, () => console.log(`active track: ${found[0].language} (${found[0].name})`))
})
subtitles.command('show').argument('<media>', 'media id or prefix').description('the captions of the active track')
  .option('--limit <n>', 'at most this many captions (0: all)', '0')
  .action(async (prefix: string, options: { limit: string }) => {
    const doc = await media(prefix), limit = Number(options.limit), captions = limit ? doc.captions.slice(0, limit) : doc.captions
    output({ media: doc.id, captions: captions.map(cue => ({ id: cue.id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text, speaker: doc.speakers.find(item => item.id === cue.speakerId)?.name })) }, () => { for (const cue of captions) console.log(`${clock(cue.startMs)}-${clock(cue.endMs)}  ${cue.text}`) })
  })
subtitles.command('style').argument('<media>', 'media id or prefix').argument('<style>', 'a subtitle style id from `clipper styles list`').description('set the default subtitle style (new drafts and burn-in start with it)').action(async (prefix: string, style: string) => {
  const doc = await media(prefix)
  if (!(await state()).styles.subtitle.some(item => item.id === style)) throw new Failure(`No subtitle style ${style}.`)
  await call('processing:style', { id: doc.id, style })
  output({ media: doc.id, subtitleStyle: style }, () => console.log(`default subtitle style: ${style}`))
})

// ③ AI selection
program.command('analyze').argument('<media>', 'media id or prefix').description('③ let the configured cloud text model pick candidate clips from the subtitles')
  .option('--count <n>', 'candidates to keep', '8').option('--min <seconds>', 'shortest clip', '30').option('--max <seconds>', 'longest clip', '180')
  .option('--instruction <text>', 'what to look for', '')
  .option('--wait', 'wait for the selection to finish').option('--timeout <seconds>', 'give up waiting after this long (0: never)', '0')
  .action(async (prefix: string, options: { count: string; min: string; max: string; instruction: string; wait?: boolean; timeout: string }) => {
    const doc = await media(prefix), current = await state()
    if (!doc.captions.length) throw new Failure('AI selection reads subtitles: fetch, recognize or import them first.', EXIT.precondition)
    if (!current.clipping.settings.analysis.baseUrl) throw new Failure('No cloud text model is configured (Settings → Cloud).', EXIT.precondition)
    const reply = await call('clipping:analyze', { documentId: doc.id, options: { count: Number(options.count), minSeconds: Number(options.min), maxSeconds: Number(options.max), instruction: options.instruction } })
    const run = reply.clipProject!.runs[0]
    if (!options.wait) { output({ media: doc.id, run: run.id, status: run.status }, () => console.log(`selection ${run.status}; list with \`clipper candidates ${doc.id.slice(0, 8)}\``)); return }
    const { project: finished } = await followTask(doc.id, run.id, 'run', Number(options.timeout))
    const list = latestCandidates(finished)
    output({ media: doc.id, candidates: list.map((item, index) => ({ index: index + 1, ...item })) }, () => table([['#', 'range', 'score', 'title'], ...list.map((item, index) => [String(index + 1), `${clock(item.startMs)}-${clock(item.endMs)}`, String(Math.round(item.score * 100)), item.title.slice(0, 60)])]))
  })
program.command('candidates').argument('<media>', 'media id or prefix').description('the candidates of the latest AI selection').action(async (prefix: string) => {
  const doc = await media(prefix), list = latestCandidates(await project(doc.id))
  output({ media: doc.id, candidates: list.map((item, index) => ({ index: index + 1, ...item })) }, () => table([['#', 'range', 'score', 'title'], ...list.map((item, index) => [String(index + 1), `${clock(item.startMs)}-${clock(item.endMs)}`, String(Math.round(item.score * 100)), item.title.slice(0, 60)])]))
})

// ④ Drafts
const drafts = program.command('drafts').description('④ build drafts from candidates and adjust them')
drafts.command('create').argument('<media>', 'media id or prefix').description('create drafts from candidates (one each, or --combined into one)')
  .requiredOption('--candidates <list>', "candidate numbers from `clipper candidates`: '1,3-5', or 'all'")
  .option('--combined', 'put the candidates into one draft')
  .action(async (prefix: string, options: { candidates: string; combined?: boolean }) => {
    const doc = await media(prefix), list = latestCandidates(await project(doc.id))
    if (!list.length) throw new Failure('No candidates yet; run `clipper analyze` first.', EXIT.precondition)
    const picked = new Set<number>()
    if (options.candidates === 'all') list.forEach((_, index) => picked.add(index + 1))
    else for (const part of options.candidates.split(',').map(value => value.trim()).filter(Boolean)) {
      const [from, to] = part.split('-').map(Number)
      if (!Number.isInteger(from) || to !== undefined && !Number.isInteger(to)) throw new Failure(`Not a candidate number or range: ${part}`)
      for (let at = from; at <= (to ?? from); at++) { if (at < 1 || at > list.length) throw new Failure(`Candidate ${at} does not exist; there are ${list.length}.`); picked.add(at) }
    }
    const reply = await call('clipping:create', { documentId: doc.id, candidateIds: [...picked].sort((a, b) => a - b).map(index => list[index - 1].id), separate: !options.combined })
    const created = reply.clipProject!.drafts.slice(0, options.combined ? 1 : picked.size)
    output({ media: doc.id, drafts: created.map(draftView) }, () => table([['id', 'scenes', 'length', 'title'], ...created.map(item => [item.id.slice(0, 8), String(item.scenes.length), clock(draftView(item).durationMs), item.title.slice(0, 60)])]))
  })
drafts.command('list').argument('<media>', 'media id or prefix').description('the drafts of a media').action(async (prefix: string) => {
  const doc = await media(prefix), list = (await project(doc.id)).drafts
  output({ media: doc.id, drafts: list.map(draftView) }, () => table([['id', 'scenes', 'length', 'aspect', 'subtitles', 'title'], ...list.map(item => [item.id.slice(0, 8), String(item.scenes.length), clock(draftView(item).durationMs), item.settings.aspect, item.settings.subtitles ? item.settings.subtitleStyle : 'off', item.title.slice(0, 50)])]))
})
const onOff = (value: string) => { if (value !== 'on' && value !== 'off') throw new Failure(`Use on or off, not ${value}.`); return value === 'on' }
drafts.command('set').argument('<draft>', 'draft id or prefix').description('change a draft (only the options given)')
  .option('--media <media>', 'narrow the draft search to one media')
  .option('--title <text>').addOption(new Option('--aspect <aspect>').choices(['original', 'portrait', 'landscape'])).addOption(new Option('--layout <layout>').choices(['fit', 'crop', 'blur']))
  .addOption(new Option('--resolution <p>').choices(['original', '2160', '1440', '1080', '720', '480']))
  .option('--subtitles <on|off>').option('--style <id>', 'subtitle style id').option('--opening <text>', 'opening title shown for three seconds').option('--audio <on|off>', 'keep the original audio')
  .option('--cover-style <id>', 'cover style id').option('--cover-title <text>').option('--cover-subtitle <text>')
  .action(async (prefix: string, options: Record<string, string | undefined>) => {
    const { document, draft: current } = await draft(prefix, options.media), library = await state()
    if (options.style && !library.styles.subtitle.some(item => item.id === options.style)) throw new Failure(`No subtitle style ${options.style}.`)
    if (options.coverStyle && !library.styles.cover.some(item => item.id === options.coverStyle)) throw new Failure(`No cover style ${options.coverStyle}.`)
    const settings = { ...current.settings }
    if (options.aspect) settings.aspect = options.aspect as Draft['settings']['aspect']
    if (options.layout) settings.layout = options.layout as Draft['settings']['layout']
    if (options.resolution) settings.resolution = options.resolution as Draft['settings']['resolution']
    if (options.subtitles) settings.subtitles = onOff(options.subtitles)
    if (options.style) settings.subtitleStyle = options.style
    if (options.opening !== undefined) settings.title = options.opening
    if (options.audio) settings.originalAudio = onOff(options.audio)
    if (options.coverStyle || options.coverTitle !== undefined || options.coverSubtitle !== undefined) settings.cover = { ...(settings.cover || { enabled: true, style: 'knowledge', palette: 'azure', aspect: 'video', title: '', subtitle: '', badge: '' }), ...(options.coverStyle ? { style: options.coverStyle } : {}), ...(options.coverTitle !== undefined ? { title: options.coverTitle } : {}), ...(options.coverSubtitle !== undefined ? { subtitle: options.coverSubtitle } : {}) }
    const reply = await call('clipping:save', { documentId: document.id, id: current.id, revision: current.revision, title: options.title ?? current.title, scenes: current.scenes, settings })
    const saved = reply.clipProject!.drafts.find(item => item.id === current.id)!
    output({ draft: draftView(saved) }, () => console.log(`saved ${saved.title} (version ${saved.revision})`))
  })

// ⑥ Export
const exporting = program.command('export').description('⑥ export subtitle files, videos, clips and covers to a new file')
exporting.command('captions').argument('<media>', 'media id or prefix').description('the active track as a subtitle or text file')
  .addOption(new Option('--format <format>').choices(['srt', 'vtt', 'txt', 'md']).default('srt')).requiredOption('--out <file>', 'a new file')
  .action(async (prefix: string, options: { format: string; out: string }) => {
    const doc = await media(prefix)
    if (!doc.captions.length) throw new Failure('No subtitles to export.', EXIT.precondition)
    await call('cli:export', { id: doc.id, format: options.format, output: outPath(options.out) })
    output({ file: outPath(options.out) }, () => console.log(outPath(options.out)))
  })
exporting.command('video').argument('<media>', 'media id or prefix').description('the source video with subtitles burned in, as soft tracks, or none')
  .addOption(new Option('--captions <mode>').choices(['none', 'current', 'bilingual']).default('current'))
  .addOption(new Option('--method <method>').choices(['burn', 'soft']).default('burn'))
  .option('--style <id>', 'subtitle style for burn-in; defaults to the media default').requiredOption('--out <file>', 'a new .mp4 or .mkv file')
  .action(async (prefix: string, options: { captions: string; method: string; style?: string; out: string }) => {
    const doc = await media(prefix)
    if (options.captions !== 'none' && !doc.captions.length) throw new Failure('No subtitles to add; fetch, recognize or import them first.', EXIT.precondition)
    if (options.captions === 'bilingual' && !doc.bilingual) throw new Failure('Bilingual output needs a Chinese and an English subtitle track.', EXIT.precondition)
    await follow(doc.id, call('cli:export', { id: doc.id, format: options.captions === 'none' ? 'video' : options.method, captions: options.captions === 'bilingual' ? 'bilingual' : 'current', style: options.style, output: outPath(options.out) }))
    output({ file: outPath(options.out) }, () => console.log(outPath(options.out)))
  })
exporting.command('clip').argument('<draft>', 'draft id or prefix').description('render a draft to a new MP4')
  .option('--media <media>', 'narrow the draft search to one media').requiredOption('--out <file>', 'a new .mp4 file')
  .option('--wait', 'wait for the render to finish').option('--timeout <seconds>', 'give up waiting after this long (0: never)', '0')
  .action(async (prefix: string, options: { media?: string; out: string; wait?: boolean; timeout: string }) => {
    const { document, draft: current } = await draft(prefix, options.media)
    const reply = await call('cli:clip-export', { documentId: document.id, draftId: current.id, output: outPath(options.out) })
    const job = reply.clipProject!.renders.find(item => item.draftId === current.id && !item.preview)!
    if (!options.wait) { output({ task: job.id, status: job.status, file: outPath(options.out) }, () => console.log(`render ${job.status}: ${outPath(options.out)}`)); return }
    await followTask(document.id, job.id, 'render', Number(options.timeout))
    output({ task: job.id, file: outPath(options.out) }, () => console.log(outPath(options.out)))
  })
exporting.command('cover').argument('<draft>', 'draft id or prefix').description("generate the draft's cover and save it as a new JPG")
  .option('--media <media>', 'narrow the draft search to one media').requiredOption('--out <file>', 'a new .jpg file')
  .option('--timeout <seconds>', 'give up waiting after this long (0: never)', '0')
  .action(async (prefix: string, options: { media?: string; out: string; timeout: string }) => {
    const { document, draft: current } = await draft(prefix, options.media)
    const reply = await call('clipping:cover', { documentId: document.id, draftId: current.id, revision: current.revision })
    const job = reply.clipProject!.covers?.find(item => item.draftId === current.id && item.revision === current.revision)
    if (!job) throw new Failure('The cover task was not created.')
    await followTask(document.id, job.id, 'cover', Number(options.timeout))
    await call('cli:cover-export', { documentId: document.id, coverId: job.id, output: outPath(options.out) })
    output({ file: outPath(options.out) }, () => console.log(outPath(options.out)))
  })

// Styles (created and edited in the client; read here)
const styles = program.command('styles').description('subtitle and cover styles shared by every project')
styles.command('list').addOption(new Option('--kind <kind>').choices(['subtitle', 'cover'])).description('built-in and custom styles').action(async (options: { kind?: 'subtitle' | 'cover' }) => {
  const library = (await state()).styles
  const rows = (['subtitle', 'cover'] as const).filter(kind => !options.kind || kind === options.kind).flatMap(kind => library[kind].map(style => ({ kind, id: style.id, name: style.builtIn ? style.id : style.name, builtIn: style.builtIn, base: style.base, version: style.version })))
  output({ styles: rows }, () => table([['kind', 'id', 'name', 'base'], ...rows.map(row => [row.kind, row.id, row.name + (row.builtIn ? ' (built-in)' : ''), row.base])]))
})
styles.command('show').argument('<id>', 'style id').description('the parameters of one style').action(async (id: string) => {
  const library = (await state()).styles, style = library.subtitle.find(item => item.id === id) || library.cover.find(item => item.id === id)
  if (!style) throw new Failure(`No style ${id}.`)
  output({ style }, () => console.log(JSON.stringify(style, null, 2)))
})

program.parseAsync(process.argv).catch((error: unknown) => {
  const failure = error instanceof Failure ? error : new Failure(error instanceof Error ? error.message : String(error))
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: failure.message, exitCode: failure.code, ...failure.detail })}\n`)
  else process.stderr.write(`clipper: ${failure.message}\n`)
  process.exitCode = failure.code
})

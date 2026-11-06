import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FilePlus2, Globe, ImageIcon, Mic, Play, Search, Trash2, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn, formatDuration } from '@/lib/utils'
import { Choice } from './Choice'
import { TranscriptionMode } from './CloudServices'
import { Blank, Panel, Stage, TaskCard, VideoPreview, rangeLabel } from './Panes'
import { CaptionedVideo, StylePicker, styleParams } from './Styles'
import type { Send } from '@/App'
import type { ClientState } from '../../../shared/contracts'
import type { Caption, CaptionTrack, ModelId, ProcessingDocument } from '../../../shared/processing'

const audioOnly = (document: ProcessingDocument) => /\.(mp3|wav|m4a|flac|ogg|opus|aac)$/i.test(document.sourceName)
export const cueAt = (captions: Caption[], ms: number) => captions.find(cue => cue.startMs <= ms && cue.endMs > ms)
export const trackRole = (language: string) => /^zh(?:-|$)/i.test(language) ? 'zh' : /^en(?:-|$)/i.test(language) ? 'en' : 'other'
/** Human, automatic, recognized or file — what a track card shows next to its language. */
export function useTrackSource() {
  const { t } = useTranslation('editor')
  return (track: CaptionTrack) => t(`subtitlePage.sources.${track.source === 'platform' ? track.automatic ? 'automatic' : 'human' : track.source}` as 'subtitlePage.sources.human')
}
export function TaskStatus({ document, send }: { document: ProcessingDocument; send: Send }) {
  const { t: p } = useTranslation('processing'), { t: c } = useTranslation('clipping')
  const busy = document.status === 'running' || document.status === 'queued'
  const interesting = busy || document.error || document.retryable || document.status === 'waiting-model'
  return <TaskCard status={interesting ? p(`statuses.${document.status}`) : undefined} detail={document.stage ? p(`stages.${document.stage}` as 'stages.recognizing', { defaultValue: document.stage }) : undefined} progress={busy ? document.progress || 0 : undefined} eta={busy ? document.eta : undefined} error={document.error} onCancel={busy ? () => void send('processing:cancel', { id: document.id }) : undefined}>
    {document.retryable && <Button size="sm" variant="outline" onClick={() => void send('processing:retry', { id: document.id })}>{c('retryTranscription')}</Button>}
    {document.status === 'waiting-model' && document.model && <Button size="sm" onClick={() => void send('models:download', { id: document.model! })}><Download data-icon="inline-start" />{p('downloadContinue')}</Button>}
  </TaskCard>
}

/** ① Media: the source list, the original and its facts. */
export function MediaWorkspace({ state, document, selected, choose, importMedia, importProject, send }: { state: ClientState; document?: ProcessingDocument; selected: string; choose: (id: string) => void; importMedia: () => Promise<void>; importProject: () => Promise<void>; send: Send }) {
  const { t } = useTranslation('editor'), { t: p } = useTranslation('processing')
  return <><Panel side="library" title={t('media')} detail={t('mediaCount', { count: state.processing.documents.length })} actions={<Button size="icon-sm" variant="ghost" aria-label={t('importMedia')} onClick={() => void importMedia()}><FilePlus2 /></Button>}>
    {state.processing.documents.map(doc => <button key={doc.id} onClick={() => choose(doc.id)} className={cn('editor-list-item', selected === doc.id && 'is-selected')} aria-pressed={selected === doc.id}><div className="flex items-start gap-3"><div className="rounded-md border p-2"><Play className="size-4" /></div><span className="min-w-0 flex-1"><span className="block line-clamp-2 text-sm font-medium">{doc.title}</span><span className="mt-2 block text-xs text-muted-foreground">{formatDuration(doc.durationSeconds)} · {doc.sourceName.split('.').at(-1)?.toUpperCase()}</span></span></div><span className="mt-3 block text-xs text-muted-foreground">{t('captionCount', { count: doc.captionCount })}</span></button>)}
    {!state.processing.documents.length && <Blank title={t('noMedia')} detail={t('importHint')}><Button onClick={() => void importMedia()}>{t('importMedia')}</Button><Button variant="outline" onClick={() => void importProject()}>{t('importProject')}</Button></Blank>}
  </Panel><Stage title={t('sourcePreview')} detail={document?.sourceName}><VideoPreview document={document} /></Stage><Panel side="inspector" title={t('mediaProperties')}>
    {document ? <><div><h3 className="font-medium">{document.title}</h3><p className="mt-2 break-all text-xs text-muted-foreground">{document.sourceName}</p></div><dl className="editor-metadata"><dt>{t('duration')}</dt><dd>{formatDuration(document.durationSeconds)}</dd><dt>{t('subtitles')}</dt><dd>{document.captions.length}</dd><dt>{t('subtitlePage.tracks')}</dt><dd>{document.tracks.length}</dd><dt>{t('status')}</dt><dd>{p(`statuses.${document.status}`)}</dd>{document.sourceUrl && <><dt>{t('subtitlePage.sourceUrl')}</dt><dd className="break-all">{document.sourceUrl}</dd></>}</dl><p className="text-xs leading-relaxed text-muted-foreground">{t('sourceProtected')}</p><Button variant="ghost" onClick={() => void send('processing:remove', { id: document.id }).then(reply => { if (reply) choose(state.processing.documents.find(doc => doc.id !== document.id)?.id || '') })}><Trash2 data-icon="inline-start" />{t('removeProject')}</Button></> : <Blank title={t('emptyTitle')} detail={t('emptyHint')} />}
  </Panel></>
}

type SourceMode = 'platform' | 'recognize' | 'file'
/** ② Subtitles: tracks and cues on the left, styled preview with an edit bar, sources on the right. */
export function SubtitleWorkspace({ state, document, send, settings }: { state: ClientState; document?: ProcessingDocument; send: Send; settings: (section: 'models' | 'cloud') => void }) {
  const { t } = useTranslation('editor'), { t: p } = useTranslation('processing'), { t: c } = useTranslation('clipping'), source = useTrackSource()
  const [query, setQuery] = useState(''), search = useDeferredValue(query), [speaker, setSpeaker] = useState('all'), [edit, setEdit] = useState<Caption>()
  const [model, setModel] = useState<ModelId>(state.settings.transcriptionModel), [speakers, setSpeakers] = useState(state.settings.transcriptionSpeakers)
  const [requesting, setRequesting] = useState(false), [mode, setMode] = useState<SourceMode>('platform'), [now, setNow] = useState(0), [frame, setFrame] = useState<string>()
  const player = useRef<HTMLVideoElement>(null), busy = document?.status === 'running' || document?.status === 'queued', remote = state.clipping.settings.route === 'remote'
  const cues = useMemo(() => document?.captions.filter(cue => (speaker === 'all' || cue.speakerId === speaker) && (!search || cue.text.toLowerCase().includes(search.toLowerCase()))) || [], [document, search, speaker])
  const cue = edit && document?.captions.some(item => item.id === edit.id) ? edit : undefined
  const seek = (ms: number) => { if (player.current) { player.current.currentTime = ms / 1000; void player.current.play().catch(() => {}) } }
  const run = async (action: 'transcribe' | 'recognize' | 'speakers') => { if (!document) return; setRequesting(true); await send('processing:run', { id: document.id, action, model, speakers }); setRequesting(false) }
  if (!document) return <><Panel side="library" title={t('subtitles')}><Blank title={t('selectMedia')} /></Panel><Stage title={t('sourcePreview')}><VideoPreview /></Stage><Panel side="inspector" title={t('subtitlePage.sources.title')}><Blank title={t('selectMedia')} /></Panel></>
  const params = styleParams(state, document.subtitleStyle), shown = cue ? cue.text : cueAt(document.captions, now)?.text || ''
  const pickSource = (value: SourceMode) => { setMode(value); if (value === 'file') void send('processing:captions', { id: document.id }) }
  return <><Panel side="library" title={t('subtitles')} detail={t('captionCount', { count: document.captions.length })}>
    <div className="flex items-center justify-between"><span className="editor-section-title">{t('subtitlePage.tracks')}</span></div>
    {document.tracks.map(track => <button key={track.id} disabled={busy} onClick={() => { setEdit(undefined); void send('processing:track', { id: document.id, trackId: track.id }) }} className={cn('editor-list-item', track.id === document.activeTrack && 'is-selected')} aria-pressed={track.id === document.activeTrack}><span className="flex items-center gap-2"><span className="text-sm font-medium">{track.language}</span><Badge variant="outline">{source(track)}</Badge><span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{t('captionCount', { count: track.count ?? 0 })}</span></span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{track.name}</span></button>)}
    <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={t('subtitlePage.add')}>{([['platform', Globe], ['recognize', Mic], ['file', FilePlus2]] as const).map(([value, Icon]) => <Button key={value} size="sm" variant={mode === value ? 'secondary' : 'outline'} disabled={busy} className="h-auto flex-col gap-1 py-2 text-[11px]" onClick={() => pickSource(value)}><Icon />{t(`subtitlePage.modes.${value}`)}</Button>)}</div>
    {document.captions.length > 0 && <><div className="relative"><Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input aria-label={p('search')} placeholder={t('searchCaptions')} className="pl-8" value={query} onChange={event => setQuery(event.target.value)} /></div>
      {document.speakers.length > 0 && <><Choice label={p('speaker')} value={speaker} onChange={setSpeaker} options={[{ value: 'all', label: p('allSpeakers') }, ...document.speakers.map(item => ({ value: item.id, label: item.name }))]} />
        <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t('subtitlePage.renameSpeakers')}</summary><div className="mt-2 flex flex-col gap-2">{document.speakers.map(item => <form key={item.id} className="flex gap-2" onSubmit={event => { event.preventDefault(); const name = String(new FormData(event.currentTarget).get('name') || '').trim(); if (name) void send('processing:speaker', { id: document.id, speakerId: item.id, name }) }}><Input key={item.name} name="name" defaultValue={item.name} aria-label={p('name')} /><Button type="submit" size="sm" variant="outline" disabled={busy}>{p('rename')}</Button></form>)}</div></details></>}</>}
    <div className="flex flex-col gap-2">{cues.map(item => <button key={item.id} className={cn('editor-list-item [content-visibility:auto] [contain-intrinsic-size:auto_100px]', cue?.id === item.id && 'is-selected')} onClick={() => { setEdit({ ...item }); setFrame(undefined); seek(item.startMs) }}><span className="flex items-center justify-between text-[11px] text-muted-foreground"><span>{rangeLabel(item.startMs, item.endMs)}</span><span>{document.speakers.find(entry => entry.id === item.speakerId)?.name}</span></span><span className="mt-2 block text-sm leading-relaxed">{item.text}</span></button>)}</div>
    {!cues.length && <Blank title={document.captions.length ? p('noMatches') : t('noCaptions')} detail={t('subtitlePage.emptyHint')} />}
  </Panel><Stage title={frame ? t('subtitlePage.realFrame') : t('sourcePreview')} detail={cue ? rangeLabel(cue.startMs, cue.endMs) : document.sourceName}
    actions={!audioOnly(document) && document.captions.length > 0 ? frame ? <Button size="sm" variant="ghost" onClick={() => setFrame(undefined)}><Video data-icon="inline-start" />{t('subtitlePage.backToVideo')}</Button> : <Button size="sm" variant="ghost" disabled={requesting} onClick={() => { setRequesting(true); void send('processing:frame', { id: document.id, timeMs: Math.round((player.current?.currentTime || 0) * 1000), captions: 'current' }).then(reply => { if (reply?.frame) setFrame(reply.frame) }).finally(() => setRequesting(false)) }}><ImageIcon data-icon="inline-start" />{t('subtitlePage.renderFrame')}</Button> : undefined}
    footer={cue ? <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); setRequesting(true); void send('processing:edit', { id: document.id, revision: document.revision, captionId: cue.id, text: cue.text, startMs: cue.startMs, endMs: cue.endMs, speakerId: cue.speakerId }).then(reply => { if (reply) setEdit(undefined) }).finally(() => setRequesting(false)) }}>
      <Textarea aria-label={p('text')} value={cue.text} maxLength={20000} rows={2} className="min-h-0 text-sm" onChange={event => setEdit({ ...cue, text: event.target.value })} />
      <div className="flex flex-wrap items-center gap-2"><span className="tabular-nums">{rangeLabel(cue.startMs, cue.endMs)}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => { const at = Math.round((player.current?.currentTime || 0) * 1000); if (at < cue.endMs) setEdit({ ...cue, startMs: at }) }}>{t('subtitlePage.setStart')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => { const at = Math.round((player.current?.currentTime || 0) * 1000); if (at > cue.startMs) setEdit({ ...cue, endMs: at }) }}>{t('subtitlePage.setEnd')}</Button>
        {document.speakers.length > 0 && <Choice hideLabel className="w-36" label={p('speaker')} value={cue.speakerId || 'none'} onChange={speakerId => setEdit({ ...cue, speakerId: speakerId === 'none' ? null : speakerId })} options={[{ value: 'none', label: p('unknown') }, ...document.speakers.map(item => ({ value: item.id, label: item.name }))]} />}
        <span className="ml-auto flex gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setEdit(undefined)}>{t('cancel')}</Button><Button type="submit" size="sm" disabled={busy || requesting || cue.endMs <= cue.startMs || !cue.text.trim()}>{p('save')}</Button></span></div>
    </form> : t('subtitlePage.editHint')}>
    {frame ? <img alt={t('subtitlePage.realFrame')} src={frame} className="max-h-full max-w-full rounded-lg object-contain" /> : audioOnly(document) ? <VideoPreview document={document} player={player} /> : <CaptionedVideo document={document} player={player} params={params} rows={[shown]} onTimeUpdate={() => setNow((player.current?.currentTime || 0) * 1000)} />}
  </Stage><Panel side="inspector" title={t('subtitlePage.sources.title')}>
    <TaskStatus document={document} send={send} />
    <ToggleGroup variant="outline" size="sm" value={[mode]} onValueChange={values => { if (values[0]) setMode(values[0] as SourceMode) }} aria-label={t('subtitlePage.add')} className="grid w-full grid-cols-3">{(['platform', 'recognize', 'file'] as const).map(value => <ToggleGroupItem key={value} value={value}>{t(`subtitlePage.modes.${value}`)}</ToggleGroupItem>)}</ToggleGroup>
    {mode === 'platform' && <PlatformCaptions key={document.id} document={document} languages={state.settings.captionLanguages} send={send} disabled={busy || requesting} />}
    {mode === 'recognize' && <><FieldGroup><TranscriptionMode settings={state.clipping.settings} send={send} disabled={busy || requesting} />{remote ? <p className="text-xs leading-relaxed text-muted-foreground">{c('remoteHint')}</p> : <Choice label={p('model')} value={model} disabled={busy} onChange={value => setModel(value as ModelId)} options={state.processing.models.filter(item => item.id !== 'speaker').map(item => ({ value: item.id, label: item.name + (item.ready ? ' ✓' : '') }))} />}<Choice label={p('speakers')} value={String(speakers)} disabled={busy} onChange={value => setSpeakers(value === 'auto' ? 'auto' : Number(value))} options={[{ value: 'auto', label: p('auto') }, ...Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))]} /></FieldGroup>
      <Button disabled={busy || requesting} onClick={() => void run('recognize')}><Mic data-icon="inline-start" />{t('subtitlePage.recognize')}</Button>
      {document.captions.length > 0 && <Button variant="outline" disabled={busy || requesting} onClick={() => void run('speakers')}>{p('diarize')}</Button>}
      <Button variant="ghost" onClick={() => settings(remote ? 'cloud' : 'models')}>{t(remote ? 'cloudSettings' : 'manageModels')}</Button></>}
    {mode === 'file' && <><p className="text-xs leading-relaxed text-muted-foreground">{t('subtitlePage.fileHint')}</p><Button variant="outline" disabled={busy} onClick={() => void send('processing:captions', { id: document.id })}><FilePlus2 data-icon="inline-start" />{p('importCaptions')}</Button></>}
    <div className="editor-section-title">{t('subtitlePage.defaultStyle')}</div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('subtitlePage.defaultStyleHint')}</p>
    <StylePicker kind="subtitle" value={document.subtitleStyle || 'classic'} onChange={style => void send('processing:style', { id: document.id, style })} state={state} send={send} />
  </Panel></>
}

function PlatformCaptions({ document, languages, send, disabled }: { document: ProcessingDocument; languages: string[]; send: Send; disabled: boolean }) {
  const { t: p } = useTranslation('processing')
  const [url, setUrl] = useState(document.sourceUrl || ''), [automatic, setAutomatic] = useState(true), [fetching, setFetching] = useState(false)
  const valid = /^https?:\/\/\S+$/i.test(url.trim())
  return <><FieldGroup><Field><FieldLabel htmlFor="platform-url">{p('platformUrl')}</FieldLabel><Input id="platform-url" type="url" inputMode="url" placeholder="https://" value={url} onChange={event => setUrl(event.target.value)} /></Field><Field orientation="horizontal"><Checkbox id="platform-auto" checked={automatic} onCheckedChange={checked => setAutomatic(checked)} /><FieldLabel htmlFor="platform-auto">{p('platformAutomatic')}</FieldLabel></Field></FieldGroup><p className="text-xs leading-relaxed text-muted-foreground">{p('platformHint', { languages: languages.join(', ') })}</p><Button disabled={disabled || fetching || !valid} onClick={() => { setFetching(true); void send('processing:platform', { id: document.id, url: url.trim(), automatic }).finally(() => setFetching(false)) }}><Globe data-icon="inline-start" />{p('platformFetch')}</Button></>
}

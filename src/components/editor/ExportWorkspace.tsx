import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FolderOpen, ImageIcon, Play, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, FieldLabel } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn, formatDuration } from '@/lib/utils'
import { Choice } from './Choice'
import { Blank, Panel, Stage, TaskCard, VideoPreview, rangeLabel, type Tool } from './Panes'
import { CaptionedVideo, StylePicker, styleParams, useStyleName } from './Styles'
import { CoverFile, CoverPreview, coverDefaultsFor, useCoverFrame } from './CoverWorkspace'
import { TaskStatus, cueAt, trackRole, useTrackSource } from './SourceWorkspace'
import { coverFontFace } from '../../../shared/cover-artwork'
import type { Send } from '@/App'
import type { ClientState } from '../../../shared/contracts'
import { outputResolution, type ProcessingDocument } from '../../../shared/processing'
import type { ClipProject, Draft } from '../../../shared/clipping'

type Target = { kind: 'captions' } | { kind: 'video' } | { kind: 'draft'; id: string } | { kind: 'cover'; id: string }
type VideoOptions = { captions: 'none' | 'current' | 'bilingual'; method: 'soft' | 'burn'; style: string }
const encode = (target: Target) => target.kind === 'draft' || target.kind === 'cover' ? `${target.kind}:${target.id}` : target.kind
const decode = (value: string): Target => { const [kind, id] = value.split(':'); return kind === 'draft' || kind === 'cover' ? { kind, id } : { kind: kind as 'captions' | 'video' } }

/** ⑥ Export: configure on the left, check the result in the middle, export and review history on the right. */
export function ExportWorkspace({ state, document, project, send, setTool }: { state: ClientState; document: ProcessingDocument; project?: ClipProject; send: Send; setTool: (tool: Tool) => void }) {
  const { t } = useTranslation('editor'), { t: c } = useTranslation('clipping')
  const [target, setTarget] = useState<Target>({ kind: 'video' }), [format, setFormat] = useState<'srt' | 'vtt' | 'txt' | 'md'>('srt')
  const [video, setVideo] = useState<VideoOptions>({ captions: document.bilingual ? 'bilingual' : 'current', method: 'burn', style: document.subtitleStyle || 'classic' })
  const [working, setWorking] = useState(false), [viewing, setViewing] = useState<string>()
  const drafts = project?.drafts || [], draft = target.kind === 'draft' || target.kind === 'cover' ? drafts.find(item => item.id === target.id) : undefined
  const chosen = draft ? target : target.kind === 'draft' || target.kind === 'cover' ? { kind: 'video' } as Target : target
  const options = [{ value: 'captions', label: t('export.targets.captions') }, { value: 'video', label: t('export.targets.video') }, ...drafts.map(item => ({ value: 'draft:' + item.id, label: t('export.targets.draft', { title: item.title }) })), ...drafts.map(item => ({ value: 'cover:' + item.id, label: t('export.targets.cover', { title: item.title }) }))]
  const run = (work: Promise<unknown>) => { setWorking(true); void work.finally(() => setWorking(false)) }
  const saveSettings = (patch: Partial<ClientState['settings']>) => void send('settings:save', { ...state.settings, ...patch })
  const busy = document.status === 'running' || document.status === 'queued'
  const finalRuns = project?.renders.filter(job => !job.preview) || [], covers = project?.covers || []
  const draftRunning = draft && finalRuns.find(job => job.draftId === draft.id && ['queued', 'running'].includes(job.status))
  const latestCover = draft && (covers.find(job => job.draftId === draft.id && job.revision === draft.revision) || undefined), coverRunning = latestCover && ['queued', 'running'].includes(latestCover.status)
  return <><Panel side="library" title={t('export.configure')}>
    <Choice label={t('export.what')} value={encode(chosen)} onChange={value => { setTarget(decode(value)); setViewing(undefined) }} options={options} />
    {chosen.kind === 'captions' && <Field><FieldLabel>{t('export.fileFormat')}</FieldLabel><ToggleGroup variant="outline" value={[format]} onValueChange={values => { if (values[0]) setFormat(values[0] as typeof format) }} className="grid w-full grid-cols-4">{(['srt', 'vtt', 'txt', 'md'] as const).map(value => <ToggleGroupItem key={value} value={value}>{value.toUpperCase()}</ToggleGroupItem>)}</ToggleGroup><p className="text-xs text-muted-foreground">{t('export.activeTrackHint')}</p></Field>}
    {chosen.kind === 'video' && <VideoConfig state={state} document={document} value={video} change={patch => setVideo(current => ({ ...current, ...patch }))} send={send} setTool={setTool} saveSettings={saveSettings} />}
    {chosen.kind === 'draft' && draft && <DraftSummary state={state} draft={draft} setTool={setTool} />}
    {chosen.kind === 'cover' && draft && <><p className="text-xs leading-relaxed text-muted-foreground">{t('export.coverHint')}</p><Button variant="outline" onClick={() => setTool('cover')}>{t('export.editCover')}</Button></>}
    {!drafts.length && <p className="text-xs leading-relaxed text-muted-foreground">{t('export.noDrafts')}</p>}
  </Panel>
    <ExportPreview state={state} document={document} project={project} target={chosen} format={format} video={video} draft={draft} viewing={viewing} send={send} />
    <Panel side="inspector" title={t('export.title')}>
      {(chosen.kind === 'captions' || chosen.kind === 'video') && <TaskStatus document={document} send={send} />}
      {chosen.kind === 'draft' && draftRunning && <TaskCard status={c(`statuses.${draftRunning.status}`)} detail={draftRunning.snapshot.title} progress={draftRunning.progress || 0} onCancel={() => void send('clipping:cancel', { documentId: document.id, taskId: draftRunning.id })} />}
      {chosen.kind === 'cover' && coverRunning && latestCover && <TaskCard status={c(`statuses.${latestCover.status}`)} onCancel={() => void send('clipping:cancel', { documentId: document.id, taskId: latestCover.id })} />}
      <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">{t('outputDirectory')}</span><span className="break-all text-xs">{state.settings.outputDirectory}</span><Button size="sm" variant="ghost" className="self-start" onClick={() => void send('settings:directory', null)}><FolderOpen data-icon="inline-start" />{t('chooseDirectory')}</Button></div>
      {chosen.kind === 'captions' && <Button disabled={working || busy || !document.captions.length} onClick={() => run(send('processing:export', { id: document.id, format }))}><Download data-icon="inline-start" />{t('export.exportFile', { format: format.toUpperCase() })}</Button>}
      {chosen.kind === 'video' && <Button disabled={working || busy || video.captions === 'bilingual' && !document.bilingual} onClick={() => run(send('processing:export', { id: document.id, format: video.captions === 'none' ? 'video' : video.method, captions: video.captions === 'bilingual' ? 'bilingual' : 'current', style: video.style }))}><Download data-icon="inline-start" />{t('export.exportVideo')}</Button>}
      {chosen.kind === 'draft' && draft && <><Button disabled={working || !!draftRunning || !draft.scenes.length} onClick={() => run(send('clipping:render', { documentId: document.id, draftId: draft.id, revision: draft.revision, preview: false }))}><Download data-icon="inline-start" />{t('export.exportClip')}</Button><div className="flex gap-2">{(['srt', 'vtt'] as const).map(value => <Button key={value} size="sm" variant="outline" disabled={!draft.scenes.length} onClick={() => void send('clipping:captions', { documentId: document.id, draftId: draft.id, format: value })}>{t('export.clipCaptions', { format: value.toUpperCase() })}</Button>)}</div></>}
      {chosen.kind === 'cover' && draft && <>{latestCover?.status === 'completed' ? <CoverFile documentId={document.id} cover={latestCover} send={send} /> : <Button disabled={working || !!coverRunning || !draft.scenes.length} onClick={() => run(send('clipping:cover', { documentId: document.id, draftId: draft.id, revision: draft.revision }))}><ImageIcon data-icon="inline-start" />{c('cover.generate')}</Button>}{latestCover?.error && <Alert variant="destructive"><AlertDescription>{latestCover.error}</AlertDescription></Alert>}</>}
      <ExportHistory document={document} project={project} send={send} view={setViewing} />
    </Panel></>
}

function VideoConfig({ state, document, value, change, send, setTool, saveSettings }: { state: ClientState; document: ProcessingDocument; value: VideoOptions; change: (patch: Partial<VideoOptions>) => void; send: Send; setTool: (tool: Tool) => void; saveSettings: (patch: Partial<ClientState['settings']>) => void }) {
  const { t } = useTranslation('editor'), source = useTrackSource()
  const active = document.tracks.find(track => track.id === document.activeTrack)
  // Same pairing as main: active track first, then the first zh and en tracks.
  const ordered = [...document.tracks.filter(track => track.id === document.activeTrack), ...document.tracks.filter(track => track.id !== document.activeTrack)]
  const zh = ordered.find(track => trackRole(track.language) === 'zh'), en = ordered.find(track => trackRole(track.language) === 'en')
  const used = value.captions === 'current' ? [active] : value.captions === 'bilingual' ? [zh, en] : []
  return <>
    <Field><FieldLabel>{t('export.captions')}</FieldLabel><ToggleGroup variant="outline" value={[value.captions]} onValueChange={values => { if (values[0]) change({ captions: values[0] as VideoOptions['captions'] }) }} className="grid w-full grid-cols-3">{(['none', 'current', 'bilingual'] as const).map(item => <ToggleGroupItem key={item} value={item}>{t(`export.captionModes.${item}`)}</ToggleGroupItem>)}</ToggleGroup></Field>
    {value.captions !== 'none' && <div className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('export.willUse')}</span>{used.map((track, index) => track ? <div key={track.id} className="flex items-center gap-2 text-xs"><span className="w-10 text-muted-foreground">{value.captions === 'bilingual' ? t(index ? 'export.english' : 'export.chinese') : ''}</span><span className="font-medium">{track.language}</span><Badge variant="outline">{source(track)}</Badge><span className="truncate text-muted-foreground">{track.name}</span></div> : <Alert key={index}><TriangleAlert /><AlertDescription className="flex flex-col gap-2">{t(index ? 'export.missingEnglish' : 'export.missingChinese')}<Button size="sm" variant="outline" className="self-start" onClick={() => setTool('subtitles')}>{t('export.goSubtitles')}</Button></AlertDescription></Alert>)}</div>}
    {value.captions !== 'none' && <Field><FieldLabel>{t('export.method')}</FieldLabel><ToggleGroup variant="outline" value={[value.method]} onValueChange={values => { if (values[0]) change({ method: values[0] as VideoOptions['method'] }) }} className="grid w-full grid-cols-2">{(['burn', 'soft'] as const).map(item => <ToggleGroupItem key={item} value={item}>{t(`export.methods.${item}`)}</ToggleGroupItem>)}</ToggleGroup><p className="text-xs leading-relaxed text-muted-foreground">{t(`export.methodHints.${value.method}`)}</p></Field>}
    {value.captions !== 'none' && value.method === 'burn' && <><div className="editor-section-title">{t('styles.subtitleTitle')}</div><StylePicker kind="subtitle" value={value.style} onChange={style => change({ style })} state={state} send={send} /></>}
    <div className="editor-section-title">{t('export.file')}</div>
    <Choice label={t('outputFormat')} value={state.settings.outputFormat} onChange={outputFormat => saveSettings({ outputFormat: outputFormat as 'mp4' | 'mkv' })} options={[{ value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }]} />
    <Choice label={t('export.resolution')} value={state.settings.outputResolution} onChange={outputResolution => saveSettings({ outputResolution: outputResolution as ClientState['settings']['outputResolution'] })} options={outputResolution.options.map(item => ({ value: item, label: item === 'original' ? t('export.original') : item + 'p' }))} />
  </>
}

function DraftSummary({ state, draft, setTool }: { state: ClientState; draft: Draft; setTool: (tool: Tool) => void }) {
  const { t } = useTranslation('editor'), { t: c } = useTranslation('clipping'), name = useStyleName()
  const style = state.styles.subtitle.find(item => item.id === draft.settings.subtitleStyle) || state.styles.subtitle[0]
  return <><dl className="editor-metadata"><dt>{t('sceneCount', { count: draft.scenes.length })}</dt><dd>{formatDuration(draft.scenes.reduce((sum, scene) => sum + scene.endMs - scene.startMs, 0) / 1000)}</dd><dt>{c('aspect')}</dt><dd>{c(draft.settings.aspect)}</dd><dt>{c('resolution')}</dt><dd>{draft.settings.resolution === 'original' ? c('original') : draft.settings.resolution + 'p'}</dd><dt>{t('subtitles')}</dt><dd>{draft.settings.subtitles ? name('subtitle', style) : t('export.captionModes.none')}</dd><dt>{c('version', { revision: draft.revision })}</dt><dd /></dl><p className="text-xs leading-relaxed text-muted-foreground">{t('export.draftHint')}</p><Button variant="outline" onClick={() => setTool('drafts')}>{t('export.editDraft')}</Button></>
}

function ExportPreview({ state, document, project, target, format, video, draft, viewing, send }: { state: ClientState; document: ProcessingDocument; project?: ClipProject; target: Target; format: string; video: VideoOptions; draft?: Draft; viewing?: string; send: Send }) {
  const { t } = useTranslation('editor'), { t: c } = useTranslation('clipping')
  const player = useRef<HTMLVideoElement>(null), [now, setNow] = useState(0)
  const viewed = viewing && project?.renders.find(job => job.id === viewing && job.status === 'completed')
  if (viewed) return <Stage title={t('draftPreview')} detail={`${viewed.snapshot.title} · ${viewed.name || ''}`}><VideoPreview document={document} source={'galaxy-media://clipping/' + document.id + '/' + viewed.id} /></Stage>
  if (target.kind === 'captions') return <Stage title={t('export.filePreview')} detail={document.tracks.find(track => track.id === document.activeTrack)?.name}><pre className="size-full overflow-auto whitespace-pre-wrap rounded-lg border bg-card p-4 text-xs leading-relaxed">{document.captions.slice(0, 200).map((cue, index) => format === 'srt' ? `${index + 1}\n${rangeLabel(cue.startMs, cue.endMs)}\n${cue.text}` : format === 'vtt' ? `${rangeLabel(cue.startMs, cue.endMs)}\n${cue.text}` : cue.text).join('\n\n')}</pre></Stage>
  if (target.kind === 'video') {
    const params = styleParams(state, video.style), zh = document.bilingual ? cueAt(document.bilingual.zh, now)?.text || '' : '', en = document.bilingual ? cueAt(document.bilingual.en, now)?.text || '' : ''
    const rows = video.captions === 'none' ? [] : video.captions === 'current' ? [cueAt(document.captions, now)?.text || ''] : params.order === 'en-first' ? [en, zh] : [zh, en]
    return <Stage title={t('export.livePreview')} detail={video.method === 'soft' && video.captions !== 'none' ? t('export.softPreviewHint') : document.sourceName}><CaptionedVideo document={document} player={player} params={params} rows={rows} onTimeUpdate={() => setNow((player.current?.currentTime || 0) * 1000)} /></Stage>
  }
  if (!draft || !project) return <Stage title={t('export.livePreview')}><Blank title={t('noDraft')} /></Stage>
  if (target.kind === 'cover') return <CoverStage state={state} project={project} draft={draft} />
  const preview = project.renders.find(job => job.draftId === draft.id && job.preview && job.status === 'completed'), rendering = project.renders.find(job => job.draftId === draft.id && job.preview && ['queued', 'running'].includes(job.status))
  return <Stage title={t('draftPreview')} detail={draft.title} footer={preview && preview.revision !== draft.revision ? t('previewOutdated') : t('export.clipPreviewHint')} actions={<Button size="sm" variant="ghost" disabled={!!rendering || !draft.scenes.length} onClick={() => void send('clipping:render', { documentId: document.id, draftId: draft.id, revision: draft.revision, preview: true })}><Play data-icon="inline-start" />{rendering ? c(`statuses.${rendering.status}`) : t('updatePreview')}</Button>}>{preview ? <VideoPreview document={document} source={'galaxy-media://clipping/' + document.id + '/' + preview.id} /> : <Blank title={t('export.noClipPreview')} detail={t('export.noClipPreviewHint')} />}</Stage>
}
function CoverStage({ state, project, draft }: { state: ClientState; project: ClipProject; draft: Draft }) {
  const { t } = useTranslation('editor'), name = useStyleName()
  const { frame, error, dimensions } = useCoverFrame(project, draft, true), cover = coverDefaultsFor(draft)
  const style = state.styles.cover.find(item => item.id === cover.style) || state.styles.cover[0]
  return <Stage title={t('coverPreview')} detail={name('cover', style)}><style>{coverFontFace('galaxy-media://cover-font/bold')}</style><div style={{ width: dimensions.height > dimensions.width ? `min(100%, calc((100vh - 200px) * ${dimensions.width / dimensions.height}))` : '100%' }} className="max-w-full"><CoverPreview state={state} draft={draft} frame={frame} error={error} dimensions={dimensions} usable /></div></Stage>
}

/** Everything exported from this media: subtitle files, videos, clips and covers. */
function ExportHistory({ document, project, send, view }: { document: ProcessingDocument; project?: ClipProject; send: Send; view: (renderId: string) => void }) {
  const { t } = useTranslation('editor'), { t: c } = useTranslation('clipping')
  type Item = { key: string; name: string; createdAt: string; status?: string; open?: () => void; reveal?: () => void; preview?: () => void }
  const items: Item[] = [
    ...document.exports.map((file, index) => ({ key: 'file-' + index, name: file.name, createdAt: file.createdAt, open: () => void send('processing:open-export', { id: document.id, index }) })),
    ...(project?.renders.filter(job => !job.preview) || []).map(job => ({ key: job.id, name: job.name || job.snapshot.title, createdAt: job.createdAt, status: job.status === 'completed' ? undefined : c(`statuses.${job.status}`), open: job.status === 'completed' ? () => void send('clipping:open', { documentId: document.id, taskId: job.id, reveal: false }) : undefined, reveal: job.status === 'completed' ? () => void send('clipping:open', { documentId: document.id, taskId: job.id, reveal: true }) : undefined, preview: job.status === 'completed' ? () => view(job.id) : undefined })),
    ...(project?.covers?.filter(job => job.status === 'completed') || []).map(job => ({ key: job.id, name: job.name || job.snapshot.title + '.jpg', createdAt: job.createdAt, open: () => void send('clipping:cover-export', { documentId: document.id, coverId: job.id }) })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return <><div className="editor-section-title">{t('history')}</div>{!items.length && <p className="text-xs text-muted-foreground">{c('noExports')}</p>}<div className="flex flex-col gap-1.5">{items.map(item => <div key={item.key} className={cn('editor-list-item py-2')}><div className="flex items-center gap-2"><button className="min-w-0 flex-1 truncate text-left text-xs font-medium" disabled={!item.open} onClick={item.open}>{item.name}</button>{item.status && <Badge variant="outline">{item.status}</Badge>}</div><div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"><span>{new Date(item.createdAt).toLocaleString()}</span>{item.preview && <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label={t('preview')} onClick={item.preview}><Play /></Button>}{item.reveal && <Button size="icon-xs" variant="ghost" aria-label={c('reveal')} onClick={item.reveal}><FolderOpen /></Button>}</div></div>)}</div></>
}

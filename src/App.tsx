import { useCallback, useEffect, useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { ArrowRight, Captions, Check, Clapperboard, Download, FolderOpen, ImageIcon, Import, LoaderCircle, Scissors, Settings2, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { i18n, setLocale } from '../shared/i18n'
import type { ClientState, Command, CommandInput, Reply } from '../shared/contracts'
import type { ProcessingDocument } from '../shared/processing'
import type { ClipProject } from '../shared/clipping'
import { cn } from '@/lib/utils'
import { MediaWorkspace, SubtitleWorkspace } from '@/components/editor/SourceWorkspace'
import { ClippingWorkspace } from '@/components/editor/ClippingWorkspace'
import { ExportWorkspace } from '@/components/editor/ExportWorkspace'
import { EditorSettings } from '@/components/editor/EditorOverlays'
import type { Tool } from '@/components/editor/Panes'

export type Send = <C extends Command>(name: C, input: CommandInput<C>) => Promise<undefined | Extract<Reply, {ok:true}>>
export default function App() { return <I18nextProvider i18n={i18n}><TooltipProvider><Editor /></TooltipProvider></I18nextProvider> }
// The workflow, in order. Each step opens once the one before has produced what it needs.
const steps = [{id:'media',icon:FolderOpen},{id:'subtitles',icon:Captions},{id:'analysis',icon:Sparkles},{id:'drafts',icon:Scissors},{id:'cover',icon:ImageIcon,optional:true},{id:'export',icon:Download}] as const
function progress(document?: ProcessingDocument, project?: ClipProject) {
  const captions = Boolean(document?.captions.length), candidates = Boolean(project?.candidates.length), drafts = Boolean(project?.drafts.length)
  return {
    reachable: { media: true, subtitles: Boolean(document), analysis: captions, drafts: captions && candidates, cover: captions && drafts, export: captions } as Record<Tool, boolean>,
    done: { media: Boolean(document), subtitles: captions, analysis: candidates, drafts, cover: Boolean(project?.covers?.some(job => job.status === 'completed')), export: false } as Record<Tool, boolean>,
  }
}
function Editor() {
  const { t } = useTranslation('editor')
  const [state,setState] = useState<ClientState>(), [selected,setSelected] = useState(''), [loaded,setLoaded] = useState<ProcessingDocument>()
  const [tool,setTool] = useState<Tool>('media'), [error,setError] = useState(''), [pending,setPending] = useState(false)
  const [settings,setSettings] = useState<'general'|'models'|'cloud'|'styles'>(), [actions,setActions] = useState<HTMLDivElement|null>(null)
  const [project,setProject] = useState<ClipProject>(), [draftId,setDraftId] = useState('')
  const send: Send = useCallback(async (name,input) => {
    try { const reply = await window.desktopApi.command(name,input); if(!reply.ok) {setError(reply.message);return};setState(reply.state);return reply }
    catch(error) {setError(error instanceof Error ? error.message : String(error));return}
  },[])
  useEffect(() => {void send('state:get',null);return window.desktopApi.subscribe(setState)},[send])
  useEffect(() => {
    if(!state) return
    setLocale(state.settings.locale)
    document.documentElement.classList.toggle('dark',state.settings.theme === 'dark' || state.settings.theme === 'system' && matchMedia('(prefers-color-scheme:dark)').matches)
  },[state?.settings.locale,state?.settings.theme,state])
  useEffect(() => {if(!selected && state?.processing.documents[0]) setSelected(state.processing.documents[0].id)},[selected,state?.processing.documents])
  const summary=state?.processing.documents.find(doc=>doc.id===selected)
  useEffect(() => {
    if(!selected || !summary) return
    let current=true
    void send('processing:get',{id:selected}).then(reply=>{if(current && reply && reply.document) setLoaded(reply.document)})
    return()=>{current=false}
  },[selected,summary?.updatedAt,summary?.status,send])
  // One clip project per media, shared by AI selection, drafts, cover, export and the step rail.
  useEffect(() => {
    if(!selected || !summary) return
    let current=true
    void send('clipping:get',{documentId:selected}).then(reply=>{if(current && reply?.clipProject) setProject(reply.clipProject)})
    return()=>{current=false}
  },[selected,summary?.updatedAt,state?.clipping.version,send])
  // Progress ticks only reach the summary; overlay them so status, progress and ETA stay live.
  const documentValue=loaded?.id===selected ? (summary ? {...loaded,status:summary.status,stage:summary.stage,progress:summary.progress,eta:summary.eta,error:summary.error} : loaded) : undefined
  const clipProject=project?.documentId===selected ? project : undefined
  const flow=progress(documentValue,clipProject)
  // Switching media can leave the current step without its prerequisites: step back to the last open one.
  useEffect(() => {if(documentValue && !flow.reachable[tool]) setTool([...steps].reverse().find(step=>flow.reachable[step.id])!.id)},[documentValue,flow.reachable,tool])
  const choose=(id:string)=>{setSelected(id);setDraftId('')}
  const importMedia=async()=>{setPending(true);const reply=await send('processing:import',null);if(reply?.document){choose(reply.document.id);setTool('media')};setPending(false)}
  const importProject=async()=>{setPending(true);const reply=await send('project:import',null);if(reply?.document){choose(reply.document.id);setTool('drafts')};setPending(false)}
  if(!state) return <div className="flex h-svh items-center justify-center gap-2"><LoaderCircle className="size-5 animate-spin" />{t('loading')}</div>
  const index=steps.findIndex(step=>step.id===tool), next=steps[index+1]
  return <main className="editor-grid" data-editor-workspace>
    <header className="editor-header"><div className="flex shrink-0 items-center gap-2"><Clapperboard className="size-6" /><div><h1 className="text-sm font-semibold">Galaxy Clipper</h1><p className="text-[10px] text-muted-foreground">{t('workspace')}</p></div></div><div className="mx-4 h-5 w-px bg-border" /><p className="min-w-0 flex-1 truncate text-sm" title={documentValue?.title}>{documentValue?.title || t('newProject')}</p><div ref={setActions} className="flex items-center gap-2" /><Button size="sm" variant="outline" disabled={pending} onClick={()=>void importMedia()}><Import data-icon="inline-start" />{t('importMedia')}</Button></header>
    <nav className="editor-tools" aria-label={t('steps.title')}><ol className="flex flex-col gap-1.5">{steps.map(({id,icon:Icon},position)=>{
      const open=flow.reachable[id], done=flow.done[id]
      return <li key={id}><Tooltip><TooltipTrigger render={<Button variant={tool===id ? 'secondary':'ghost'} aria-disabled={!open || undefined} className={cn('relative h-16 w-full flex-col gap-1',!open && 'opacity-40')} aria-current={tool===id ? 'step':undefined} onClick={()=>{if(open)setTool(id)}} />}><span className={cn('absolute right-1 top-1 flex size-4 items-center justify-center rounded-full text-[9px] tabular-nums',done ? 'bg-selection text-background':'border text-muted-foreground')}>{done ? <Check className="size-2.5" />:position+1}</span><Icon /><span className="text-[11px]">{t(`steps.names.${id}`)}</span></TooltipTrigger><TooltipContent side="right">{open ? t(`steps.hints.${id}`):t(`steps.locked.${id}`)}{'optional' in steps[position] && open ? ' · '+t('steps.optional'):''}</TooltipContent></Tooltip></li>
    })}</ol><div className="mt-auto flex flex-col gap-2"><Button variant="ghost" className="h-14 flex-col gap-1" onClick={()=>void importProject()} disabled={pending} aria-label={t('importProject')}><FolderOpen /><span className="text-[11px]">{t('migrate')}</span></Button><Button variant="ghost" className="h-14 flex-col gap-1" onClick={()=>setSettings('general')} aria-label={t('settings')}><Settings2 /><span className="text-[11px]">{t('settings')}</span></Button></div></nav>
    {tool==='media' && <MediaWorkspace state={state} document={documentValue} selected={selected} choose={choose} importMedia={importMedia} importProject={importProject} send={send} />}
    {tool==='subtitles' && <SubtitleWorkspace key={'subtitles-'+selected} state={state} document={documentValue} send={send} settings={setSettings} />}
    <ClippingWorkspace key={'clipping-'+selected} tool={tool} document={documentValue} state={state} send={send} setTool={setTool} actions={actions} settings={setSettings} project={clipProject} adopt={setProject} draftId={draftId} chooseDraft={setDraftId} />
    {tool==='export' && documentValue && <ExportWorkspace key={'export-'+selected} state={state} document={documentValue} project={clipProject} send={send} setTool={setTool} />}
    {next && <div className="editor-next">{flow.reachable[next.id] ? <Button className="w-full" onClick={()=>setTool(next.id)}>{t('steps.next',{step:t(`steps.names.${next.id}`)})}<ArrowRight data-icon="inline-end" /></Button>:<p className="text-xs leading-relaxed text-muted-foreground">{t(`steps.locked.${next.id}`)}</p>}</div>}
    {error && <Alert variant="destructive" className="editor-error"><AlertDescription className="flex items-center gap-2"><span className="flex-1">{error}</span><Button size="icon-sm" variant="ghost" aria-label={t('dismiss')} onClick={()=>setError('')}><X /></Button></AlertDescription></Alert>}
    <EditorSettings state={state} send={send} section={settings} changeSection={setSettings} close={()=>setSettings(undefined)} />
    <span className={cn('sr-only')} role="status">{pending ? t('loading'):''}</span>
  </main>
}

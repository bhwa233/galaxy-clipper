import { useCallback, useEffect, useState } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { Captions, Clapperboard, FolderOpen, History, ImageIcon, Import, LoaderCircle, Scissors, Settings2, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { i18n, setLocale } from '../shared/i18n'
import type { ClientState, Command, CommandInput, Reply } from '../shared/contracts'
import type { ProcessingDocument } from '../shared/processing'
import { cn } from '@/lib/utils'
import { MediaWorkspace, SubtitleWorkspace } from '@/components/editor/SourceWorkspace'
import { ClippingWorkspace } from '@/components/editor/ClippingWorkspace'
import { EditorSettings, ExportHistory } from '@/components/editor/EditorOverlays'
import type { Tool } from '@/components/editor/Panes'

export type Send = <C extends Command>(name: C, input: CommandInput<C>) => Promise<undefined | Extract<Reply, {ok:true}>>
export default function App() { return <I18nextProvider i18n={i18n}><TooltipProvider><Editor /></TooltipProvider></I18nextProvider> }
function Editor() {
  const { t } = useTranslation('editor')
  const [state,setState] = useState<ClientState>(), [selected,setSelected] = useState(''), [loaded,setLoaded] = useState<ProcessingDocument>()
  const [tool,setTool] = useState<Tool>('media'), [error,setError] = useState(''), [pending,setPending] = useState(false)
  const [settings,setSettings] = useState<'general'|'models'|'cloud'>(), [history,setHistory] = useState(false), [actions,setActions] = useState<HTMLDivElement|null>(null)
  const [output,setOutput] = useState<{documentId:string;taskId:string}>()
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
  const documentValue=loaded?.id===selected ? loaded : undefined
  const choose=(id:string)=>{setSelected(id);setOutput(undefined)}
  const importMedia=async()=>{setPending(true);const reply=await send('processing:import',null);if(reply?.document){choose(reply.document.id);setTool('media')};setPending(false)}
  const importProject=async()=>{setPending(true);const reply=await send('project:import',null);if(reply?.document){choose(reply.document.id);setTool('drafts')};setPending(false)}
  if(!state) return <div className="flex h-svh items-center justify-center gap-2"><LoaderCircle className="size-5 animate-spin" />{t('loading')}</div>
  const tools = [{id:'media',icon:FolderOpen},{id:'subtitles',icon:Captions},{id:'analysis',icon:Sparkles},{id:'drafts',icon:Scissors},{id:'cover',icon:ImageIcon}] as const
  return <main className="editor-grid" data-editor-workspace>
    <header className="editor-header"><div className="flex shrink-0 items-center gap-2"><Clapperboard className="size-6" /><div><h1 className="text-sm font-semibold">Galaxy Clipper</h1><p className="text-[10px] text-muted-foreground">{t('workspace')}</p></div></div><div className="mx-4 h-5 w-px bg-border" /><p className="min-w-0 flex-1 truncate text-sm" title={documentValue?.title}>{documentValue?.title || t('newProject')}</p><div ref={setActions} className="flex items-center gap-2" /><Button size="sm" variant="outline" onClick={()=>setHistory(true)}><History data-icon="inline-start" />{t('history')}</Button><Button size="sm" variant="outline" disabled={pending} onClick={()=>void importMedia()}><Import data-icon="inline-start" />{t('importMedia')}</Button></header>
    <nav className="editor-tools" aria-label={t('tools')}><div className="flex flex-col gap-2">{tools.map(({id,icon:Icon})=><Tooltip key={id}><TooltipTrigger render={<Button variant={tool===id ? 'secondary':'ghost'} className="h-16 w-full flex-col gap-1" aria-current={tool===id ? 'page':undefined} onClick={()=>{setTool(id);setOutput(undefined)}} />}><Icon /><span className="text-[11px]">{t(id)}</span></TooltipTrigger><TooltipContent side="right">{t(id+'Hint' as 'mediaHint')}</TooltipContent></Tooltip>)}</div><div className="mt-auto flex flex-col gap-2"><Button variant="ghost" className="h-14 flex-col gap-1" onClick={()=>void importProject()} disabled={pending} aria-label={t('importProject')}><FolderOpen /><span className="text-[11px]">{t('migrate')}</span></Button><Button variant="ghost" className="h-14 flex-col gap-1" onClick={()=>setSettings('general')} aria-label={t('settings')}><Settings2 /><span className="text-[11px]">{t('settings')}</span></Button></div></nav>
    {tool==='media' && <MediaWorkspace state={state} document={documentValue} selected={selected} choose={choose} importMedia={importMedia} importProject={importProject} send={send} setTool={setTool} />}
    {tool==='subtitles' && <SubtitleWorkspace key={selected} state={state} document={documentValue} send={send} settings={setSettings} />}
    <ClippingWorkspace key={selected} tool={tool} document={documentValue} state={state} send={send} setTool={setTool} actions={actions} settings={setSettings} output={output?.documentId===selected ? output.taskId:undefined} />
    {error && <Alert variant="destructive" className="editor-error"><AlertDescription className="flex items-center gap-2"><span className="flex-1">{error}</span><Button size="icon-sm" variant="ghost" aria-label={t('dismiss')} onClick={()=>setError('')}><X /></Button></AlertDescription></Alert>}
    <EditorSettings state={state} send={send} section={settings} changeSection={setSettings} close={()=>setSettings(undefined)} />
    <ExportHistory document={documentValue} state={state} send={send} open={history} close={()=>setHistory(false)} preview={taskId=>{setOutput({documentId:selected,taskId});setTool('drafts');setHistory(false)}} />
    <span className={cn('sr-only')} role="status">{pending ? t('loading'):''}</span>
  </main>
}

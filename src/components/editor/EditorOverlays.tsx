import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FolderOpen } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { formatBytes } from '@/lib/utils'
import { Choice } from './Choice'
import { CloudServices } from './CloudServices'
import { StylePicker, placeholderFrame } from './Styles'
import { CoverArtwork } from './CoverArtwork'
import { coverFontFace } from '../../../shared/cover-artwork'
import { coverSettingsSchema } from '../../../shared/clipping'
import type { Send } from '@/App'
import type { ClientState } from '../../../shared/contracts'

type Section='general'|'models'|'cloud'|'styles'
const sampleCover=coverSettingsSchema.parse({})
export function EditorSettings({state,send,section,changeSection,close}:{state:ClientState;send:Send;section?:Section;changeSection:(section:Section)=>void;close:()=>void}) {
  const {t}=useTranslation('editor'),{t:p}=useTranslation('processing'),{t:c}=useTranslation('clipping'),[importing,setImporting]=useState(false)
  return <Sheet open={!!section} onOpenChange={open=>{if(!open)close()}}><SheetContent className="data-[side=right]:w-[min(900px,95vw)] data-[side=right]:sm:max-w-none"><SheetHeader><SheetTitle>{t('settings')}</SheetTitle><SheetDescription>{t('settingsHint')}</SheetDescription></SheetHeader><div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-4 pb-4"><nav className="flex w-32 shrink-0 flex-col gap-1" aria-label={t('settings')}>{(['general','models','cloud','styles'] as const).map(value=><Button key={value} variant={section===value ? 'secondary':'ghost'} className="justify-start" aria-current={section===value ? 'page':undefined} onClick={()=>changeSection(value)}>{value==='styles' ? t('styles.library'):t(value)}</Button>)}</nav><div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-2">
    {section==='general' && <FieldGroup><Choice label={t('language')} value={state.settings.locale} onChange={locale=>void send('settings:save',{...state.settings,locale:locale as 'zh'|'en'})} options={[{value:'zh',label:'简体中文'},{value:'en',label:'English'}]} /><Choice label={t('theme')} value={state.settings.theme} onChange={theme=>void send('settings:save',{...state.settings,theme:theme as typeof state.settings.theme})} options={['dark','light','system'].map(value=>({value,label:t(value as 'dark')}))} /><div><h3 className="mb-2 text-sm font-medium">{t('outputDirectory')}</h3><p className="mb-3 break-all text-xs text-muted-foreground">{state.settings.outputDirectory}</p><Button variant="outline" onClick={()=>void send('settings:directory',null)}><FolderOpen data-icon="inline-start" />{t('chooseDirectory')}</Button></div><Choice label={t('outputFormat')} value={state.settings.outputFormat} onChange={outputFormat=>void send('settings:save',{...state.settings,outputFormat:outputFormat as 'mp4'|'mkv'})} options={[{value:'mp4',label:'MP4'},{value:'mkv',label:'MKV'}]} /><FieldDescription>{t('sourceProtected')}</FieldDescription><CommandLineSetting state={state} send={send} /><p className="text-xs text-muted-foreground">Galaxy Clipper · {state.version}</p>{!state.tools.engine && <Alert variant="destructive"><AlertDescription>{state.tools.error || t('engineUnavailable')}</AlertDescription></Alert>}</FieldGroup>}
    {section==='cloud' && <CloudServices settings={state.clipping.settings} send={send} />}
    {section==='styles' && <><p className="text-xs leading-relaxed text-muted-foreground">{t('styles.libraryHint')}</p><style>{coverFontFace('galaxy-media://cover-font/bold')}</style><div className="editor-section-title">{t('styles.subtitleTitle')}</div><StylePicker kind="subtitle" value="" state={state} send={send} /><div className="editor-section-title">{t('styles.coverTitle')}</div><StylePicker kind="cover" value="" state={state} send={send} preview={look=><CoverArtwork settings={sampleCover} look={look} title={t('styles.sampleTitle')} frame={placeholderFrame} width={1280} height={720} cropX={.5} />} /></>}
    {section==='models' && <><p className="text-xs leading-relaxed text-muted-foreground">{p('sizeHint')}</p><Button variant="outline" disabled={importing} onClick={()=>{setImporting(true);void send('models:import',null).finally(()=>setImporting(false))}}>{t('importModels')}</Button>{state.processing.models.map(item=><Card key={item.id}><CardHeader><CardTitle>{item.name}</CardTitle><CardDescription>{item.family} · {item.license}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{item.ready ? formatBytes(item.bytes):'≈ '+formatBytes(item.expectedBytes)}</span><Badge variant="outline">{item.ready ? p('installed'):item.downloading ? t('loading'):t('notInstalled')}</Badge></div>{item.downloading && <Progress value={(item.progress || 0)*100} />}{item.error && <Alert variant="destructive"><AlertDescription>{item.error}</AlertDescription></Alert>}<div className="flex flex-wrap gap-2">{item.downloading ? <Button variant="outline" onClick={()=>void send('models:cancel',{id:item.id})}>{p('cancelDownload')}</Button>:item.ready ? <><Button variant="outline" onClick={()=>void send('models:remove',{id:item.id})}>{p('deleteModel')}</Button>{item.id!=='speaker' && <Button onClick={()=>{if(item.id!=='speaker')void send('settings:save',{...state.settings,transcriptionModel:item.id})}}>{p('use')}</Button>}</>:<Button onClick={()=>void send('models:download',{id:item.id})}><Download data-icon="inline-start" />{p('download')}</Button>}</div></CardContent></Card>)}<p className="text-xs text-muted-foreground">{c('local')} · {state.processing.runtime}</p></>}
  </div></div></SheetContent></Sheet>
}

/** `clipper` for terminals and agents: the local control channel plus the launcher on PATH. */
function CommandLineSetting({state,send}:{state:ClientState;send:Send}) {
  const {t}=useTranslation('settings'),cli=state.commandLine,enabled=state.settings.allowControl
  const status=!enabled ? t('tools.commandLine.disabled'):cli.configuring ? t('tools.commandLine.configuring'):cli.error || (cli.installed && cli.listening ? t('tools.commandLine.ready'):cli.listening ? t('tools.commandLine.developmentHint'):t('tools.commandLine.needsSetup'))
  return <div className="flex flex-col gap-2 rounded-lg border p-3"><Field orientation="horizontal"><Checkbox id="allow-control" checked={enabled} onCheckedChange={allowControl=>void send('settings:save',{...state.settings,allowControl})} /><FieldLabel htmlFor="allow-control">{t('tools.allowControl.label')}</FieldLabel></Field><FieldDescription>{t('tools.allowControl.hint')}</FieldDescription><p className={cli.error ? 'text-xs text-destructive':'text-xs text-muted-foreground'}>{status}</p>{cli.installed && <p className="break-all font-mono text-[11px] text-muted-foreground">{cli.launcher}</p>}{enabled && !cli.configuring && <Button size="sm" variant="outline" className="self-start" onClick={()=>void send('commandLine:configure',null)}>{t('tools.commandLine.retry')}</Button>}</div>
}

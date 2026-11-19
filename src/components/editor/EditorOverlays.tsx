import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, Cpu, Download, FolderOpen, Palette, SlidersHorizontal, X } from 'lucide-react'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent } from '@/components/ui/card'
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

const settingsTabs={
  general:{label:'general',icon:SlidersHorizontal},
  models:{label:'models',icon:Cpu},
  cloud:{label:'cloud',icon:Cloud},
  styles:{label:'styles.library',icon:Palette},
} as const
type Section=keyof typeof settingsTabs
const sampleCover=coverSettingsSchema.parse({})
export function EditorSettings({state,send,section,changeSection,close}:{state:ClientState;send:Send;section?:Section;changeSection:(section:Section)=>void;close:()=>void}) {
  const {t}=useTranslation('editor'),{t:p}=useTranslation('processing'),{t:c}=useTranslation('clipping'),[importing,setImporting]=useState(false)
  const {t:common}=useTranslation('common')
  const activeTab=section ?? 'general'
  return <Dialog open={!!section} onOpenChange={open=>{if(!open)close()}}>
    <DialogContent showCloseButton={false} className="flex h-[min(720px,calc(100dvh-2rem))] w-[min(920px,calc(100%-2rem))] min-h-0 flex-col gap-0 overflow-hidden p-0 motion-reduce:[animation:none] sm:max-w-none">
      <DialogHeader className="shrink-0 gap-1.5 border-b px-5 pt-5 pb-4 pr-14">
        <DialogTitle>{t('settings')}</DialogTitle>
        <DialogDescription>{t('settingsHint')}</DialogDescription>
      </DialogHeader>
      <DialogClose render={<Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" aria-label={common('close')} />}><X /></DialogClose>
      <Tabs orientation="vertical" value={activeTab} onValueChange={value=>changeSection(value as Section)} className="min-h-0 flex-1 gap-0">
        <div className="w-24 shrink-0 overflow-y-auto border-r bg-muted/30 p-2 sm:w-40 sm:p-3">
          <TabsList className="w-full gap-1 bg-transparent p-0" aria-label={t('settings')}>
            {Object.entries(settingsTabs).map(([value,{label,icon:Icon}])=><TabsTrigger key={value} value={value} className="h-auto min-h-9 flex-none px-2 py-1.5 text-left leading-tight whitespace-normal motion-reduce:transition-none sm:px-3"><Icon aria-hidden="true" />{t(label)}</TabsTrigger>)}
          </TabsList>
        </div>
        <TabsContent key={activeTab} value={activeTab} className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-gutter:stable] sm:px-6">
          <div className="flex flex-col gap-4">
            <h2 className="text-base font-semibold">{t(settingsTabs[activeTab].label)}</h2>
    {section==='general' && <FieldGroup><Choice label={t('language')} value={state.settings.locale} onChange={locale=>void send('settings:save',{...state.settings,locale:locale as 'zh'|'en'})} options={[{value:'zh',label:'简体中文'},{value:'en',label:'English'}]} /><Choice label={t('theme')} value={state.settings.theme} onChange={theme=>void send('settings:save',{...state.settings,theme:theme as typeof state.settings.theme})} options={['dark','light','system'].map(value=>({value,label:t(value as 'dark')}))} /><div><h3 className="mb-2 text-sm font-medium">{t('outputDirectory')}</h3><p className="mb-3 break-all text-xs text-muted-foreground">{state.settings.outputDirectory}</p><Button variant="outline" onClick={()=>void send('settings:directory',null)}><FolderOpen data-icon="inline-start" />{t('chooseDirectory')}</Button></div><Choice label={t('outputFormat')} value={state.settings.outputFormat} onChange={outputFormat=>void send('settings:save',{...state.settings,outputFormat:outputFormat as 'mp4'|'mkv'})} options={[{value:'mp4',label:'MP4'},{value:'mkv',label:'MKV'}]} /><FieldDescription>{t('sourceProtected')}</FieldDescription><CommandLineSetting state={state} send={send} /><p className="text-xs text-muted-foreground">Galaxy Clipper · {state.version}</p>{!state.tools.engine && <Alert variant="destructive"><AlertDescription>{state.tools.error || t('engineUnavailable')}</AlertDescription></Alert>}</FieldGroup>}
    {section==='cloud' && <CloudServices settings={state.clipping.settings} send={send} />}
    {section==='styles' && <><p className="text-xs leading-relaxed text-muted-foreground">{t('styles.libraryHint')}</p><style>{coverFontFace('galaxy-media://cover-font/bold')}</style><div className="editor-section-title">{t('styles.subtitleTitle')}</div><StylePicker kind="subtitle" value="" state={state} send={send} /><div className="editor-section-title">{t('styles.coverTitle')}</div><StylePicker kind="cover" value="" state={state} send={send} preview={look=><CoverArtwork settings={sampleCover} look={look} title={t('styles.sampleTitle')} frame={placeholderFrame} width={1280} height={720} cropX={.5} />} /></>}
    {section==='models' && <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">{p('sizeHint')}</p>
        <Button variant="outline" size="sm" disabled={importing} onClick={()=>{setImporting(true);void send('models:import',null).finally(()=>setImporting(false))}}><FolderOpen data-icon="inline-start" />{t('importModels')}</Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-3">
        {state.processing.models.map(item=><Card key={item.id} size="sm" className="min-w-0 gap-2 rounded-lg">
          <CardHeader>
            <CardTitle className="min-w-0 break-words">{item.name}</CardTitle>
            <CardAction className="row-span-1"><Badge variant="outline">{item.ready ? p('installed'):item.downloading ? t('loading'):t('notInstalled')}</Badge></CardAction>
            <CardDescription className="col-span-full min-w-0 text-xs break-words">{item.family} · {item.license} · {item.ready ? formatBytes(item.bytes):'≈ '+formatBytes(item.expectedBytes)}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto flex flex-col gap-2">
            {item.downloading && <Progress value={(item.progress || 0)*100} />}
            {item.error && <Alert variant="destructive"><AlertDescription className="break-words">{item.error}</AlertDescription></Alert>}
            <div className="flex flex-wrap gap-2">
              {item.downloading ? <Button variant="outline" size="sm" onClick={()=>void send('models:cancel',{id:item.id})}>{p('cancelDownload')}</Button>:item.ready ? <>
                {item.id!=='speaker' && <Button size="sm" onClick={()=>{if(item.id!=='speaker')void send('settings:save',{...state.settings,transcriptionModel:item.id})}}>{p('use')}</Button>}
                <Button variant="outline" size="sm" onClick={()=>void send('models:remove',{id:item.id})}>{p('deleteModel')}</Button>
              </>:<Button size="sm" onClick={()=>void send('models:download',{id:item.id})}><Download data-icon="inline-start" />{p('download')}</Button>}
            </div>
          </CardContent>
        </Card>)}
      </div>
      <p className="text-xs text-muted-foreground">{c('local')} · {state.processing.runtime}</p>
    </div>}
          </div>
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>
}

/** `clipper` for terminals and agents: the local control channel plus the launcher on PATH. */
function CommandLineSetting({state,send}:{state:ClientState;send:Send}) {
  const {t}=useTranslation('settings'),cli=state.commandLine,enabled=state.settings.allowControl
  const status=!enabled ? t('tools.commandLine.disabled'):cli.configuring ? t('tools.commandLine.configuring'):cli.error || (cli.installed && cli.listening ? t('tools.commandLine.ready'):cli.listening ? t('tools.commandLine.developmentHint'):t('tools.commandLine.needsSetup'))
  return <div className="flex flex-col gap-2 rounded-lg border p-3"><Field orientation="horizontal"><Checkbox id="allow-control" checked={enabled} onCheckedChange={allowControl=>void send('settings:save',{...state.settings,allowControl})} /><FieldLabel htmlFor="allow-control">{t('tools.allowControl.label')}</FieldLabel></Field><FieldDescription>{t('tools.allowControl.hint')}</FieldDescription><p className={cli.error ? 'text-xs text-destructive':'text-xs text-muted-foreground'}>{status}</p>{cli.installed && <p className="break-all font-mono text-[11px] text-muted-foreground">{cli.launcher}</p>}{enabled && !cli.configuring && <Button size="sm" variant="outline" className="self-start" onClick={()=>void send('commandLine:configure',null)}>{t('tools.commandLine.retry')}</Button>}</div>
}

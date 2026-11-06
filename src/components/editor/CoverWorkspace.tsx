import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Blank, Panel, Stage } from './Panes'
import { Choice } from './Choice'
import { CoverArtwork } from './CoverArtwork'
import { coverDimensions, coverFontFace } from '../../../shared/cover-artwork'
import { coverPalettes, coverSettingsSchema, coverStyles, type ClipProject, type CoverFrame, type CoverJob, type CoverSettings, type Draft } from '../../../shared/clipping'
import type { Send } from '@/App'

const defaults=coverSettingsSchema.parse({})
export const clipCoverUrl=(documentId:string,coverId:string)=>'galaxy-media://cover/'+documentId+'/'+coverId
export function CoverFile({documentId,cover,send}:{documentId:string;cover?:CoverJob;send:Send}) {
  const {t}=useTranslation('clipping')
  if(!cover)return null
  return <div className="flex flex-col gap-3">{cover.status==='completed' ? <><img alt={t('cover.generatedFile')} src={clipCoverUrl(documentId,cover.id)} className="max-h-48 w-full rounded-md border bg-black object-contain" /><p className="text-xs text-muted-foreground">{t('cover.dimensions',{width:cover.width,height:cover.height})}</p><Button variant="outline" size="sm" onClick={()=>void send('clipping:cover-export',{documentId,coverId:cover.id})}><Download data-icon="inline-start" />{t('cover.export')}</Button></>:<><p className="text-sm">{t(`statuses.${cover.status}`)}</p>{['queued','running'].includes(cover.status) && <Button variant="outline" size="sm" onClick={()=>void send('clipping:cancel',{documentId,taskId:cover.id})}>{t('cancel')}</Button>}</>}{cover.error && <Alert variant="destructive"><AlertDescription>{cover.error}</AlertDescription></Alert>}{cover.warning && <Alert><AlertDescription>{cover.warning}</AlertDescription></Alert>}</div>
}
export function CoverWorkspace({project,draft,dirty,usable,patch,save,send,adopt,choose}:{project:ClipProject;draft:Draft;dirty:boolean;usable:boolean;patch:(cover:CoverSettings)=>void;save:()=>Promise<Draft|undefined>;send:Send;adopt:(project:ClipProject)=>void;choose:(id:string)=>void}) {
  const {t}=useTranslation('clipping'),{t:e}=useTranslation('editor')
  const [requesting,setRequesting]=useState(false),[preview,setPreview]=useState<{key:string;frame?:CoverFrame;error?:string}>()
  const cover=draft.settings.cover || defaults,first=draft.scenes[0],frameMs=cover.frameMs ?? (first ? Math.round(first.startMs+(first.endMs-first.startMs)*.2):0)
  const key=JSON.stringify({documentId:project.documentId,draftId:draft.id,scenes:draft.scenes,frameMs})
  useEffect(()=>{if(!usable || !JSON.parse(key).scenes.length)return;let current=true;const timer=setTimeout(()=>{void window.desktopApi.command('clipping:cover-frame',JSON.parse(key)).then(reply=>{if(current)setPreview(reply.ok ? {key,frame:reply.coverFrame}:{key,error:reply.message})}).catch(()=>{if(current)setPreview({key,error:t('errors.coverFrame')})})},150);return()=>{current=false;clearTimeout(timer)}},[key,usable,t])
  const frame=usable && preview?.key===key ? preview.frame:undefined,error=preview?.key===key ? preview.error:undefined
  const videoSize=draft.settings.aspect==='portrait' ? {width:720,height:1280}:draft.settings.aspect==='landscape' ? {width:1280,height:720}:frame || {width:1280,height:720}
  const dimensions=coverDimensions(cover.aspect,videoSize),change=(value:Partial<CoverSettings>)=>patch({...cover,...value})
  const artwork=(style:CoverSettings['style'])=>frame ? <CoverArtwork settings={{...cover,style}} title={draft.title} frame={frame.dataUrl} {...dimensions} cropX={draft.settings.cropX} />:<div className="flex aspect-video items-center justify-center rounded-md bg-muted p-3 text-xs text-muted-foreground">{error || (!draft.scenes.length ? t('errors.empty'):!usable ? t('cover.invalidDraft'):t('cover.loadingFrame'))}</div>
  const jobs=project.covers?.filter(job=>job.draftId===draft.id) || [],latest=jobs.find(job=>job.revision===draft.revision) || jobs[0],running=jobs.some(job=>['queued','running'].includes(job.status))
  const generate=async()=>{setRequesting(true);try{const saved=dirty ? await save():draft;if(!saved)return;const reply=await send('clipping:cover',{documentId:project.documentId,draftId:saved.id,revision:saved.revision});if(reply?.clipProject)adopt(reply.clipProject)}finally{setRequesting(false)}}
  const identifier='clip-cover-'+draft.id
  return <><style>{coverFontFace('galaxy-media://cover-font/bold')}</style><Panel side="library" title={e('cover')} detail={e('coverStyles')}><Choice label={t('chooseDraft')} value={draft.id} disabled={requesting} onChange={choose} options={project.drafts.map(draft=>({value:draft.id,label:draft.title}))} /><ToggleGroup value={[cover.style]} onValueChange={values=>{if(values[0])change({style:values[0] as CoverSettings['style']})}} variant="outline" aria-label={t('cover.style')} className="grid w-full grid-cols-2 items-stretch gap-3">{coverStyles.map(style=><ToggleGroupItem key={style} value={style} className="h-auto min-w-0 flex-col items-stretch gap-2 whitespace-normal p-1.5 text-left aria-pressed:border-selection aria-pressed:ring-1 aria-pressed:ring-selection">{artwork(style)}<span className="text-xs font-medium">{t(`cover.styles.${style}.name`)}</span><span className="text-[10px] font-normal leading-relaxed text-muted-foreground">{t(`cover.styles.${style}.hint`)}</span></ToggleGroupItem>)}</ToggleGroup><p className="text-xs leading-relaxed text-muted-foreground">{t('cover.liveHint')}</p></Panel>
    <Stage title={e('coverPreview')} detail={t(`cover.styles.${cover.style}.name`)} footer={t('cover.liveHint')}>
      {frame ? <div style={{width:dimensions.height>dimensions.width ? `min(100%, calc((100vh - 200px) * ${dimensions.width/dimensions.height}))`:'100%'}} className="max-w-full" data-cover-preview>{artwork(cover.style)}</div>:<Blank title={error || t('cover.loadingFrame')} detail={!draft.scenes.length ? t('errors.empty'):undefined} />}
    </Stage><Panel side="inspector" title={e('coverProperties')}><FieldGroup>
      <Field><FieldLabel htmlFor={identifier+'-title'}>{t('cover.heading')}</FieldLabel><Input id={identifier+'-title'} maxLength={120} value={cover.title} placeholder={draft.title} onChange={event=>change({title:event.target.value})} /></Field>
      <Field><FieldLabel htmlFor={identifier+'-subtitle'}>{t('cover.subtitle')}</FieldLabel><Input id={identifier+'-subtitle'} maxLength={120} value={cover.subtitle} onChange={event=>change({subtitle:event.target.value})} /></Field>
      <Field><FieldLabel htmlFor={identifier+'-badge'}>{t('cover.badge')}</FieldLabel><Input id={identifier+'-badge'} maxLength={32} value={cover.badge} onChange={event=>change({badge:event.target.value})} /></Field>
      <Field><FieldLabel>{t('cover.palette')}</FieldLabel><ToggleGroup variant="outline" size="sm" value={[cover.palette]} onValueChange={values=>{if(values[0])change({palette:values[0] as CoverSettings['palette']})}} className="flex flex-wrap gap-2" aria-label={t('cover.palette')}>{(Object.keys(coverPalettes) as CoverSettings['palette'][]).map(palette=><ToggleGroupItem key={palette} value={palette} aria-label={t(`cover.palettes.${palette}`)} className="aria-pressed:ring-1 aria-pressed:ring-selection"><span className="size-3.5 rounded-full" style={{background:coverPalettes[palette].accent}} /><span className="text-xs">{t(`cover.palettes.${palette}`)}</span></ToggleGroupItem>)}</ToggleGroup></Field>
      <Choice label={t('cover.aspect')} value={cover.aspect} onChange={aspect=>change({aspect:aspect as CoverSettings['aspect']})} options={(['video','landscape','portrait','note','square'] as const).map(value=>({value,label:t(`cover.aspects.${value}`)}))} />
      <Field><FieldLabel htmlFor={identifier+'-frame'}>{t('cover.frame')}</FieldLabel><Input id={identifier+'-frame'} type="number" min={0} step={.1} value={cover.frameMs===undefined ? '':cover.frameMs/1000} onChange={event=>{if(!event.target.value)change({frameMs:undefined});else if(Number.isFinite(event.target.valueAsNumber))change({frameMs:Math.round(event.target.valueAsNumber*1000)})}} /><p className="text-xs leading-relaxed text-muted-foreground">{t('cover.frameHint')}</p></Field>
      <Field orientation="horizontal"><Checkbox id={identifier+'-auto'} checked={cover.enabled} onCheckedChange={enabled=>change({enabled})} /><FieldLabel htmlFor={identifier+'-auto'}>{t('cover.automatic')}</FieldLabel></Field>
    </FieldGroup><Button disabled={!usable || requesting || running || !draft.scenes.length} onClick={()=>void generate()}><ImageIcon data-icon="inline-start" />{dirty ? t('cover.saveGenerate'):t('cover.generate')}</Button>{latest && <><div className="editor-section-title">{t('cover.generatedFile')}</div>{(dirty || latest.revision!==draft.revision) && <p className="text-xs text-muted-foreground">{t('cover.stale',{revision:latest.revision})}</p>}<CoverFile documentId={project.documentId} cover={latest} send={send} /></>}
    </Panel></>
}

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { Choice } from './Choice'
import type { Send } from '@/App'
import type { ClientState } from '../../../shared/contracts'
import type { ProcessingDocument } from '../../../shared/processing'
import { coverLayouts, coverStyleParams, subtitleStyleParams, type CoverStyle, type CoverStyleParams, type StyleKind, type SubtitleStyle, type SubtitleStyleParams } from '../../../shared/styles'

/** Bundled Noto weights, served by main; the same files FFmpeg burns with. */
export const subtitleFontFaces = '@font-face{font-family:GalaxySubtitle;src:url("galaxy-media://cover-font/regular");font-weight:400}@font-face{font-family:GalaxySubtitle;src:url("galaxy-media://cover-font/bold");font-weight:700}'
const rgba = (hex: string, opacity: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${opacity})`
// A neutral stand-in when no video frame is available (settings, style library).
export const placeholderFrame = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4a5a"/><stop offset="1" stop-color="#14181d"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="930" cy="300" r="170" fill="#596d80"/><rect x="0" y="520" width="1280" height="200" fill="#20262d"/></svg>')

export function useStyleName() {
  const { t } = useTranslation('editor'), { t: c } = useTranslation('clipping')
  return (kind: StyleKind, style: SubtitleStyle | CoverStyle) => !style.builtIn ? style.name : kind === 'subtitle' ? t(`styles.subtitle.${style.id}` as 'styles.subtitle.classic') : c(`cover.styles.${style.id}.name` as 'cover.styles.knowledge.name')
}
export const styleParams = (state: ClientState, id?: string) => (state.styles.subtitle.find(style => style.id === id) || state.styles.subtitle[0]).params
export const coverParams = (state: ClientState, id?: string) => (state.styles.cover.find(style => style.id === id) || state.styles.cover[0]).params

/** HTML rendering of a subtitle style. Sizes follow the ASS writer: a 1080 short edge. */
export function SubtitleOverlay({ params, rows, width, height }: { params: SubtitleStyleParams; rows: string[]; width: number; height: number }) {
  const short = Math.min(width, height), unit = short / 1080, size = params.size * short / 100
  if (!width || !rows.some(Boolean)) return null
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end text-center" style={{ fontFamily: 'GalaxySubtitle, sans-serif', fontWeight: params.weight === 'bold' ? 700 : 400, padding: `0 ${params.side * width / 100}px ${params.bottom * height / 100}px`, lineHeight: 1.22 }}>
    {rows.map((row, index) => row && <div key={index} style={{ fontSize: index ? size * params.secondaryScale : size, color: index ? params.secondaryColor : params.color, display: '-webkit-box', WebkitLineClamp: params.maxLines, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
      <span style={params.box ? { background: rgba(params.boxColor, params.boxOpacity), padding: '.06em .3em', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' } : { WebkitTextStroke: params.outline ? `${params.outline * 2 * unit}px ${params.outlineColor}` : undefined, paintOrder: 'stroke fill', textShadow: params.shadow ? `${params.shadow * unit}px ${params.shadow * unit}px 0 rgba(0,0,0,.62)` : undefined }}>{row}</span>
    </div>)}
  </div>
}
/** Fits a frame box into its parent at the media's aspect ratio and reports its size. */
function useFittedBox(ratio: number) {
  const box = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = box.current, parent = element?.parentElement
    if (!element || !parent) return
    const fit = () => { const style = getComputedStyle(parent), width = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), height = parent.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom); const w = Math.max(0, Math.min(width, height * ratio)); setSize({ width: w, height: w / ratio }) }
    fit()
    const observer = new ResizeObserver(fit); observer.observe(parent)
    return () => observer.disconnect()
  }, [ratio])
  return { box, size }
}
export function CaptionedVideo({ document, source, player, params, rows, onTimeUpdate, onLoadedMetadata }: { document: ProcessingDocument; source?: string; player?: RefObject<HTMLVideoElement | null>; params?: SubtitleStyleParams; rows: string[]; onTimeUpdate?: () => void; onLoadedMetadata?: () => void }) {
  const [ratio, setRatio] = useState(16 / 9), { box, size } = useFittedBox(ratio)
  return <div ref={box} className="relative shrink-0 overflow-hidden rounded-lg bg-black" style={{ width: size.width, height: size.height }}>
    <style>{subtitleFontFaces}</style>
    <video key={source || document.id} ref={player} src={source || 'galaxy-media://processing/' + document.id} controls preload="metadata" className="size-full object-contain" onTimeUpdate={onTimeUpdate} onLoadedMetadata={event => { const video = event.currentTarget; if (video.videoWidth && video.videoHeight) setRatio(video.videoWidth / video.videoHeight); onLoadedMetadata?.() }} />
    {params && <div className="pointer-events-none absolute inset-x-0 top-0 bottom-12"><SubtitleOverlay params={params} rows={rows} width={size.width} height={size.height} /></div>}
  </div>
}
/** A frame image with the subtitle overlay, used for style cards and the editor. */
export function SubtitleSample({ params, rows, frame = placeholderFrame }: { params: SubtitleStyleParams; rows: string[]; frame?: string }) {
  const host = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => { const element = host.current!; const fit = () => setSize({ width: element.clientWidth, height: element.clientHeight }); fit(); const observer = new ResizeObserver(fit); observer.observe(element); return () => observer.disconnect() }, [])
  return <div ref={host} className="relative aspect-video w-full overflow-hidden rounded-md bg-black"><style>{subtitleFontFaces}</style><img alt="" src={frame} className="size-full object-cover" /><SubtitleOverlay params={params} rows={rows} width={size.width} height={size.height} /></div>
}
export const sampleRows = (sample: 'zh' | 'en' | 'bilingual' | 'long', order: SubtitleStyleParams['order']) => {
  const zh = '这是一条字幕样式示例', en = 'This is a subtitle sample'
  if (sample === 'zh') return [zh]
  if (sample === 'en') return [en]
  if (sample === 'long') return ['这是一条比较长的字幕，用来检查自动换行、最多行数和边距在画面里的效果是否合适']
  return order === 'en-first' ? [en, zh] : [zh, en]
}

type Editing = { kind: 'subtitle'; id?: string; name: string; base: string; params: SubtitleStyleParams } | { kind: 'cover'; id?: string; name: string; base: string; params: CoverStyleParams }
/**
 * Style cards with library actions. Built-ins are read-only (copy only); custom
 * styles can be edited and deleted. `preview` renders a card for cover styles.
 */
export function StylePicker({ kind, value, onChange, state, send, preview, disabled, frame, columns = 2 }: { kind: StyleKind; value: string; onChange?: (id: string) => void; state: ClientState; send: Send; preview?: (params: CoverStyleParams) => ReactNode; disabled?: boolean; frame?: string; columns?: 1 | 2 }) {
  const { t } = useTranslation('editor'), name = useStyleName()
  const styles: (SubtitleStyle | CoverStyle)[] = kind === 'subtitle' ? state.styles.subtitle : state.styles.cover
  const [editing, setEditing] = useState<Editing>(), [removing, setRemoving] = useState<{ style: SubtitleStyle | CoverStyle; usage: number }>()
  const copy = (style: SubtitleStyle | CoverStyle) => setEditing({ kind, name: t('styles.copyName', { name: name(kind, style) }), base: style.builtIn ? style.id : style.base, params: structuredClone(style.params) } as Editing)
  const card = (style: SubtitleStyle | CoverStyle) => kind === 'subtitle' ? <SubtitleSample params={style.params as SubtitleStyleParams} rows={sampleRows('bilingual', (style.params as SubtitleStyleParams).order)} frame={frame} /> : preview?.(style.params as CoverStyleParams)
  return <>
    <ToggleGroup value={value ? [value] : []} disabled={disabled} onValueChange={values => { if (values[0] && onChange) onChange(values[0]) }} variant="outline" aria-label={t(kind === 'subtitle' ? 'styles.subtitleTitle' : 'styles.coverTitle')} className={cn('grid w-full items-stretch gap-3', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
      {styles.map(style => <div key={style.id} className="flex min-w-0 flex-col gap-1">
        <ToggleGroupItem value={style.id} className="h-auto min-w-0 flex-col items-stretch gap-2 whitespace-normal p-1.5 text-left aria-pressed:border-selection aria-pressed:ring-1 aria-pressed:ring-selection">{card(style)}<span className="truncate text-xs font-medium">{name(kind, style)}</span>{!style.builtIn && <span className="text-[10px] font-normal text-muted-foreground">{t('styles.custom')}</span>}</ToggleGroupItem>
        <div className="flex justify-end gap-0.5">
          <Button size="icon-xs" variant="ghost" aria-label={t('styles.copy')} onClick={() => copy(style)}><Copy /></Button>
          {!style.builtIn && <><Button size="icon-xs" variant="ghost" aria-label={t('styles.edit')} onClick={() => setEditing({ kind, id: style.id, name: style.name, base: style.base, params: structuredClone(style.params) } as Editing)}><Pencil /></Button><Button size="icon-xs" variant="ghost" aria-label={t('styles.delete')} onClick={() => void send('styles:usage', { kind, id: style.id }).then(reply => { if (reply) setRemoving({ style, usage: reply.usage || 0 }) })}><Trash2 /></Button></>}
        </div>
      </div>)}
      <Button variant="outline" className="h-auto min-h-24 flex-col gap-1 border-dashed text-xs" onClick={() => copy(styles.find(style => style.id === value) || styles[0])}><Plus />{t('styles.new')}</Button>
    </ToggleGroup>
    <StyleEditor editing={editing} close={() => setEditing(undefined)} send={send} preview={preview} frame={frame} onSaved={id => onChange?.(id)} state={state} />
    <AlertDialog open={!!removing} onOpenChange={open => { if (!open) setRemoving(undefined) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('styles.deleteTitle', { name: removing?.style.name })}</AlertDialogTitle><AlertDialogDescription>{removing?.usage ? t('styles.deleteUsed', { count: removing.usage }) : t('styles.deleteUnused')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { if (removing) void send('styles:remove', { kind, id: removing.style.id }).then(() => { if (removing.style.id === value) onChange?.(removing.style.base) }); setRemoving(undefined) }}>{t('styles.delete')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}

function NumberField({ id, label, value, min, max, step, onChange, suffix }: { id: string; label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; suffix?: string }) {
  return <Field><FieldLabel htmlFor={id}>{label}{suffix && <span className="text-muted-foreground"> · {suffix}</span>}</FieldLabel><div className="flex items-center gap-2"><input id={id + '-range'} type="range" aria-hidden="true" tabIndex={-1} min={min} max={max} step={step} value={value} onChange={event => onChange(event.target.valueAsNumber)} className="min-w-0 flex-1 accent-[var(--selection)]" /><Input id={id} type="number" className="w-20" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''} onChange={event => onChange(event.target.valueAsNumber)} /></div></Field>
}
function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><div className="flex items-center gap-2"><input id={id} type="color" value={value} onChange={event => onChange(event.target.value)} className="h-8 w-12 cursor-pointer rounded border bg-transparent" /><span className="font-mono text-xs text-muted-foreground">{value}</span></div></Field>
}
function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <Field orientation="horizontal"><Checkbox id={id} checked={checked} onCheckedChange={value => onChange(value)} /><FieldLabel htmlFor={id}>{label}</FieldLabel></Field>
}

/** Side sheet: parameters on the left, live preview on the right. */
function StyleEditor({ editing, close, send, preview, frame, onSaved, state }: { editing?: Editing; close: () => void; send: Send; preview?: (params: CoverStyleParams) => ReactNode; frame?: string; onSaved: (id: string) => void; state: ClientState }) {
  const { t } = useTranslation('editor'), { t: c } = useTranslation('clipping')
  const [value, setValue] = useState<Editing>(), [sample, setSample] = useState<'zh' | 'en' | 'bilingual' | 'long'>('bilingual'), [saving, setSaving] = useState(false)
  useEffect(() => { setValue(editing) }, [editing])
  if (!value) return <Sheet open={false} />
  const valid = value.name.trim().length > 0 && (value.kind === 'subtitle' ? subtitleStyleParams : coverStyleParams).safeParse(value.params).success
  const save = async () => {
    setSaving(true)
    const before = new Set((value.kind === 'subtitle' ? state.styles.subtitle : state.styles.cover).map(style => style.id))
    const input = value.kind === 'cover' ? { ...value, base: value.params.layout } : value
    const reply = await send('styles:save', input)
    setSaving(false)
    if (!reply) return
    const list: (SubtitleStyle | CoverStyle)[] = value.kind === 'subtitle' ? reply.state.styles.subtitle : reply.state.styles.cover
    onSaved(value.id || list.find(style => !before.has(style.id))?.id || '')
    close()
  }
  const set = <K extends string>(key: K, next: unknown) => setValue(current => current && ({ ...current, params: { ...current.params, [key]: next } }) as Editing)
  const p = value.params
  return <Sheet open={!!editing} onOpenChange={open => { if (!open) close() }}><SheetContent className="data-[side=right]:w-[min(1000px,96vw)] data-[side=right]:sm:max-w-none"><SheetHeader><SheetTitle>{t(value.id ? 'styles.editTitle' : 'styles.newTitle')}</SheetTitle><SheetDescription>{t(value.kind === 'subtitle' ? 'styles.subtitleHint' : 'styles.coverHint')}</SheetDescription></SheetHeader>
    <div className="flex min-h-0 flex-1 gap-6 overflow-hidden px-4 pb-4">
      <div className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto pr-2"><FieldGroup>
        <Field><FieldLabel htmlFor="style-name">{t('styles.name')}</FieldLabel><Input id="style-name" maxLength={40} value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></Field>
        {value.kind === 'subtitle' ? (() => { const s = p as SubtitleStyleParams; return <>
          <Choice label={t('styles.weight')} value={s.weight} onChange={next => set('weight', next)} options={[{ value: 'regular', label: t('styles.regular') }, { value: 'bold', label: t('styles.bold') }]} />
          <NumberField id="style-size" label={t('styles.size')} suffix={t('styles.percentShort')} value={s.size} min={2} max={12} step={.1} onChange={next => set('size', next)} />
          <ColorField id="style-color" label={t('styles.color')} value={s.color} onChange={next => set('color', next)} />
          <Toggle id="style-box" label={t('styles.box')} checked={s.box} onChange={next => set('box', next)} />
          {s.box ? <><ColorField id="style-box-color" label={t('styles.boxColor')} value={s.boxColor} onChange={next => set('boxColor', next)} /><NumberField id="style-box-opacity" label={t('styles.boxOpacity')} value={s.boxOpacity} min={0} max={1} step={.05} onChange={next => set('boxOpacity', next)} /></>
            : <><ColorField id="style-outline-color" label={t('styles.outlineColor')} value={s.outlineColor} onChange={next => set('outlineColor', next)} /><NumberField id="style-outline" label={t('styles.outline')} value={s.outline} min={0} max={12} step={.5} onChange={next => set('outline', next)} /><NumberField id="style-shadow" label={t('styles.shadow')} value={s.shadow} min={0} max={12} step={.5} onChange={next => set('shadow', next)} /></>}
          <NumberField id="style-bottom" label={t('styles.bottom')} suffix={t('styles.percentHeight')} value={s.bottom} min={0} max={45} step={.5} onChange={next => set('bottom', next)} />
          <NumberField id="style-side" label={t('styles.side')} suffix={t('styles.percentWidth')} value={s.side} min={0} max={25} step={.5} onChange={next => set('side', next)} />
          <NumberField id="style-lines" label={t('styles.maxLines')} value={s.maxLines} min={1} max={4} step={1} onChange={next => set('maxLines', next)} />
          <div className="editor-section-title">{t('styles.bilingual')}</div>
          <NumberField id="style-secondary-scale" label={t('styles.secondaryScale')} value={s.secondaryScale} min={.5} max={1.2} step={.02} onChange={next => set('secondaryScale', next)} />
          <ColorField id="style-secondary-color" label={t('styles.secondaryColor')} value={s.secondaryColor} onChange={next => set('secondaryColor', next)} />
          <Choice label={t('styles.order')} value={s.order} onChange={next => set('order', next)} options={[{ value: 'zh-first', label: t('styles.zhFirst') }, { value: 'en-first', label: t('styles.enFirst') }]} />
        </> })() : (() => { const s = p as CoverStyleParams; return <>
          <Choice label={t('styles.layout')} value={s.layout} onChange={next => set('layout', next)} options={coverLayouts.map(layout => ({ value: layout, label: c(`cover.styles.${layout}.name`) }))} />
          <Toggle id="style-palette" label={t('styles.followPalette')} checked={!s.colors} onChange={next => set('colors', next ? null : { accent: '#5a8bff', canvas: '#1a1a19', text: '#eceae6' })} />
          {s.colors && <><ColorField id="style-accent" label={t('styles.accent')} value={s.colors.accent} onChange={next => set('colors', { ...s.colors!, accent: next })} /><ColorField id="style-canvas" label={t('styles.canvas')} value={s.colors.canvas} onChange={next => set('colors', { ...s.colors!, canvas: next })} /><ColorField id="style-text" label={t('styles.textColor')} value={s.colors.text} onChange={next => set('colors', { ...s.colors!, text: next })} /></>}
          <NumberField id="style-weight" label={t('styles.titleWeight')} value={s.titleWeight} min={300} max={900} step={100} onChange={next => set('titleWeight', next)} />
          <NumberField id="style-scale" label={t('styles.titleScale')} value={s.titleScale} min={.6} max={1.4} step={.05} onChange={next => set('titleScale', next)} />
          <Toggle id="style-italic" label={t('styles.italic')} checked={s.italic} onChange={next => set('italic', next)} />
          <Toggle id="style-stroke" label={t('styles.stroke')} checked={s.stroke} onChange={next => set('stroke', next)} />
          <NumberField id="style-shade" label={t('styles.shade')} value={s.shade} min={0} max={1} step={.05} onChange={next => set('shade', next)} />
          <NumberField id="style-saturation" label={t('styles.saturation')} value={s.saturation} min={0} max={2} step={.05} onChange={next => set('saturation', next)} />
          <NumberField id="style-contrast" label={t('styles.contrast')} value={s.contrast} min={.5} max={1.6} step={.05} onChange={next => set('contrast', next)} />
          <Choice label={t('styles.badge')} value={s.badge} onChange={next => set('badge', next)} options={(['plain', 'none', 'underline', 'border'] as const).map(badge => ({ value: badge, label: t(`styles.badges.${badge}`) }))} />
          <Toggle id="style-bar" label={t('styles.bar')} checked={s.bar} onChange={next => set('bar', next)} />
        </> })()}
      </FieldGroup></div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {value.kind === 'subtitle' && <ToggleGroup variant="outline" size="sm" value={[sample]} onValueChange={values => { if (values[0]) setSample(values[0] as typeof sample) }} aria-label={t('styles.sample')}>{(['zh', 'en', 'bilingual', 'long'] as const).map(item => <ToggleGroupItem key={item} value={item}>{t(`styles.samples.${item}`)}</ToggleGroupItem>)}</ToggleGroup>}
        <div className="rounded-lg border p-3">{value.kind === 'subtitle' ? <SubtitleSample params={p as SubtitleStyleParams} rows={sampleRows(sample, (p as SubtitleStyleParams).order)} frame={frame} /> : preview?.(p as CoverStyleParams)}</div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('styles.previewHint')}</p>
        <div className="mt-auto flex justify-end gap-2"><Button variant="ghost" onClick={close}>{t('cancel')}</Button><Button disabled={!valid || saving} onClick={() => void save()}>{t('styles.save')}</Button></div>
      </div>
    </div>
  </SheetContent></Sheet>
}

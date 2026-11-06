import type { ReactNode, RefObject } from 'react'
import { Film } from 'lucide-react'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from 'react-i18next'
import type { ProcessingDocument } from '../../../shared/processing'
import { cn, formatDuration } from '@/lib/utils'

export type Tool = 'media' | 'subtitles' | 'analysis' | 'drafts' | 'cover'
export function Panel({ title, detail, actions, children, side }: { title: string; detail?: string; actions?: ReactNode; children: ReactNode; side: 'library' | 'inspector' }) {
  return <section className={'editor-' + side} aria-label={title}><header className="flex shrink-0 items-center gap-2 border-b p-4"><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{title}</h2>{detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}</div>{actions}</header><div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">{children}</div></section>
}
export function Stage({ title, detail, actions, children, footer }: { title: string; detail?: string; actions?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return <section className="editor-preview" aria-label={title}><header className="flex shrink-0 items-center gap-3 border-b px-5 py-3"><Badge variant="outline">{title}</Badge><p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail}</p>{actions}</header><div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5" data-preview-stage>{children}</div>{footer && <div className="shrink-0 border-t px-5 py-3 text-xs text-muted-foreground">{footer}</div>}</section>
}
export function Blank({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return <Empty><EmptyHeader><EmptyMedia variant="icon"><Film /></EmptyMedia><EmptyTitle>{title}</EmptyTitle>{detail && <EmptyDescription>{detail}</EmptyDescription>}</EmptyHeader>{children}</Empty>
}
export function VideoPreview({ document, source, player, onTimeUpdate, onLoadedMetadata }: { document?: ProcessingDocument; source?: string; player?: RefObject<HTMLVideoElement | null>; onTimeUpdate?: () => void; onLoadedMetadata?: () => void }) {
  const { t } = useTranslation('editor')
  if(!document) return <Blank title={t('emptyTitle')} detail={t('emptyHint')} />
  return <video key={source || document.id} ref={player} src={source || 'galaxy-media://processing/' + document.id} controls preload="metadata" onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata} className={cn('max-h-full w-full rounded-lg bg-black object-contain', /\.(mp3|wav|m4a|flac|ogg|opus|aac)$/i.test(document.sourceName) && 'h-24')} aria-label={t(source ? 'draftPreview' : 'sourcePreview')} />
}
export const rangeLabel = (start: number, end: number) => `${formatDuration(start / 1000)} – ${formatDuration(end / 1000)}`

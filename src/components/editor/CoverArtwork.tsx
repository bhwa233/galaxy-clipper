import { useEffect, useId, useMemo, useRef } from 'react'
import type { CoverSettings } from '../../../shared/clipping'
import { coverArtworkHTML, layoutCoverArtwork } from '../../../shared/cover-artwork'

// Reuse the JPEG export's artwork instead of introducing a second canvas/SVG
// renderer. Native ResizeObserver scales its fixed artboard inside existing cards.
export function CoverArtwork({ settings, title, frame, width, height, cropX }: { settings: CoverSettings; title: string; frame: string; width: number; height: number; cropX: number }) {
  const id = useId().replace(/[^a-z0-9_-]/gi, ''), host = useRef<HTMLDivElement>(null)
  const { style, palette } = settings
  const html = useMemo(() => coverArtworkHTML(id, { style, palette }, width, height, cropX, frame), [id, style, palette, width, height, cropX, frame])
  const heading = settings.title.trim() || title.trim(), subtitle = settings.subtitle.trim(), badge = settings.badge.trim()
  useEffect(() => {
    const element = host.current!, artboard = element.querySelector<HTMLElement>('[data-cover-artwork]')!
    let current = true
    const resize = () => { artboard.style.transform = `scale(${element.clientWidth / width})` }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    void layoutCoverArtwork(artboard, { title: heading, subtitle, badge, style, portrait: height > width, height }, () => current).then(fits => {
      if (current) element.dataset.fits = String(fits)
    }).catch(() => { if (current) element.dataset.fits = 'false' })
    return () => { current = false; observer.disconnect() }
  }, [html, heading, subtitle, badge, style, width, height])
  return <div aria-hidden="true" ref={host} className="relative w-full overflow-hidden rounded-md bg-black text-left [&_[data-cover-artwork]]:absolute [&_[data-cover-artwork]]:origin-top-left" style={{ aspectRatio: width + '/' + height }} dangerouslySetInnerHTML={{ __html: html }} />
}

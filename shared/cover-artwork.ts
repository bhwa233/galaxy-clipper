import { coverPalettes, type CoverSettings } from './clipping'

export function coverDimensions(aspect: CoverSettings['aspect'], video: { width: number; height: number }) {
  const key = aspect === 'video' ? video.height > video.width ? 'portrait' : 'landscape' : aspect
  const [width, height] = { landscape: [1280, 720], portrait: [1080, 1920], note: [1080, 1440], square: [1080, 1080] }[key]
  return { width, height }
}
export const coverFontFace = (url: string) => `@font-face{font-family:GalaxyCover;src:url(${JSON.stringify(url)});font-weight:100 900}`
export function coverArtworkHTML(scope: string, settings: Pick<CoverSettings, 'style' | 'palette'>, width: number, height: number, cropX: number, frame: string, font?: string) {
  if (!/^[a-z0-9_-]+$/i.test(scope)) throw new Error('Invalid cover scope')
  const root = `[data-cover-artwork="${scope}"]`, { accent, canvas } = coverPalettes[settings.palette], portrait = height > width
  return `<style>${font ? coverFontFace(font) : ''}

${root},${root} *{box-sizing:border-box}${root}{position:relative;width:${width}px;height:${height}px;overflow:hidden;--accent:${accent};--canvas:${canvas};background:var(--canvas);color:#eceae6;font-family:GalaxyCover,sans-serif;font-weight:400;font-style:normal;line-height:normal;letter-spacing:normal;text-align:left;white-space:normal}
${root} [data-cover-part="photo"]{position:absolute;width:100%;height:100%;object-fit:cover;object-position:${cropX * 100}% 50%}
${root} [data-cover-part="shade"]{position:absolute;inset:0;background:linear-gradient(90deg,${canvas}fa 0%,${canvas}f0 24%,${canvas}b0 52%,${canvas}18 100%)}
${root} [data-cover-part="content"]{position:absolute;left:6%;top:10%;width:55%;height:80%;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:${Math.round(width * .018)}px}
${root} [data-cover-part="badge"]{color:var(--accent);font-size:${Math.round(width * .021)}px;letter-spacing:.08em;white-space:pre-wrap;overflow-wrap:anywhere}
${root} [data-cover-part="title"]{font-size:${Math.round(width * .073)}px;font-weight:900;line-height:1.16;letter-spacing:-.02em;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;width:100%}
${root} [data-cover-part="subtitle"]{font-size:${Math.round(width * .028)}px;line-height:1.45;color:#dededb;white-space:pre-wrap;overflow-wrap:anywhere;width:100%}
${root} [data-cover-part="bar"]{flex-shrink:0;width:16%;height:${Math.max(5, Math.round(width * .006))}px;background:var(--accent)}
${root}.knowledge [data-cover-part="content"]{border-left:${Math.round(width * .006)}px solid var(--accent);padding-left:3%}
${root}.interview [data-cover-part="title"]{font-family:Georgia,GalaxyCover,serif;font-weight:600;line-height:1.25;letter-spacing:.015em}
${root}.interview [data-cover-part="badge"]{border-bottom:1px solid var(--accent);padding-bottom:.5em}
${root}.game [data-cover-part="photo"]{filter:contrast(1.13) saturate(.85)}${root}.game [data-cover-part="shade"]{background:linear-gradient(115deg,${canvas}ff 0%,${canvas}eb 38%,${canvas}22 78%)}
${root}.game [data-cover-part="title"]{color:var(--accent);paint-order:stroke fill;-webkit-text-stroke:${Math.max(1, width / 500)}px #0b0b0b;text-shadow:4px 5px 0 #0b0b0b;font-style:italic}
${root}.game [data-cover-part="badge"]{border:2px solid var(--accent);padding:.3em .7em}
${root}.vlog{background:#eee9df;color:#202621}${root}.vlog [data-cover-part="photo"]{filter:saturate(.82) brightness(1.06)}
${root}.vlog [data-cover-part="shade"]{background:linear-gradient(0deg,#f5f0e7fc 0%,#f5f0e7ed 29%,#f5f0e710 79%)}
${root}.vlog [data-cover-part="content"]{top:auto;bottom:6%;width:85%;height:65%;justify-content:flex-end}${root}.vlog [data-cover-part="title"]{font-weight:600;line-height:1.22}${root}.vlog [data-cover-part="subtitle"]{color:#3d473e}${root}.vlog [data-cover-part="badge"]{color:#344e41}
${root}.general [data-cover-part="photo"]{filter:saturate(.1)}${root}.general [data-cover-part="title"]{font-weight:700}${root}.general [data-cover-part="badge"]{color:#d2d2ce}
${portrait ? `${root} [data-cover-part="photo"]{top:26%;height:74%}${root} [data-cover-part="shade"]{background:linear-gradient(180deg,${canvas}ff 0%,${canvas}ff 24%,${canvas}40 54%,${canvas}20 83%,${canvas}bb 100%)}
${root} [data-cover-part="content"]{left:7%;top:5%;width:86%;height:43%;justify-content:flex-start;gap:${Math.round(width * .025)}px}${root} [data-cover-part="title"]{font-size:${Math.round(width * .108)}px;line-height:1.2}${root} [data-cover-part="subtitle"]{font-size:${Math.round(width * .037)}px}${root} [data-cover-part="badge"]{font-size:${Math.round(width * .03)}px}${root}.knowledge [data-cover-part="content"]{padding-left:3%}
${root}.game [data-cover-part="shade"]{background:linear-gradient(180deg,${canvas}ff 0%,${canvas}ef 37%,${canvas}22 80%)}
${root}.vlog [data-cover-part="photo"]{top:0;height:100%}${root}.vlog [data-cover-part="content"]{top:auto;bottom:6%;height:58%;width:86%}` : ''}
</style><div data-cover-artwork="${scope}" class="${settings.style}"><img data-cover-part="photo" src="${frame}" alt=""><div data-cover-part="shade"></div><section data-cover-part="content"><div data-cover-part="badge"></div><h1 data-cover-part="title"></h1><div data-cover-part="subtitle"></div><div data-cover-part="bar"></div></section></div>`
}

export type CoverArtworkText = { title: string; subtitle: string; badge: string; portrait: boolean; style: CoverSettings['style']; height: number }
// Shared by the live artboards and JPEG export. Work in unscaled layout pixels;
// live cards use a CSS transform while retaining exactly the export typography.
export async function layoutCoverArtwork(root: HTMLElement, value: CoverArtworkText, current = () => true) {
  const photoReset = (surface: HTMLElement) => { const photo = surface.querySelector('[data-cover-part="photo"]') as HTMLElement; photo.style.top = ''; photo.style.height = '' }

  const title = (root.querySelector('[data-cover-part="title"]') as HTMLElement), subtitle = (root.querySelector('[data-cover-part="subtitle"]') as HTMLElement), badge = (root.querySelector('[data-cover-part="badge"]') as HTMLElement), content = (root.querySelector('[data-cover-part="content"]') as HTMLElement)
  if (!current()) return false
  title.style.fontSize = ''; subtitle.style.fontSize = ''
  photoReset(root)
  title.textContent = value.title; subtitle.textContent = value.subtitle; badge.textContent = value.badge
  subtitle.style.display = value.subtitle ? '' : 'none'
  badge.style.display = value.badge ? '' : 'none'
  await document.fonts.load('800 60px GalaxyCover'); await document.fonts.ready
  if (!current()) return false
  const image = root.querySelector('[data-cover-part="photo"]') as HTMLImageElement
  await image.decode()
  if (!current()) return false
  let size = parseFloat(getComputedStyle(title).fontSize), subSize = parseFloat(getComputedStyle(subtitle).fontSize)
  while ((content.scrollHeight > content.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1) && size > 22) {
    size -= 2; title.style.fontSize = size + 'px'
    subSize = Math.max(16, subSize - .5); subtitle.style.fontSize = subSize + 'px'
  }
  if (value.portrait && value.style !== 'vlog') {
    const bar = root.querySelector('[data-cover-part="bar"]') as HTMLElement
    const bottom = content.offsetTop + bar.offsetTop + bar.offsetHeight
    const top = Math.min(value.height * .52, Math.max(value.height * .25, bottom + value.height * .025))
    image.style.top = top + 'px'; image.style.height = value.height - top + 'px'
  }
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (!current()) return false
  const surface = root.getBoundingClientRect()
  const inside = [title, subtitle, badge].every(element => {
    if (!element.textContent) return true
    const range = document.createRange(); range.selectNodeContents(element)
    const box = range.getBoundingClientRect()
    return box.left >= surface.left - 1 && box.right <= surface.right + 1 && box.top >= surface.top - 1 && box.bottom <= surface.bottom + 1
  })
  return inside && content.scrollHeight <= content.clientHeight + 1 && title.scrollWidth <= title.clientWidth + 1 && title.textContent === value.title && subtitle.textContent === value.subtitle && badge.textContent === value.badge

}

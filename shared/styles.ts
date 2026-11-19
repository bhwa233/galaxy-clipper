import { z } from 'zod'
import { coverStyles } from './clipping'

// Subtitle and cover looks share one library model: read-only built-ins plus
// custom styles copied from one of them. Only structured parameters are stored,
// so the live HTML preview and the FFmpeg/Chromium exports read the same values.
// Every style carries an id, base, version and update time for later remote sync.
const color = z.string().regex(/^#[0-9a-f]{6}$/i)
export const subtitleStyleParams = z.object({
  weight: z.enum(['regular', 'bold']),
  size: z.number().min(2).max(12), // % of the frame's short edge
  color, outlineColor: color,
  outline: z.number().min(0).max(12), // px on a 1080 short edge
  shadow: z.number().min(0).max(12),
  box: z.boolean(), boxColor: color, boxOpacity: z.number().min(0).max(1),
  bottom: z.number().min(0).max(45), // % of frame height
  side: z.number().min(0).max(25), // % of frame width per side
  maxLines: z.number().int().min(1).max(4),
  secondaryScale: z.number().min(.5).max(1.2), secondaryColor: color,
  order: z.enum(['zh-first', 'en-first']),
})
export type SubtitleStyleParams = z.infer<typeof subtitleStyleParams>
export const coverLayouts = coverStyles
export type CoverLayout = typeof coverLayouts[number]
export const coverStyleParams = z.object({
  layout: z.enum(coverLayouts),
  colors: z.object({ accent: color, canvas: color, text: color }).nullable(), // null follows the chosen palette
  titleWeight: z.number().int().min(300).max(900),
  titleScale: z.number().min(.6).max(1.4),
  italic: z.boolean(), stroke: z.boolean(),
  shade: z.number().min(0).max(1), saturation: z.number().min(0).max(2), contrast: z.number().min(.5).max(1.6),
  badge: z.enum(['plain', 'none', 'underline', 'border']), bar: z.boolean(),
})
export type CoverStyleParams = z.infer<typeof coverStyleParams>
export type StyleKind = 'subtitle' | 'cover'
type Entry<P> = { id: string; name: string; base: string; version: number; updatedAt: string; builtIn: boolean; params: P }
export type SubtitleStyle = Entry<SubtitleStyleParams>
export type CoverStyle = Entry<CoverStyleParams>
export type StyleLibraryState = { subtitle: SubtitleStyle[]; cover: CoverStyle[] }

export const subtitleBuiltIns = ['classic', 'large', 'box', 'variety', 'simple'] as const
const subtitleBase: SubtitleStyleParams = { weight: 'bold', size: 5.9, color: '#ffffff', outlineColor: '#121b25', outline: 3, shadow: 1.5, box: false, boxColor: '#000000', boxOpacity: .6, bottom: 7.4, side: 6.7, maxLines: 2, secondaryScale: .94, secondaryColor: '#ffffff', order: 'zh-first' }
export const subtitleDefaults: Record<typeof subtitleBuiltIns[number], SubtitleStyleParams> = {
  // The downloader's former burn-in style (Noto Sans CJK SC Bold, 64/60 on 1080p).
  classic: subtitleBase,
  large: { ...subtitleBase, size: 7.6, outline: 5, shadow: 0, bottom: 16, maxLines: 2, secondaryScale: .82 },
  box: { ...subtitleBase, weight: 'regular', size: 5.4, outline: 0, shadow: 0, box: true, boxOpacity: .62, secondaryScale: .9 },
  variety: { ...subtitleBase, size: 6.8, color: '#ffe14a', outlineColor: '#000000', outline: 5, shadow: 3, secondaryColor: '#ffffff', secondaryScale: .8 },
  simple: { ...subtitleBase, weight: 'regular', size: 4.6, outline: 1.5, shadow: 2, bottom: 5.5, secondaryScale: .88, secondaryColor: '#d9d9d9' },
}
// Defaults mirror the CSS each layout class already produces, so a built-in
// cover emits no overrides and keeps its exact former appearance.
export const coverDefaults: Record<CoverLayout, CoverStyleParams> = {
  knowledge: { layout: 'knowledge', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
  interview: { layout: 'interview', colors: null, titleWeight: 600, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'underline', bar: true },
  game: { layout: 'game', colors: null, titleWeight: 900, titleScale: 1, italic: true, stroke: true, shade: 1, saturation: .85, contrast: 1.13, badge: 'border', bar: true },
  vlog: { layout: 'vlog', colors: null, titleWeight: 600, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: .82, contrast: 1, badge: 'plain', bar: true },
  general: { layout: 'general', colors: null, titleWeight: 700, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: .1, contrast: 1, badge: 'plain', bar: true },
  chapter: { layout: 'chapter', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
  keypoint: { layout: 'keypoint', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
  question: { layout: 'question', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
  speaker: { layout: 'speaker', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
  magazine: { layout: 'magazine', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
  data: { layout: 'data', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
  minimal: { layout: 'minimal', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
  shortvideo: { layout: 'shortvideo', colors: null, titleWeight: 900, titleScale: 1, italic: false, stroke: false, shade: 1, saturation: 1, contrast: 1, badge: 'plain', bar: true },
}
const epoch = '2026-11-06T00:00:00.000Z'
export const builtInSubtitleStyles: SubtitleStyle[] = subtitleBuiltIns.map(id => ({ id, name: id, base: id, version: 1, updatedAt: epoch, builtIn: true, params: subtitleDefaults[id] }))
export const builtInCoverStyles: CoverStyle[] = coverLayouts.map(id => ({ id, name: id, base: id, version: 1, updatedAt: epoch, builtIn: true, params: coverDefaults[id] }))
export const styleId = z.string().regex(/^[a-z0-9-]{3,64}$/i)
// Former draft subtitle presets map onto the closest built-in.
export const legacySubtitleStyle = (value: unknown) => value === 'clean' ? 'simple' : value === 'bold' ? 'classic' : value
export const styleSave = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subtitle'), id: z.string().uuid().optional(), name: z.string().trim().min(1).max(40), base: styleId, params: subtitleStyleParams }),
  z.object({ kind: z.literal('cover'), id: z.string().uuid().optional(), name: z.string().trim().min(1).max(40), base: styleId, params: coverStyleParams }),
])
export const styleCommands = {
  'styles:save': styleSave,
  'styles:remove': z.object({ kind: z.enum(['subtitle', 'cover']), id: z.string().uuid() }),
  'styles:usage': z.object({ kind: z.enum(['subtitle', 'cover']), id: z.string().uuid() }),
} as const

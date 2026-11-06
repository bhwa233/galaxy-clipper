import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { builtInCoverStyles, builtInSubtitleStyles, coverStyleParams, subtitleStyleParams, type CoverStyle, type CoverStyleParams, type StyleKind, type StyleLibraryState, type SubtitleStyle, type SubtitleStyleParams } from '../../shared/styles'

const entry = <P extends z.ZodTypeAny>(params: P) => z.object({ id: z.string().uuid(), name: z.string().min(1).max(40), base: z.string(), version: z.number().int().positive(), updatedAt: z.string(), params })
const fileSchema = z.object({ subtitle: z.array(z.unknown()).default([]), cover: z.array(z.unknown()).default([]), removed: z.record(z.string(), z.string()).default({}) })

/** One shared style library for all projects, validated and saved by main only. */
export class StyleLibrary {
  private subtitle: SubtitleStyle[] = []
  private cover: CoverStyle[] = []
  // Deleted ids resolve to their base built-in, so old references never break.
  private removed: Record<string, string> = {}
  constructor(private file: string) {
    if (!existsSync(file)) return
    try {
      const value = fileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      this.subtitle = value.subtitle.flatMap(item => { const parsed = entry(subtitleStyleParams).safeParse(item); return parsed.success ? [{ ...parsed.data, builtIn: false }] : [] })
      this.cover = value.cover.flatMap(item => { const parsed = entry(coverStyleParams).safeParse(item); return parsed.success ? [{ ...parsed.data, builtIn: false }] : [] })
      this.removed = value.removed
    } catch { /* An unreadable library leaves the built-ins available and the file untouched. */ }
  }
  state(): StyleLibraryState { return { subtitle: [...builtInSubtitleStyles, ...this.subtitle], cover: [...builtInCoverStyles, ...this.cover] } }
  private persist(): void {
    const strip = <T extends { builtIn: boolean }>(items: T[]) => items.map(({ builtIn: _builtIn, ...rest }) => rest)
    writeFileSync(this.file + '.tmp', JSON.stringify({ subtitle: strip(this.subtitle), cover: strip(this.cover), removed: this.removed }), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
  }
  private builtIn(kind: StyleKind, id: string): boolean { return (kind === 'subtitle' ? builtInSubtitleStyles : builtInCoverStyles).some(style => style.id === id) }
  save(input: { kind: 'subtitle'; id?: string; name: string; base: string; params: SubtitleStyleParams } | { kind: 'cover'; id?: string; name: string; base: string; params: CoverStyleParams }): string {
    const list: (SubtitleStyle | CoverStyle)[] = input.kind === 'subtitle' ? this.subtitle : this.cover
    // Custom styles always descend from a built-in, even when copied from another custom style.
    const base = this.builtIn(input.kind, input.base) ? input.base : list.find(style => style.id === input.base)?.base
    if (!base) throw new Error('Unknown base style')
    const now = new Date().toISOString(), held = input.id ? list.find(style => style.id === input.id) : undefined
    if (input.id && !held) throw new Error('Style not found')
    if (held) Object.assign(held, { name: input.name, params: input.params, version: held.version + 1, updatedAt: now })
    else list.push({ id: randomUUID(), name: input.name, base, version: 1, updatedAt: now, builtIn: false, params: input.params } as SubtitleStyle & CoverStyle)
    this.persist()
    return held?.id || list.at(-1)!.id
  }
  /** Removes a custom style and returns the built-in that now stands in for it. */
  remove(kind: StyleKind, id: string): string {
    const list: (SubtitleStyle | CoverStyle)[] = kind === 'subtitle' ? this.subtitle : this.cover, index = list.findIndex(style => style.id === id)
    if (index < 0) throw new Error('Style not found')
    const [style] = list.splice(index, 1)
    this.removed[id] = style.base; this.persist()
    return style.base
  }
  base(kind: StyleKind, id: string): string { return (kind === 'subtitle' ? this.subtitle : this.cover).find(style => style.id === id)?.base || this.removed[id] || id }
  subtitleParams(id: string | undefined): SubtitleStyleParams {
    const all = this.state().subtitle, found = all.find(style => style.id === id) || all.find(style => style.id === this.removed[id || ''])
    return (found || builtInSubtitleStyles[0]).params
  }
  coverParams(id: string | undefined): CoverStyleParams {
    const all = this.state().cover, found = all.find(style => style.id === id) || all.find(style => style.id === this.removed[id || ''])
    return (found || builtInCoverStyles[0]).params
  }
}

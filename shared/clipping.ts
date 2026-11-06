import { z } from 'zod'
import { outputResolution, type Caption, type Speaker } from './processing'

export const cloudEndpoint = z.string().trim().max(2048).refine(value => {
  if (!value) return true
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash } catch { return false }
})
export const providerSchema = z.object({ baseUrl: cloudEndpoint.default(''), model: z.string().trim().max(200).default(''), contextChars: z.number().int().min(2000).max(100000).default(24000) })
export type Provider = z.infer<typeof providerSchema>
export type ProviderSnapshot = Provider & { credentialId?: string }
export type CloudSettings = { route: 'local' | 'remote'; analysis: Provider & { hasKey: boolean }; transcription: Provider & { hasKey: boolean }; secureStorage: boolean }
export type CloudConnection = { kind: 'analysis' | 'transcription'; modelListed: boolean }
export const cloudSaveSchema = z.object({ route: z.enum(['local', 'remote']), analysis: providerSchema.extend({ apiKey: z.string().max(4096).optional(), clearKey: z.boolean().optional() }), transcription: providerSchema.extend({ apiKey: z.string().max(4096).optional(), clearKey: z.boolean().optional() }) })
export const analysisOptionsSchema = z.object({ minSeconds: z.number().int().min(3).max(1800).default(30), maxSeconds: z.number().int().min(3).max(1800).default(180), count: z.number().int().min(1).max(30).default(8), instruction: z.string().trim().max(1000).default('') }).refine(value => value.maxSeconds >= value.minSeconds)
export type AnalysisOptions = z.infer<typeof analysisOptionsSchema>
export type ClipStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
export type TranscriptSnapshot = { id: string; trackId?: string; revision: number; captions: Caption[]; speakers: Speaker[]; language?: string; fingerprint: string }
export type Candidate = { id: string; runId: string; transcriptId: string; startMs: number; endMs: number; title: string; reason: string; score: number }
export type AnalysisWindow = { first: number; last: number; status: 'pending' | 'completed' | 'failed'; candidates: Candidate[]; error?: string }
export type AnalysisRun = { id: string; transcriptId: string; cacheKey: string; options: AnalysisOptions; provider: Omit<ProviderSnapshot, 'credentialId'>; status: ClipStatus; windows: AnalysisWindow[]; createdAt: string; error?: string; candidateIds?: string[] }
export const coverStyles = ['knowledge', 'interview', 'game', 'vlog', 'general'] as const
// AutoClip's local cover palettes, migrated under MIT; see public/licenses/autoclip-cover-styles.txt.
export const coverPalettes = {
  azure: { accent: '#5A8BFF', canvas: '#1A1A19' }, amber: { accent: '#F2B544', canvas: '#1B1712' },
  coral: { accent: '#FF6F59', canvas: '#1B1514' }, mint: { accent: '#46D3A6', canvas: '#111917' },
  lemon: { accent: '#F4DC3C', canvas: '#141413' }, rose: { accent: '#FF7FA9', canvas: '#1B1418' },
  lilac: { accent: '#B69CFF', canvas: '#17151C' },
} as const
export const coverSettingsSchema = z.object({
  enabled: z.boolean().default(true), style: z.enum(coverStyles).default('knowledge'),
  palette: z.enum(['azure', 'amber', 'coral', 'mint', 'lemon', 'rose', 'lilac']).default('azure'),
  aspect: z.enum(['video', 'landscape', 'portrait', 'note', 'square']).default('video'),
  title: z.string().trim().max(120).default(''), subtitle: z.string().trim().max(120).default(''), badge: z.string().trim().max(32).default(''),
  frameMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
})
export type CoverSettings = z.infer<typeof coverSettingsSchema>
export type CoverFrame = { dataUrl: string; width: number; height: number; frameMs: number }
export const sceneSchema = z.object({ id: z.string().uuid(), candidateId: z.string().uuid(), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() }).refine(value => value.endMs - value.startMs >= 100)
export const draftSettingsSchema = z.object({ aspect: z.enum(['original', 'portrait', 'landscape']).default('original'), layout: z.enum(['fit', 'crop', 'blur']).default('fit'), cropX: z.number().min(0).max(1).default(0.5), subtitles: z.boolean().default(true), subtitleStyle: z.enum(['clean', 'bold', 'box']).default('clean'), title: z.string().trim().max(120).default(''), originalAudio: z.boolean().default(true), resolution: outputResolution.default('original'), cover: coverSettingsSchema.optional() })
export const clipDefaultsSchema = draftSettingsSchema.omit({ title: true, resolution: true })
export type DraftSettings = z.infer<typeof draftSettingsSchema>
export type Draft = { id: string; title: string; revision: number; transcriptId: string; scenes: z.infer<typeof sceneSchema>[]; settings: DraftSettings; updatedAt: string }
export const draftSaveSchema = z.object({ documentId: z.string().uuid(), id: z.string().uuid(), revision: z.number().int().nonnegative(), title: z.string().trim().min(1).max(200), scenes: z.array(sceneSchema).max(30), settings: draftSettingsSchema })
export type RenderedMedia = { width: number; height: number; frameRate: number; audio: boolean }
export type RenderJob = { id: string; draftId: string; revision: number; snapshot: Draft; preview: boolean; status: ClipStatus; progress?: number; stage?: string; error?: string; createdAt: string; name?: string; durationMs?: number; media?: RenderedMedia; rendererVersion?: number }
export type CoverJob = { id: string; draftId: string; revision: number; snapshot: Draft; renderId?: string; cacheKey: string; status: ClipStatus; createdAt: string; name?: string; width?: number; height?: number; frameMs: number; error?: string; warning?: string }
export type ClipProject = { schemaVersion: 1; documentId: string; sourceSignature: string; transcripts: TranscriptSnapshot[]; runs: AnalysisRun[]; candidates: Candidate[]; drafts: Draft[]; renders: RenderJob[]; covers?: CoverJob[]; updatedAt: string }
export type ClippingState = { version: number; settings: CloudSettings }
export const clipCommands = {
  'cloud:save': cloudSaveSchema,
  'cloud:check': z.object({ kind: z.enum(['analysis', 'transcription']) }),
  'clipping:get': z.object({ documentId: z.string().uuid() }),
  'clipping:analyze': z.object({ documentId: z.string().uuid(), options: analysisOptionsSchema, retryRunId: z.string().uuid().optional() }),
  'clipping:create': z.object({ documentId: z.string().uuid(), candidateIds: z.array(z.string().uuid()).min(1).max(30), separate: z.boolean().default(false) }),
  'clipping:save': draftSaveSchema,
  'clipping:duplicate': z.object({ documentId: z.string().uuid(), draftId: z.string().uuid(), draft: draftSaveSchema.optional() }),
  'clipping:remove': z.object({ documentId: z.string().uuid(), draftId: z.string().uuid() }),
  'clipping:render': z.object({ documentId: z.string().uuid(), draftId: z.string().uuid(), revision: z.number().int().nonnegative(), preview: z.boolean().default(false) }),
  'clipping:cancel': z.object({ documentId: z.string().uuid(), taskId: z.string().uuid() }),
  'clipping:open': z.object({ documentId: z.string().uuid(), taskId: z.string().uuid(), reveal: z.boolean().default(false) }),
  'clipping:captions': z.object({ documentId: z.string().uuid(), draftId: z.string().uuid(), format: z.enum(['srt', 'vtt']) }),
  'clipping:cover': z.object({ documentId: z.string().uuid(), draftId: z.string().uuid(), revision: z.number().int().nonnegative() }),
  'clipping:cover-frame': z.object({ documentId: z.string().uuid(), draftId: z.string().uuid(), scenes: z.array(sceneSchema).min(1).max(30), frameMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  'clipping:cover-render': z.object({ documentId: z.string().uuid(), taskId: z.string().uuid() }),
  'clipping:cover-export': z.object({ documentId: z.string().uuid(), coverId: z.string().uuid() }),
} as const

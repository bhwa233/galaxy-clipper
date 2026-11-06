import { z } from 'zod'
import { analysisOptionsSchema, draftSaveSchema, providerSchema } from './clipping'
import { modelId } from './processing'
const id = z.string().uuid(), time = z.number().int().nonnegative(), finite = z.number().finite()
const speaker = z.object({ id: z.string(), name: z.string().max(200) })
const cue = z.object({ id: z.string(), text: z.string().max(20000), startMs: time, endMs: time, speakerId: z.string().nullable(), words: z.array(z.object({ text: z.string(), startMs: time, endMs: time })).optional() }).refine(v => v.endMs > v.startMs)
const cues = z.array(cue).max(200000)
export const legacyDocumentSchema = z.object({
  id, title: z.string().max(1000), sourcePath: z.string().min(1).max(32768), revision: time,
  captions: cues, speakers: z.array(speaker), language: z.string().optional(), model: modelId.optional(),
  tracks: z.array(z.object({ id, language: z.string(), source: z.enum(['platform', 'file', 'asr', 'remote']), name: z.string() })), activeTrack: id.optional(),
  trackData: z.record(z.string(), cues).default({}), trackSpeakers: z.record(z.string(), z.array(speaker)).default({}),
})
const candidate = z.object({ id, runId: id, transcriptId: id, startMs: time, endMs: time, title: z.string().max(1000), reason: z.string().max(10000), score: finite })
const status = z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'])
const draft = draftSaveSchema.omit({ documentId: true }).extend({ transcriptId: id, updatedAt: z.string() })
const media = z.object({ width: finite.positive(), height: finite.positive(), frameRate: finite.positive(), audio: z.boolean() })
export const legacyProjectSchema = z.object({
  schemaVersion: z.literal(1), documentId: id, sourceSignature: z.string(), updatedAt: z.string(),
  transcripts: z.array(z.object({ id, trackId: id.optional(), revision: time, captions: cues, speakers: z.array(speaker), language: z.string().optional(), fingerprint: z.string() })),
  candidates: z.array(candidate).max(10000), drafts: z.array(draft).max(1000),
  runs: z.array(z.object({ id, transcriptId: id, cacheKey: z.string(), options: analysisOptionsSchema, provider: providerSchema, status,
    windows: z.array(z.object({ first: time, last: time, status: z.enum(['pending', 'completed', 'failed']), candidates: z.array(candidate), error: z.string().optional() })), createdAt: z.string(), error: z.string().optional(), candidateIds: z.array(id).optional() })),
  renders: z.array(z.object({ id, draftId: id, revision: time, snapshot: draft, preview: z.boolean(), status, progress: finite.optional(), stage: z.string().optional(), error: z.string().optional(), createdAt: z.string(), name: z.string().optional(), durationMs: time.optional(), media: media.optional(), rendererVersion: time.optional() })),
  covers: z.array(z.object({ id, draftId: id, revision: time, snapshot: draft, renderId: id.optional(), cacheKey: z.string(), status, createdAt: z.string(), name: z.string().optional(), width: finite.optional(), height: finite.optional(), frameMs: time, error: z.string().optional(), warning: z.string().optional() })).default([]),
})

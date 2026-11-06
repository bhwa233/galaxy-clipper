import { z } from 'zod'
import { captionLanguages, captionPatch, modelId, outputResolution, speakerCount, type ProcessingDocument, type ProcessingState } from './processing'
import { clipCommands, clipDefaultsSchema, type ClipProject, type ClippingState, type CloudConnection, type CoverFrame } from './clipping'

export const settingsSchema = z.object({
  locale: z.enum(['zh', 'en']).default('zh'), theme: z.enum(['dark', 'light', 'system']).default('dark'),
  outputDirectory: z.string().default(''), outputFormat: z.enum(['mp4', 'mkv']).default('mp4'), outputResolution: outputResolution.default('original'),
  transcriptionModel: modelId.default('balanced'), transcriptionSpeakers: speakerCount.default(1), transcriptionConcurrency: z.number().int().min(1).max(4).default(1),
  captionLanguages: captionLanguages.default(['zh', 'en']), clipDefaults: clipDefaultsSchema.default(() => clipDefaultsSchema.parse({})),
})
export type Settings = z.infer<typeof settingsSchema>
export type ClientState = { settings: Settings; processing: ProcessingState; clipping: ClippingState; tools: { engine: boolean; ffmpeg: boolean; error?: string }; version: string }
export const commandSchemas = {
  ...clipCommands,
  'state:get': z.null(), 'settings:save': settingsSchema, 'settings:directory': z.null(), 'project:import': z.null(),
  'processing:import': z.null(), 'processing:get': z.object({ id: z.string().uuid() }),
  'processing:run': z.object({ id: z.string().uuid(), action: z.enum(['transcribe', 'recognize', 'speakers']), model: modelId.optional(), speakers: speakerCount.optional() }),
  'processing:cancel': z.object({ id: z.string().uuid() }), 'processing:retry': z.object({ id: z.string().uuid() }), 'processing:remove': z.object({ id: z.string().uuid() }),
  'processing:captions': z.object({ id: z.string().uuid() }), 'processing:track': z.object({ id: z.string().uuid(), trackId: z.string() }), 'processing:edit': captionPatch,
  'processing:speaker': z.object({ id: z.string().uuid(), speakerId: z.string(), name: z.string().trim().min(1).max(100) }),
  'processing:export': z.object({ id: z.string().uuid(), format: z.enum(['txt', 'md', 'srt', 'vtt', 'soft', 'burn', 'video']) }),
  'processing:open-export': z.object({ id: z.string().uuid(), index: z.number().int().nonnegative() }),
  'models:import': z.null(), 'models:download': z.object({ id: z.union([modelId, z.literal('speaker')]) }),
  'models:cancel': z.object({ id: z.union([modelId, z.literal('speaker')]) }), 'models:remove': z.object({ id: z.union([modelId, z.literal('speaker')]) }),
} as const
export type Command = keyof typeof commandSchemas
export type CommandInput<C extends Command> = z.input<(typeof commandSchemas)[C]>
export type Reply = { ok: true; state: ClientState; document?: ProcessingDocument; clipProject?: ClipProject; coverFrame?: CoverFrame; cloudConnection?: CloudConnection; imported?: number } | { ok: false; message: string }
export interface DesktopApi { command<C extends Command>(name: C, input: CommandInput<C>): Promise<Reply>; subscribe(listener: (state: ClientState) => void): () => void }

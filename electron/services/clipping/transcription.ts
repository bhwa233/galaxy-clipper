import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ProviderSnapshot } from '../../../shared/clipping'
import type { Caption, Speaker } from '../../../shared/processing'
import type { Engine } from '../engine'
import { CloudServices, clipError, fingerprint } from './cloud'

const responseSchema = z.object({ language: z.string().optional(), text: z.string().optional(), segments: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), text: z.string().max(20000), speaker: z.union([z.string(), z.number()]).nullable().optional() })).max(100000) })
export type RemoteTranscript = { captions: Caption[]; speakers: Speaker[]; language?: string }
export class RemoteTranscription {
  constructor(private engine: Engine, private cloud: CloudServices) {}
  async run(input: string, directory: string, provider: ProviderSnapshot, signal: AbortSignal, changed: (stage: string, progress: number) => void, force: boolean): Promise<RemoteTranscript> {
    const info = statSync(input), media = await this.engine.request<{ durationSeconds: number }>({ operation: 'inspect', input }, signal)
    if (!Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0) throw clipError('duration')
    const key = fingerprint([input, info.size, info.mtimeMs, provider.baseUrl, provider.model, 'remote-asr-v1'])
    const folder = path.join(directory, 'remote-' + key)
    if (force) rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    const captions: Caption[] = [], speakers = new Map<string, Speaker>()
    let language: string | undefined
    // Five minutes of mono 16 kHz PCM stays below 10 MB. A two-second overlap
    // gives the provider context; midpoint ownership prevents duplicate cues.
    const stride = 298, chunkLength = 300, count = Math.max(1, Math.ceil((media.durationSeconds - chunkLength) / stride) + 1)
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted()
      const start = index * stride, duration = Math.min(chunkLength, media.durationSeconds - start)
      const cache = path.join(folder, String(index) + '.json'), audio = path.join(folder, String(index) + '.wav')
      let raw: unknown
      if (existsSync(cache)) {
        try { raw = JSON.parse(readFileSync(cache, 'utf8')) } catch { /* Invalid checkpoints are retried explicitly below. */ }
      }
      if (!responseSchema.safeParse(raw).success) {
        changed('preparing-audio', index / count)
        await this.engine.request({ operation: 'audio-chunk', input, output: audio, startMs: Math.round(start * 1000), durationMs: Math.round(duration * 1000) }, signal)
        try {
          if (statSync(audio).size > 24 * 1024 * 1024) throw clipError('audioSize')
          const form = new FormData()
          form.append('file', new Blob([readFileSync(audio)]), 'audio.wav')
          form.append('model', provider.model)
          form.append('response_format', 'verbose_json')
          form.append('timestamp_granularities[]', 'segment')
          changed('remote-transcribing', index / count)
          raw = await this.cloud.request(provider, 'audio/transcriptions', form, signal)
          signal.throwIfAborted()
          const checked = responseSchema.safeParse(raw)
          if (!checked.success) throw clipError('timestamps')
          if (!checked.data.segments.length && checked.data.text?.trim()) throw clipError('timestamps')
          if (checked.data.segments.length && !checked.data.segments.some(segment => segment.end > segment.start && segment.start < duration && segment.end <= duration + 1)) throw clipError('timestamps')
          writeFileSync(cache + '.tmp', JSON.stringify(checked.data), { mode: 0o600 }); renameSync(cache + '.tmp', cache)
        } finally { rmSync(audio, { force: true }) }
      }
      const result = responseSchema.parse(raw)
      if (!result.segments.length && result.text?.trim()) throw clipError('timestamps')
      language ||= result.language
      const lower = index === 0 ? 0 : start + 1, upper = index === count - 1 ? media.durationSeconds : start + stride + 1
      for (const segment of result.segments) {
        if (segment.end <= segment.start || segment.end > duration + 1 || !segment.text.trim()) continue
        const middle = start + (segment.start + segment.end) / 2
        if (middle < lower || middle >= upper) continue
        const startMs = Math.round(Math.max(0, start + segment.start) * 1000), endMs = Math.round(Math.min(media.durationSeconds, start + segment.end) * 1000)
        if (endMs <= startMs) continue
        // Provider speaker labels are scoped to each upload, not assumed identical across chunks.
        const label = segment.speaker == null ? undefined : String(index) + ':' + String(segment.speaker)
        if (label && !speakers.has(label)) speakers.set(label, { id: randomUUID(), name: String(segment.speaker) + (count > 1 ? ' · ' + (index + 1) : '') })
        captions.push({ id: randomUUID(), text: segment.text.trim(), startMs, endMs, speakerId: label ? speakers.get(label)!.id : null })
      }
      changed('remote-transcribing', (index + 1) / count)
    }
    return { captions: captions.sort((a, b) => a.startMs - b.startMs), speakers: [...speakers.values()], language }
  }
}

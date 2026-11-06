import { safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { cloudSaveSchema, providerSchema, type CloudSettings, type ProviderSnapshot, type CloudConnection } from '../../../shared/clipping'
import { i18n } from '../../../shared/i18n'

type Saved = { version: 1; route: 'local' | 'remote'; analysis: ProviderSnapshot; transcription: ProviderSnapshot; secrets: Record<string, string> }
class CloudError extends Error {
  constructor(key: string, values?: Record<string, unknown>) { super(i18n.t(('clipping:errors.' + key) as 'clipping:errors.config', values)); this.name = 'CloudError' }
}
export const clipError = (key: string, values?: Record<string, unknown>) => new CloudError(key, values)
// Reuse native fetch/FormData and Electron safeStorage: an SDK/keychain package would
// duplicate those installed runtimes. Requests stay within the saved service and fixed operations.
export class CloudServices {
  private saved: Saved = { version: 1, route: 'local', analysis: providerSchema.parse({}), transcription: providerSchema.parse({}), secrets: {} }
  private checks = new Map<CloudConnection['kind'], { key: string; controller: AbortController; work: Promise<CloudConnection> }>()
  private stopped = false
  constructor(private directory: string, private changed: () => void) {
    const file = path.join(directory, 'cloud.json')
    if (existsSync(file)) {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Saved
      if (value.version !== 1) throw new Error('Unsupported cloud settings version')
      this.saved = { ...value, analysis: { ...providerSchema.parse(value.analysis), credentialId: value.analysis.credentialId }, transcription: { ...providerSchema.parse(value.transcription), credentialId: value.transcription.credentialId } }
    }
  }
  state(): CloudSettings {
    const publicProvider = (kind: 'analysis' | 'transcription') => { const { credentialId, ...provider } = this.saved[kind]; return { ...provider, hasKey: Boolean(credentialId && this.saved.secrets[credentialId]) } }
    return { route: this.saved.route, analysis: publicProvider('analysis'), transcription: publicProvider('transcription'), secureStorage: safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text') }
  }
  save(input: unknown): void {
    const value = cloudSaveSchema.parse(input), next: Saved = structuredClone(this.saved)
    for (const kind of ['analysis', 'transcription'] as const) {
      const config = value[kind]
      let credentialId = next[kind].credentialId
      if (config.clearKey) { if (credentialId) delete next.secrets[credentialId]; credentialId = undefined }
      if (config.apiKey?.trim()) {
        if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw clipError('secureStorage')
        credentialId = randomUUID()
        next.secrets[credentialId] = safeStorage.encryptString(config.apiKey.trim()).toString('base64')
      }
      next[kind] = { ...providerSchema.parse(config), credentialId }
    }
    next.route = value.route
    mkdirSync(this.directory, { recursive: true })
    const file = path.join(this.directory, 'cloud.json')
    writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 }); renameSync(file + '.tmp', file)
    this.saved = next; this.changed()
  }
  snapshot(kind: 'analysis' | 'transcription'): ProviderSnapshot { return structuredClone(this.saved[kind]) }
  check(kind: CloudConnection['kind']): Promise<CloudConnection> {
    if (this.stopped) return Promise.reject(clipError('busy'))
    const provider = this.snapshot(kind), key = fingerprint(provider), held = this.checks.get(kind)
    if (held) return held.key === key ? held.work : Promise.reject(clipError('busy'))
    const controller = new AbortController()
    const work = this.request(provider, 'models', undefined, controller.signal).then(result => {
      const data = result && typeof result === 'object' && 'data' in result ? result.data : undefined
      if (!Array.isArray(data) || data.some(model => !model || typeof model !== 'object' || typeof model.id !== 'string')) throw clipError('response')
      return { kind, modelListed: data.some(model => model.id === provider.model) }
    }).finally(() => { this.checks.delete(kind) })
    this.checks.set(kind, { key, controller, work })
    return work
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const check of this.checks.values()) check.controller.abort()
    await Promise.allSettled([...this.checks.values()].map(check => check.work))
  }
  private async readResponse(response: Response): Promise<unknown> {
    if (!response.body) { if (response.ok) throw clipError('response'); return }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 8 * 1024 * 1024) throw clipError('response')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { if (response.ok) throw clipError('response') }
  }
  async request(provider: ProviderSnapshot, operation: 'chat/completions' | 'audio/transcriptions' | 'models', body: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (!provider.baseUrl || !provider.model) throw clipError('config')
    const url = new URL(provider.baseUrl.replace(/\/+$/, '') + '/' + operation)
    const headers: Record<string, string> = {}
    if (provider.credentialId) {
      const encrypted = this.saved.secrets[provider.credentialId]
      if (!encrypted || !safeStorage.isEncryptionAvailable()) throw clipError('secureStorage')
      headers.Authorization = 'Bearer ' + safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    }
    const multipart = body instanceof FormData
    const checking = operation === 'models'
    if (!multipart && !checking) headers['Content-Type'] = 'application/json'
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(checking ? 15000 : operation === 'audio/transcriptions' ? 600000 : 180000)])
    const payload = checking ? undefined : multipart ? body : JSON.stringify(body)
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, { method: checking ? 'GET' : 'POST', headers, body: payload, signal: requestSignal, redirect: 'error' })
        const result = await this.readResponse(response)
        if (response.ok) return result
        const failure = result && typeof result === 'object' && 'error' in result ? result.error : undefined
        const fields = failure && typeof failure === 'object' ? failure as Record<string, unknown> : {}
        const code = [fields.code, fields.type].filter(value => typeof value === 'string').join(' ')
        if (response.status === 401 || response.status === 403) throw clipError('auth')
        if (response.status === 402 || response.status === 429 && /quota|billing|insufficient_balance|insufficient_credit/i.test(code)) throw clipError('quota')
        if (![429, 502, 503, 504].includes(response.status) || attempt >= 2) throw clipError(response.status === 429 ? 'rateLimit' : 'http', { status: response.status })
        let waitMs = 1000 * 2 ** attempt
        const retryAfter = response.headers.get('retry-after')?.trim()
        if (retryAfter) {
          const seconds = Number(retryAfter)
          const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : NaN
          if (Number.isFinite(requested)) waitMs = Math.max(0, requested)
        }
        // Honor long server waits by returning control instead of retrying early.
        if (waitMs > 60000) throw clipError('retryAfter', { seconds: Math.ceil(waitMs / 1000) })
        await delay(waitMs, undefined, { signal: requestSignal })
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof CloudError) throw error
      if (requestSignal.aborted) throw clipError('timeout')
      throw clipError('network')
    }
  }
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

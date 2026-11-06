import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Choice } from './Choice'
import type { Send } from '@/App'
import type { CloudSettings, CloudConnection } from '../../../shared/clipping'

export function TranscriptionMode({ settings, send, disabled }: { settings: CloudSettings; send: Send; disabled?: boolean }) {
  const { t } = useTranslation('clipping')
  return <Choice label={t('route')} value={settings.route} disabled={disabled} onChange={route => { void send('cloud:save', { route: route as CloudSettings['route'], analysis: settings.analysis, transcription: settings.transcription }) }} options={[{ value: 'local', label: t('local') }, { value: 'remote', label: t('remote') }]} />
}

export function CloudServices({ settings, send }: { settings: CloudSettings; send: Send }) {
  const { t } = useTranslation('clipping')
  const [route, setRoute] = useState(settings.route)
  const [analysis, setAnalysis] = useState({ ...settings.analysis, apiKey: '', clearKey: false })
  const [transcription, setTranscription] = useState({ ...settings.transcription, apiKey: '', clearKey: false })
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  const [checking, setChecking] = useState<CloudConnection['kind']>()
  const [connection, setConnection] = useState<CloudConnection & { baseUrl: string; model: string }>()
  return <form className="flex flex-col gap-4" onSubmit={event => {
    event.preventDefault(); setBusy(true); setSaved(false); setConnection(undefined)
    void send('cloud:save', { route, analysis, transcription }).then(reply => {
      if (reply) { setAnalysis(value => ({ ...value, apiKey: '', clearKey: false })); setTranscription(value => ({ ...value, apiKey: '', clearKey: false })); setSaved(true) }
    }).finally(() => setBusy(false))
  }}>
    <Card><CardHeader><CardTitle>{t('settings')}</CardTitle><CardDescription>{t('settingsHint')}</CardDescription></CardHeader><CardContent><FieldGroup>
      <Choice label={t('route')} value={route} onChange={value => setRoute(value as CloudSettings['route'])} options={[{ value: 'local', label: t('local') }, { value: 'remote', label: t('remote') }]} />
      {!settings.secureStorage && <Alert><AlertDescription>{t('secureUnavailable')}</AlertDescription></Alert>}
    </FieldGroup></CardContent></Card>
    {(['analysis', 'transcription'] as const).map(kind => {
      const config = kind === 'analysis' ? analysis : transcription, update = kind === 'analysis' ? setAnalysis : setTranscription
      const unsaved = config.baseUrl.trim() !== settings[kind].baseUrl || config.model.trim() !== settings[kind].model || Boolean(config.apiKey.trim()) || config.clearKey
      const result = connection?.kind === kind && connection.baseUrl === config.baseUrl.trim() && connection.model === config.model.trim() && !unsaved ? connection : undefined
      return <Card key={kind}><CardHeader><CardTitle>{t(kind === 'analysis' ? 'analysisService' : 'transcriptionService')}</CardTitle><CardDescription>{t(kind === 'analysis' ? 'privacy' : 'remoteHint')}</CardDescription></CardHeader><CardContent><FieldGroup>
        <Field><FieldLabel htmlFor={kind + '-url'}>{t('baseUrl')}</FieldLabel><Input id={kind + '-url'} type="url" value={config.baseUrl} placeholder="https://api.example.com/v1" onChange={event => update(value => ({ ...value, baseUrl: event.target.value }))} autoComplete="off" /></Field>
        <Field><FieldLabel htmlFor={kind + '-model'}>{t('model')}</FieldLabel><Input id={kind + '-model'} value={config.model} onChange={event => update(value => ({ ...value, model: event.target.value }))} maxLength={200} /></Field>
        <Field><FieldLabel htmlFor={kind + '-key'}>{t('key')}</FieldLabel><Input id={kind + '-key'} type="password" value={config.apiKey} placeholder={settings[kind].hasKey ? t('keySaved') : ''} disabled={!settings.secureStorage} onChange={event => update(value => ({ ...value, apiKey: event.target.value }))} autoComplete="new-password" /></Field>
        <Field orientation="horizontal"><Checkbox id={kind + '-clear'} checked={config.clearKey} onCheckedChange={checked => update(value => ({ ...value, clearKey: checked }))} /><FieldLabel htmlFor={kind + '-clear'}>{t('clearKey')}</FieldLabel></Field>
        {kind === 'analysis' && <Field><FieldLabel htmlFor="analysis-context">{t('context')}</FieldLabel><Input id="analysis-context" type="number" min={2000} max={100000} required value={config.contextChars} onChange={event => update(value => ({ ...value, contextChars: event.target.valueAsNumber }))} /><FieldDescription>{t('privacy')}</FieldDescription></Field>}
        <div className="flex flex-col gap-2"><Button type="button" variant="outline" disabled={busy || Boolean(checking) || unsaved || !settings[kind].baseUrl || !settings[kind].model} onClick={() => {
          setChecking(kind); setConnection(undefined)
          const provider = { baseUrl: settings[kind].baseUrl, model: settings[kind].model }
          void send('cloud:check', { kind }).then(reply => { if (reply && reply.cloudConnection) setConnection({ ...reply.cloudConnection, ...provider }) }).finally(() => setChecking(undefined))
        }}>{t(checking === kind ? 'checkingConnection' : 'checkConnection')}</Button>
          <FieldDescription>{t(unsaved ? 'saveBeforeCheck' : 'connectionHint')}</FieldDescription>
          {result && <p role="status" className="text-sm text-muted-foreground">{t(result.modelListed ? 'connectionListed' : 'connectionNotListed')}</p>}
        </div>
      </FieldGroup></CardContent></Card>
    })}
    <div className="flex items-center justify-end gap-3">{saved && <p role="status">{t('saved')}</p>}<Button type="submit" disabled={busy || Boolean(checking)}>{t('saveSettings')}</Button></div>
  </form>
}

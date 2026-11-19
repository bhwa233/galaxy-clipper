import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, Download, FolderOpen, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { formatBytes } from '@/lib/utils'
import type { Send } from '@/App'
import type { ModelStatus, ProcessingDocument } from '../../../shared/processing'

export function ModelWait({ document, models, send, manageModels }: { document: ProcessingDocument; models: ModelStatus[]; send: Send; manageModels: () => void }) {
  const { t: p } = useTranslation('processing'), { t } = useTranslation('editor')
  const [importing, setImporting] = useState(false)
  const model = models.find(item => item.id === document.model)
  const downloading = model?.downloading
  const otherDownload = !downloading && models.some(item => item.downloading)
  const progress = model?.progress ? Math.floor(model.progress * 100) : null
  const status = downloading ? p(`modelWait.${model?.phase || 'downloading'}`) : p(model?.error ? 'modelWait.failed' : 'statuses.waiting-model')

  return <section aria-label={p('statuses.waiting-model')} className="flex flex-col gap-3 rounded-lg border bg-card p-3">
    <div className="flex flex-wrap items-center justify-between gap-2" role="status">
      <h3 className="text-sm font-medium">{model?.name || p('model')}</h3>
      <Badge variant="secondary">{status}</Badge>
    </div>
    {downloading && model ? <>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>{p('modelWait.received', { size: formatBytes(model.bytes) })}</span>
        {model.phase === 'downloading' && progress !== null && <span>{progress}%</span>}
      </div>
      <Progress value={model.phase === 'downloading' ? progress : null} aria-label={status} />
      <Button size="sm" variant="outline" onClick={() => void send('models:cancel', { id: model.id })}><X data-icon="inline-start" />{p('cancelDownload')}</Button>
    </> : <>
      {model?.error && <Alert variant="destructive"><CircleAlert /><AlertTitle>{p('modelWait.failed')}</AlertTitle><AlertDescription className="break-words">{model.error}</AlertDescription></Alert>}
      {model && !model.ready && <Button size="sm" disabled={importing} onClick={() => void send('models:download', { id: model.id })}>
        <Download data-icon="inline-start" />{p(model.error ? 'modelWait.retry' : 'downloadContinue')}
      </Button>}
      {model && !model.ready && !otherDownload && <Button size="sm" variant="outline" disabled={importing} onClick={() => {
        setImporting(true)
        void send('models:import', null).finally(() => setImporting(false))
      }}><FolderOpen data-icon="inline-start" />{t('importModels')}</Button>}
    </>}
    <div className="flex flex-wrap items-center justify-between gap-1 border-t pt-2">
      <Button size="sm" variant="ghost" onClick={manageModels}>{t('manageModels')}</Button>
      <Button size="sm" variant="outline" onClick={() => void send('processing:cancel', { id: document.id })}>{p('modelWait.cancelTranscription')}</Button>
    </div>
  </section>
}

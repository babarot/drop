import { useCallback, useState } from 'react'
import type { SiteDraft } from './lib/ingest'
import type { SiteMeta, UploadItem } from './types'

// Queue entry for a validation error (retryable: false, since a retry cannot fix it)
export const invalidItem = (
  filename: string,
  message: string,
  kind: UploadItem['kind'] = 'upload',
  target?: SiteMeta,
): UploadItem => ({
  key: crypto.randomUUID(),
  filename,
  state: 'error' as const,
  message,
  retryable: false,
  kind,
  target,
})

// State machine for one upload queue. It holds only the entries' state transitions and the
// aggregate progress (batch); what to upload (uploadSite / sendTree etc.) and the side effects
// after success are passed by the caller as run()'s task. App's global queue and the assets
// dialog's local queue each have their own instance
export function useUploadQueue() {
  const [items, setItems] = useState<UploadItem[]>([])
  // Aggregate progress of the batch (until the queue empties). invalid entries are not counted
  const [batch, setBatch] = useState({ done: 0, total: 0 })

  const patch = useCallback((key: string, p: Partial<UploadItem>) => {
    setItems((prev) => prev.map((u) => (u.key === key ? { ...u, ...p } : u)))
  }, [])

  const remove = useCallback((key: string) => {
    setItems((prev) => prev.filter((u) => u.key !== key))
  }, [])

  // Add already-built entries directly, such as invalid ones
  const push = useCallback((entries: UploadItem[]) => {
    if (entries.length === 0) return
    setItems((prev) => [...prev, ...entries])
  }, [])

  // Push an uploading entry and return its key. run() does the work
  // draft is the draft sent as one site (kept so a retry sends the same thing again)
  const enqueue = useCallback(
    (file: File, kind: UploadItem['kind'], target?: SiteMeta, draft?: SiteDraft) => {
      const key = crypto.randomUUID()
      setItems((prev) => [
        ...prev,
        {
          key,
          filename:
            draft && draft.files.length > 1
              ? `${draft.label} (${draft.files.length} files)`
              : (draft?.label ?? file.name),
          state: 'uploading' as const,
          retryable: true,
          file,
          draft,
          kind,
          target,
        },
      ])
      return key
    },
    [],
  )

  // Add n items to the batch. If the previous batch has finished, reset the progress
  const extendBatch = useCallback((n: number) => {
    setBatch((b) =>
      b.done === b.total ? { done: 0, total: n } : { done: b.done, total: b.total + n },
    )
  }, [])

  // Count batch items as done without running them (for example when the HTML failed and the assets
  // are not queued)
  const bumpDone = useCallback((n = 1) => {
    setBatch((b) => ({ ...b, done: b.done + n }))
  }, [])

  // Skeleton for running one item. On success, remove the entry and return the task's result. On
  // failure, set the entry to error and return null, leaving whether to continue the batch to the
  // caller
  const run = useCallback(
    async <T>(key: string, task: () => Promise<T>, fallbackMessage: string): Promise<T | null> => {
      try {
        const result = await task()
        remove(key)
        return result
      } catch (e) {
        patch(key, { state: 'error', message: e instanceof Error ? e.message : fallbackMessage })
        return null
      } finally {
        bumpDone()
      }
    },
    [patch, remove, bumpDone],
  )

  const uploading = items.some((u) => u.state === 'uploading')
  // The aggregate progress pill shows only while a multi-item batch runs (for one item the entry's
  // spinner is enough)
  const progress = batch.total >= 2 && batch.done < batch.total ? batch : null

  return { items, uploading, progress, patch, remove, push, enqueue, extendBatch, bumpDone, run }
}

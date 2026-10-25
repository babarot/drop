import type { UploadItem } from '../types'

interface Props {
  items: UploadItem[]
  // Aggregate progress, passed only for a multi-item batch (each entry holds its own state)
  progress: { done: number; total: number } | null
  onRetry: (key: string) => void
  onRemove: (key: string) => void
}

export function UploadQueue({ items, progress, onRetry, onRemove }: Props) {
  if (items.length === 0) return null
  return (
    <div className="upload-queue">
      {progress && (
        <p className="upload-progress" role="status">
          <span className="spinner" />
          uploading {progress.done}/{progress.total}
        </p>
      )}
      <ul>
        {items.map((item) => (
          <li key={item.key} className={`upload-item${item.state === 'error' ? ' error' : ''}`}>
            <span className="name">{item.filename}</span>
            {item.kind === 'replace' && item.target && (
              <span className="replace-target">↻ updating "{item.target.title}"</span>
            )}
            {item.kind === 'asset' && item.target && (
              <span className="replace-target">→ asset of "{item.target.title}"</span>
            )}
            {item.state === 'uploading' ? (
              <>
                {item.message && <span className="message">{item.message}</span>}
                <span className="spinner" />
              </>
            ) : (
              <>
                <span className="message">{item.message}</span>
                {item.retryable && (
                  <button type="button" className="btn" onClick={() => onRetry(item.key)}>
                    retry
                  </button>
                )}
                <button type="button" className="btn" onClick={() => onRemove(item.key)}>
                  remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

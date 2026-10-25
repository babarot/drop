import { useEffect } from 'react'

interface Props {
  message: string
  action?: { label: string; onClick: () => void }
  onUndo?: () => void
  onDismiss: () => void
}

const TOAST_TIMEOUT_MS = 8000

export function Toast({ message, action, onUndo, onDismiss }: Props) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, TOAST_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div className="toast glass">
      <span className="toast-message">{message}</span>
      {action && (
        <button type="button" className="btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onUndo && (
        <button type="button" className="btn" onClick={onUndo}>
          undo
        </button>
      )}
      <button type="button" className="btn" onClick={onDismiss} aria-label="close">
        ✕
      </button>
    </div>
  )
}

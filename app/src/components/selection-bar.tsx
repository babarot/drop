// Bar at the bottom of the screen while any Site is selected. A plain click on a card toggles it
// while selecting, so the bar keeps the mode visible and gives the way out (clear / Esc). move to…
// is the way to move the Selection without DnD
interface Props {
  count: number
  onMove: () => void
  onClear: () => void
}

export function SelectionBar({ count, onMove, onClear }: Props) {
  return (
    <section className="selection-bar glass" aria-label="selection">
      <span className="selection-count">{count} selected</span>
      <span className="selection-hint">drag onto a folder · Esc to clear</span>
      <button type="button" className="btn" onClick={onMove}>
        move to…
      </button>
      <button type="button" className="btn" onClick={onClear}>
        clear
      </button>
    </section>
  )
}

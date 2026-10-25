import { useDroppable } from '@dnd-kit/core'
import { Folder, Inbox } from 'lucide-react'
import type { FolderMeta } from '../types'

// Fixed drop-target dock shown at the bottom of the screen only while a site card is dragged.
// The folder bar scrolls off screen, so this provides targets with the shortest drag distance
// even for cards far down the list (on mobile, within thumb reach).
// droppable ids are registered with a `dock-` prefix, which onDragEnd strips to
// normalize them to the folder bar's pills (to avoid registering the same id twice)
interface Props {
  folders: FolderMeta[]
  unfiledCount: number
}

function DockPill({
  id,
  icon,
  name,
  count,
}: {
  id: string
  icon: React.ReactNode
  name: string
  count: number
}) {
  const droppable = useDroppable({ id })
  return (
    <div
      ref={droppable.setNodeRef}
      className={`folder-pill dock-pill${droppable.isOver ? ' drag-over' : ''}`}
    >
      <span className="folder-pill-label">
        {icon}
        <span className="folder-pill-name">{name}</span>
        <span className="n">{count}</span>
      </span>
    </div>
  )
}

export function DropDock({ folders, unfiledCount }: Props) {
  return (
    <div className="drop-dock glass">
      <DockPill id="dock-unfiled" icon={<Inbox size={14} />} name="unfiled" count={unfiledCount} />
      {folders.map((f) => (
        <DockPill
          key={f.id}
          id={`dock-folder-${f.id}`}
          icon={<Folder size={14} />}
          name={f.name}
          count={f.siteCount}
        />
      ))}
    </div>
  )
}

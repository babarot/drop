import { useDroppable } from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { EllipsisVertical, Folder, Inbox, Layers, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FolderMeta, FolderSelection } from '../types'

interface Props {
  folders: FolderMeta[]
  unfiledCount: number
  totalCount: number
  selected: FolderSelection
  onSelect: (next: FolderSelection) => void
  onCreate: () => void
  onRename: (folder: FolderMeta) => void
  onDelete: (folder: FolderMeta) => void
  // Whether a site card is being dragged (the pills' drop highlight shows only then,
  // distinct from isOver while reordering Folders)
  draggingSite: boolean
  // For checking the bar's visibility (App decides whether to show DropDock when a drag starts)
  navRef?: React.Ref<HTMLElement>
}

// Pill content (icon + name + count). Shared by all / unfiled / Folder pills
function PillLabel({ icon, name, count }: { icon: React.ReactNode; name: string; count: number }) {
  return (
    <>
      {icon}
      <span className="folder-pill-name">{name}</span>
      <span className="n">{count}</span>
    </>
  )
}

// Pill for one Folder. useSortable makes it both a reorder handle and a drop target for sites
// (useSortable includes a droppable, so useDroppable is not registered separately).
// Only the selected pill shows ⋮, which opens the rename / delete menu.
// The bar's overflow-x: auto (horizontal scroll) clips absolutely positioned children, so the menu
// is drawn outside the bar with position: fixed
function FolderPill({
  folder,
  selected,
  draggingSite,
  onSelect,
  onRename,
  onDelete,
}: {
  folder: FolderMeta
  selected: boolean
  draggingSite: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const sortable = useSortable({ id: `folder-${folder.id}` })
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const menuOpen = menuPos !== null
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuPos(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuPos(null)
    }
    // A fixed position does not follow scrolling, so close on scroll
    // (capture also catches the bar's own horizontal scroll)
    const onScroll = () => setMenuPos(null)
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [menuOpen])

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuPos(null)
      return
    }
    const rect = menuButtonRef.current?.getBoundingClientRect()
    if (rect) setMenuPos({ top: rect.bottom + 6, left: rect.left })
  }

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  }

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      {...sortable.attributes}
      {...sortable.listeners}
      className={`folder-pill${selected ? ' selected' : ''}${
        draggingSite && sortable.isOver ? ' drag-over' : ''
      }`}
    >
      <button type="button" className="folder-pill-label" onClick={onSelect}>
        <PillLabel icon={<Folder size={14} />} name={folder.name} count={folder.siteCount} />
      </button>
      {selected && (
        <div className="menu" ref={menuRef}>
          <button
            ref={menuButtonRef}
            type="button"
            className="folder-pill-menu"
            aria-label={`actions for folder "${folder.name}"`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={toggleMenu}
          >
            <EllipsisVertical size={13} />
          </button>
          {menuPos && (
            <div
              className="menu-list"
              role="menu"
              style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, right: 'auto' }}
            >
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setMenuPos(null)
                  onRename()
                }}
              >
                rename…
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item danger"
                onClick={() => {
                  setMenuPos(null)
                  onDelete()
                }}
              >
                delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The unfiled pill. A drop target for sites (dropping removes the site from its Folder)
function UnfiledPill({
  count,
  selected,
  draggingSite,
  onSelect,
}: {
  count: number
  selected: boolean
  draggingSite: boolean
  onSelect: () => void
}) {
  const droppable = useDroppable({ id: 'unfiled' })
  return (
    <div
      ref={droppable.setNodeRef}
      className={`folder-pill view${selected ? ' selected' : ''}${
        draggingSite && droppable.isOver ? ' drag-over' : ''
      }`}
    >
      <button type="button" className="folder-pill-label" onClick={onSelect}>
        <PillLabel icon={<Inbox size={14} />} name="unfiled" count={count} />
      </button>
    </div>
  )
}

export function FolderBar({
  folders,
  unfiledCount,
  totalCount,
  selected,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  draggingSite,
  navRef,
}: Props) {
  // If items is a new array every time, dnd-kit rebuilds its internal state at the moment of drop
  // and jumps
  const sortableIds = useMemo(() => folders.map((f) => `folder-${f.id}`), [folders])

  return (
    <nav ref={navRef} className="folder-bar" aria-label="folders">
      <div className={`folder-pill view${selected === null ? ' selected' : ''}`}>
        <button type="button" className="folder-pill-label" onClick={() => onSelect(null)}>
          <PillLabel icon={<Layers size={14} />} name="all" count={totalCount} />
        </button>
      </div>
      <UnfiledPill
        count={unfiledCount}
        selected={selected === 'unfiled'}
        draggingSite={draggingSite}
        onSelect={() => onSelect('unfiled')}
      />
      <span className="folder-divider" />
      <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
        {folders.map((f) => (
          <FolderPill
            key={f.id}
            folder={f}
            selected={selected === f.id}
            draggingSite={draggingSite}
            onSelect={() => onSelect(f.id)}
            onRename={() => onRename(f)}
            onDelete={() => onDelete(f)}
          />
        ))}
      </SortableContext>
      <button type="button" className="folder-pill add" aria-label="new folder" onClick={onCreate}>
        <Plus size={14} />
      </button>
    </nav>
  )
}

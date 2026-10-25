import { ChevronDown, ChevronRight, EllipsisVertical } from 'lucide-react'
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { encodePath } from '../../../shared/files'
import { fetchFilesBase, fetchSiteFiles } from '../api'
import { ancestorsOf, buildFileTree, type TreeDir, type TreeFile } from '../lib/file-tree'
import { isJunk } from '../lib/ingest'
import { type IncomingFile, sendPatch } from '../lib/upload'
import { useScrollLock } from '../scroll-lock'
import type { SiteFilesResponse, SiteMeta } from '../types'
import { readPayload } from './dropzone'

interface Props {
  site: SiteMeta
  onCopied: () => void
  // When a new Version is made (refetch the title and size of the card in the list)
  onChanged: () => void
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const isPage = (f: TreeFile) => f.contentType === 'text/html'

// Position of the row menu. The list clips with overflow-y: auto, so the menu is placed at the
// trigger with position: fixed rather than position: absolute (the .menu of site-card)
interface MenuPos {
  top: number | 'auto'
  bottom: number | 'auto'
  right: number
}

// Rough height of the menu. When it would reach the bottom of the viewport, it opens upward
const MENU_ESTIMATED_HEIGHT = 190

// Turn what was dropped into Paths under the Directory it was dropped on (dir, '' for the root). A
// folder goes in with its name (unlike when making a Site, the name is not stripped). Zips are not
// extracted
async function droppedFiles(dt: DataTransfer, dir: string): Promise<IncomingFile[]> {
  const payload = await readPayload(dt)
  const prefix = dir === '' ? '' : `${dir}/`
  const files = [
    ...payload.loose.map((file) => ({ path: `${prefix}${file.name}`, file })),
    ...payload.dirs.flatMap((d) =>
      d.files.map((f) => ({ path: `${prefix}${d.name}/${f.path}`, file: f.file })),
    ),
  ]
  return files.filter((f) => !isJunk(f.path))
}

// The Site's file tree dialog (ADR-004). Adding, replacing, deleting and changing the Entry all
// apply changes to the current tree and make a new Version (PATCH /api/sites/:id/tree). base is the
// Version at the time the dialog opened; if it was updated elsewhere the server refuses, so the
// list is reloaded
export function FilesDialog({ site, onCopied, onChanged, onClose }: Props) {
  const [tree, setTree] = useState<SiteFilesResponse | null>(null)
  const [filesBase, setFilesBase] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Directory highlighted as the drop target ('' is the root = the whole dialog)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ path: string; pos: MenuPos } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useScrollLock()

  const load = useCallback(async () => {
    const t = await fetchSiteFiles(site.id)
    setTree(t)
    return t
  }, [site.id])

  useEffect(() => {
    let alive = true
    Promise.all([load(), fetchFilesBase(site.id)])
      .then(([t, base]) => {
        if (!alive) return
        setFilesBase(base)
        // On open, expand the Directories down to the Entry
        setExpanded(new Set(ancestorsOf(t.entry)))
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'failed to load files')
      })
    return () => {
      alive = false
    }
  }, [load, site.id])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // With a menu open, Escape closes only the menu. The dialog does not close while sending
      if (e.key === 'Escape') {
        setMenu((m) => {
          if (m === null && busy === null) onClose()
          return null
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, busy])

  useEffect(() => {
    if (!menu) return
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [menu])

  const root = useMemo(() => (tree ? buildFileTree(tree.files) : null), [tree])

  // Send one change. Reload the list on success or failure (on 409 this shows the update made
  // elsewhere)
  const apply = useCallback(
    async (label: string, change: Parameters<typeof sendPatch>[2]) => {
      if (!tree || busy !== null) return
      setError(null)
      setBusy(label)
      try {
        await sendPatch(site.id, tree.version, change, (m) => setBusy(`${label} ${m}`))
        onChanged()
      } catch (e) {
        // On 409 (StaleTreeError), the reloaded list shows the update made elsewhere
        setError(e instanceof Error ? e.message : 'update failed')
      } finally {
        await load().catch(() => {})
        setBusy(null)
      }
    },
    [tree, busy, site.id, onChanged, load],
  )

  const addFiles = useCallback(
    (files: IncomingFile[], dir: string) => {
      if (files.length === 0) return
      // Expand the Directory dropped on to show the added files
      if (dir !== '') setExpanded((s) => new Set([...s, ...ancestorsOf(`${dir}/_`)]))
      return apply(files.length === 1 ? 'adding' : `adding ${files.length} files`, {
        put: files,
      })
    },
    [apply],
  )

  const onDragOver = (dir: string) => (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (busy === null) setDropTarget(dir)
  }
  const onDrop = (dir: string) => async (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    if (busy !== null) return
    try {
      await addFiles(await droppedFiles(e.dataTransfer, dir), dir)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to read files')
    }
  }

  const toggleMenu = (path: string, trigger: HTMLButtonElement) => {
    if (menu?.path === path) {
      setMenu(null)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const openUp = rect.bottom + MENU_ESTIMATED_HEIGHT > window.innerHeight
    setMenu({
      path,
      pos: {
        top: openUp ? 'auto' : rect.bottom + 6,
        bottom: openUp ? window.innerHeight - rect.top + 6 : 'auto',
        right: window.innerWidth - rect.right,
      },
    })
  }

  const copy = (text: string) => {
    setMenu(null)
    navigator.clipboard.writeText(text)
    onCopied()
  }

  const renderFile = (f: TreeFile, depth: number) => {
    const isEntry = f.path === tree?.entry
    return (
      <li key={f.path} className="files-item" style={{ paddingLeft: 8 + depth * 16 }}>
        <span className="files-name" title={f.path}>
          {f.name}
        </span>
        {isEntry && <span className="history-current">entry</span>}
        <span className="files-meta">{formatSize(f.size)}</span>
        <span className="files-actions">
          <button
            type="button"
            className="btn icon"
            aria-label="actions menu"
            aria-haspopup="menu"
            aria-expanded={menu?.path === f.path}
            onClick={(e) => toggleMenu(f.path, e.currentTarget)}
          >
            <EllipsisVertical size={15} />
          </button>
          {menu?.path === f.path && (
            <div
              className="menu-list"
              role="menu"
              ref={menuRef}
              style={{ position: 'fixed', ...menu.pos }}
            >
              {filesBase !== null && (
                // The root of a private site carries a token (a Page cannot be opened with the
                // admin cookie)
                <a
                  role="menuitem"
                  className="menu-item"
                  href={`${filesBase}${encodePath(f.path)}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setMenu(null)}
                >
                  open
                </a>
              )}
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title="copy the Path from the Site root"
                onClick={() => copy(f.path)}
              >
                copy path
              </button>
              {/* Canonical (ASCII) name of a legacy asset. Old HTML may refer to this name */}
              {f.canonical !== undefined && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item mono"
                  title="copy the ASCII name"
                  onClick={() => copy(f.canonical as string)}
                >
                  {f.canonical}
                </button>
              )}
              {isPage(f) && !isEntry && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setMenu(null)
                    apply('changing entry', { entry: f.path })
                  }}
                >
                  set as entry
                </button>
              )}
              {!isEntry && (
                <>
                  <hr className="menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item danger"
                    onClick={() => {
                      setMenu(null)
                      if (!confirm(`Delete "${f.path}"?`)) return
                      apply('deleting', { delete: [f.path] })
                    }}
                  >
                    delete
                  </button>
                </>
              )}
            </div>
          )}
        </span>
      </li>
    )
  }

  const renderDir = (dir: TreeDir, depth: number): ReactNode[] => [
    ...dir.dirs.flatMap((d) => {
      const open = expanded.has(d.path)
      return [
        <li
          key={`${d.path}/`}
          className={`files-dir${dropTarget === d.path ? ' over' : ''}`}
          onDragOver={onDragOver(d.path)}
          onDragLeave={() => setDropTarget(null)}
          onDrop={onDrop(d.path)}
        >
          <button
            type="button"
            className="files-dir-toggle"
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() =>
              setExpanded((s) => {
                const n = new Set(s)
                if (open) n.delete(d.path)
                else n.add(d.path)
                return n
              })
            }
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="files-name">{d.name}/</span>
            {!open && (
              <span className="files-meta">
                {d.count} {d.count === 1 ? 'file' : 'files'}
              </span>
            )}
          </button>
        </li>,
        ...(open ? renderDir(d, depth + 1) : []),
      ]
    }),
    ...dir.files.map((f) => renderFile(f, depth)),
  ]

  return (
    <div className="overlay">
      <div
        className={`dialog files${dropTarget === '' ? ' over' : ''}`}
        role="dialog"
        aria-modal="true"
        onDragOver={onDragOver('')}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null)
        }}
        onDrop={onDrop('')}
      >
        <div className="history-header">
          <h2>Files of "{site.title}"</h2>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy !== null}
            aria-label="close"
          >
            ✕
          </button>
        </div>

        <button
          type="button"
          className="files-drop"
          disabled={busy !== null || tree === null}
          onClick={() => inputRef.current?.click()}
        >
          {busy ??
            'Drop files or folders (onto a folder row to put them inside), or click to browse'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []).map((file) => ({
              path: file.name,
              file,
            }))
            e.target.value = ''
            addFiles(files, '')
          }}
        />
        <p className="dialog-note">
          Files with the same Path are replaced. Every change becomes a new version (you can go back
          from history…)
        </p>
        {error && <p className="error">{error}</p>}

        <ul className="files-list" onScroll={() => setMenu(null)}>
          {root === null && !error && <li className="dialog-note">loading…</li>}
          {root && renderDir(root, 0)}
        </ul>
      </div>
    </div>
  )
}

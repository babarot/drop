import { useEffect, useMemo, useRef, useState } from 'react'
import { encodePath } from '../../../shared/files'
import { IFRAME_SANDBOX } from '../../../shared/security'
import { fetchHistoryBase, listVersions } from '../api'
import { useScrollLock } from '../scroll-lock'
import { currentMode } from '../theme'
import type { SiteMeta, VersionMeta } from '../types'
import { type DiffCache, TreeDiffView } from './tree-diff-view'

// Minimum layout width of the preview. Matches the breakpoint (640px) of drop-defaults and the
// theming conventions: at this width the page's mobile styles apply, and the contract is that it is
// readable. Only when the frame is narrower, render at 640px and scale the whole thing down (px
// fonts that do not follow the viewport width and grids that min-content will not shrink survive
// proportional scaling)
const PREVIEW_MIN_WIDTH = 640

function ScaledPreview({ src }: { src: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setBox({ w: el.clientWidth, h: el.clientHeight })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // scale does not change the layout size, so take the iframe out of the flow with absolute
  // (in the flow, its huge unscaled height pushes the parent open and measuring and growing loop)
  const width = box ? Math.max(box.w, PREVIEW_MIN_WIDTH) : PREVIEW_MIN_WIDTH
  const scale = box ? box.w / width : 1
  return (
    <div ref={wrapRef} className="history-preview-wrap">
      {box && (
        <iframe
          className="history-preview"
          src={src}
          sandbox={IFRAME_SANDBOX}
          title="version preview"
          style={{ width, height: box.h / scale, transform: `scale(${scale})` }}
        />
      )}
    </div>
  )
}

interface Props {
  site: SiteMeta
  onRestore: (version: VersionMeta) => void
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${d.getFullYear()}/${mm}/${dd} ${hh}:${mi}`
}

export function VersionHistory({ site, onRestore, onClose }: Props) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  // The preview opens that Version's file tree under historyBase in an iframe
  const [historyBase, setHistoryBase] = useState<string | null>(null)
  const [tab, setTab] = useState<'preview' | 'diff'>('preview')
  const [error, setError] = useState<string | null>(null)
  // Trees and bodies fetched for the diff are not refetched while the dialog is open
  const diffCache = useRef<DiffCache>({ trees: new Map(), bodies: new Map() })

  useScrollLock()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    let alive = true
    Promise.all([listVersions(site.id), fetchHistoryBase(site.id)])
      .then(([res, base]) => {
        if (!alive) return
        setVersions(res.versions)
        setHistoryBase(base)
        // The main purpose is choosing where to go back to, so the initial selection is the one
        // before the current
        setSelected(res.versions[1]?.version ?? res.versions[0]?.version ?? null)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'failed to load versions')
      })
    return () => {
      alive = false
    }
  }, [site.id])

  const current = versions?.find((v) => v.current)

  const selectedMeta = versions?.find((v) => v.version === selected)
  // Same contract as the shell: only an explicit theme is passed in the Page query (none follows
  // the OS)
  const selectedPreview = useMemo(() => {
    if (historyBase === null || !selectedMeta) return undefined
    const mode = currentMode()
    const query = mode === 'auto' ? '' : `?theme=${mode}`
    return `${historyBase}${selectedMeta.version}/${encodePath(selectedMeta.entryPath)}${query}`
  }, [historyBase, selectedMeta])

  return (
    <div className="overlay">
      <div className="dialog history" role="dialog" aria-modal="true">
        <div className="history-header">
          <h2>History of "{site.title}"</h2>
          <button type="button" className="btn" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="history-body">
          <ul className="history-list">
            {versions === null && <li className="dialog-note">loading…</li>}
            {versions?.map((v, i) => {
              const older = versions[i + 1]
              const delta = older ? v.size - older.size : null
              return (
                <li key={v.version}>
                  <button
                    type="button"
                    className={`history-item${v.version === selected ? ' selected' : ''}`}
                    onClick={() => setSelected(v.version)}
                  >
                    <span className="history-item-date">
                      {formatDateTime(v.createdAt)}
                      {v.current && <span className="history-current">current</span>}
                    </span>
                    <span className="history-item-meta">
                      {formatSize(v.size)}
                      {delta != null &&
                        delta !== 0 &&
                        ` (${delta > 0 ? '+' : '-'}${formatSize(Math.abs(delta))})`}
                      {' · '}
                      {v.title}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="history-detail">
            <div className="history-tabs">
              <button
                type="button"
                className={`btn${tab === 'preview' ? ' active' : ''}`}
                onClick={() => setTab('preview')}
              >
                preview
              </button>
              <button
                type="button"
                className={`btn${tab === 'diff' ? ' active' : ''}`}
                onClick={() => setTab('diff')}
              >
                diff
              </button>
            </div>
            {tab === 'preview' &&
              (selectedPreview !== undefined ? (
                // Render isolated in an opaque origin, like Page delivery in production. key
                // recreates the iframe per Version (so the previous Version's navigation does not
                // linger)
                <ScaledPreview key={selectedPreview} src={selectedPreview} />
              ) : (
                <p className="dialog-note">loading…</p>
              ))}
            {tab === 'diff' &&
              (selectedMeta?.current ? (
                <p className="dialog-note">This is the current version</p>
              ) : current && selectedMeta ? (
                <TreeDiffView
                  siteId={site.id}
                  current={current.version}
                  selected={selectedMeta.version}
                  cache={diffCache.current}
                />
              ) : (
                <p className="dialog-note">loading…</p>
              ))}
          </div>
        </div>
        <div className="history-footer">
          <span className="dialog-note">
            restore adds the selected version's content as a new version (another restore undoes it)
          </span>
          <button
            type="button"
            className="btn"
            disabled={!selectedMeta || selectedMeta.current}
            onClick={() => selectedMeta && onRestore(selectedMeta)}
          >
            restore this version
          </button>
        </div>
      </div>
    </div>
  )
}

import { diffLines } from 'diff'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { fetchVersionFile, fetchVersionFiles } from '../api'
import { canLineDiff, compareTrees, type FileChange, isTextType } from '../lib/tree-diff'
import type { VersionFilesResponse } from '../types'

// Collapse unchanged parts of the diff, keeping only the surrounding context
const CONTEXT_LINES = 3

type DiffParts = ReturnType<typeof diffLines>

// Line diff from the current Version → the selected Version. The direction shows what restore would
// do
function DiffView({ parts }: { parts: DiffParts }) {
  if (parts.every((p) => !p.added && !p.removed)) {
    // When a legacy key and a new key hold the same content (keys cannot be compared, so it is
    // listed as changed)
    return <p className="dialog-note">This file's content is the same as in the current version</p>
  }
  // key is a running number across the whole diff (when parts changes, the whole component is
  // rebuilt)
  const out: ReactNode[] = []
  let key = 0
  const push = (lines: string[], cls: string, prefix: string) => {
    for (const line of lines) {
      key += 1
      out.push(
        <span key={key} className={cls}>
          {prefix}
          {line}
          {'\n'}
        </span>,
      )
    }
  }
  parts.forEach((part, i) => {
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (part.added) {
      push(lines, 'diff-add', '+ ')
    } else if (part.removed) {
      push(lines, 'diff-del', '- ')
    } else if (lines.length > CONTEXT_LINES * 2 + 1) {
      // Unchanged block: keep only the leading/trailing context (no context needed at the ends of
      // the whole diff)
      const head = i === 0 ? [] : lines.slice(0, CONTEXT_LINES)
      const tail = i === parts.length - 1 ? [] : lines.slice(-CONTEXT_LINES)
      const skipped = lines.length - head.length - tail.length
      push(head, 'diff-ctx', '  ')
      key += 1
      out.push(
        <span key={key} className="diff-skip">
          {`  ⋯ ${skipped} unchanged lines\n`}
        </span>,
      )
      push(tail, 'diff-ctx', '  ')
    } else {
      push(lines, 'diff-ctx', '  ')
    }
  })
  return <pre className="history-diff">{out}</pre>
}

// Fetched values kept only while viewing the history diff. The parent (VersionHistory) holds them,
// and switching Versions does not refetch them. Bodies are looked up by objectKey (the same key
// means the same content)
export interface DiffCache {
  trees: Map<number, VersionFilesResponse>
  bodies: Map<string, string>
}

interface Props {
  siteId: string
  current: number
  selected: number
  cache: DiffCache
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const MARK: Record<FileChange['status'], string> = {
  added: '+',
  removed: '-',
  changed: '~',
  same: ' ',
}

// Why no line diff is shown (when canLineDiff is false)
const noLineDiffReason = (change: FileChange): string => {
  const sides = [change.current, change.selected].filter((f) => f !== undefined)
  return sides.every((f) => isTextType(f.contentType))
    ? '\n  (over 1MB, so no line diff is shown)'
    : '\n  (not text, so no line diff is shown)'
}

// File opened first: the selected Version's Entry if it changed, otherwise the first change
const initialFocus = (changes: FileChange[], entry: string): string | null => {
  const changed = changes.filter((c) => c.status !== 'same')
  return (changed.find((c) => c.path === entry) ?? changed[0])?.path ?? null
}

// Per-file diff from the current Version → the selected Version (ADR-004). The changed files are
// listed on top, with the selected file's line diff below (only for text at or below 1MB)
export function TreeDiffView({ siteId, current, selected, cache }: Props) {
  const [trees, setTrees] = useState<[VersionFilesResponse, VersionFilesResponse] | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [bodies, setBodies] = useState<{ before: string; after: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const focusedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    setTrees(null)
    setError(null)
    const load = async (v: number) => {
      const hit = cache.trees.get(v)
      if (hit) return hit
      const tree = await fetchVersionFiles(siteId, v)
      cache.trees.set(v, tree)
      return tree
    }
    Promise.all([load(current), load(selected)])
      .then(([a, b]) => {
        if (!alive) return
        setTrees([a, b])
        setFocus(initialFocus(compareTrees(a, b).changes, b.entry))
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'failed to load files')
      })
    return () => {
      alive = false
    }
  }, [siteId, current, selected, cache])

  const comparison = useMemo(() => (trees ? compareTrees(trees[0], trees[1]) : null), [trees])
  const focused = comparison?.changes.find((c) => c.path === focus)

  useEffect(() => {
    setBodies(null)
    if (!focused || focused.status === 'same' || !canLineDiff(focused)) return
    let alive = true
    const body = async (v: number, f: FileChange['current']) => {
      if (!f) return ''
      const hit = cache.bodies.get(f.objectKey)
      if (hit !== undefined) return hit
      const text = await fetchVersionFile(siteId, v, f.path)
      cache.bodies.set(f.objectKey, text)
      return text
    }
    Promise.all([body(current, focused.current), body(selected, focused.selected)])
      .then(([before, after]) => {
        if (alive) setBodies({ before, after })
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'failed to load file')
      })
    return () => {
      alive = false
    }
  }, [focused, siteId, current, selected, cache])

  // The list has a limited height and scrolls, so bring the opened file's row into view
  useEffect(() => {
    if (focus !== null) focusedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  const parts = useMemo(() => (bodies ? diffLines(bodies.before, bodies.after) : null), [bodies])

  if (error) return <p className="error">{error}</p>
  if (!comparison) return <p className="dialog-note">loading…</p>

  const changed = comparison.changes.filter((c) => c.status !== 'same')
  const unchanged = comparison.changes.length - changed.length
  if (changed.length === 0 && !comparison.entryChanged) {
    return <p className="dialog-note">Same content as the current version</p>
  }

  return (
    <div className="tree-diff">
      {comparison.entryChanged && (
        <p className="dialog-note">
          Entry: <code>{comparison.entryChanged.from}</code> →{' '}
          <code>{comparison.entryChanged.to}</code>
        </p>
      )}
      <ul className="tree-diff-list">
        {changed.map((c) => (
          <li key={c.path}>
            <button
              ref={c.path === focus ? focusedRef : undefined}
              type="button"
              className={`tree-diff-item ${c.status}${c.path === focus ? ' selected' : ''}`}
              onClick={() => setFocus(c.path)}
            >
              <span className="tree-diff-mark">{MARK[c.status]}</span>
              <span className="tree-diff-path" title={c.path}>
                {c.path}
              </span>
            </button>
          </li>
        ))}
        {unchanged > 0 && <li className="dialog-note">{unchanged} unchanged files</li>}
      </ul>
      {focused &&
        focused.status !== 'same' &&
        (canLineDiff(focused) ? (
          parts ? (
            <DiffView parts={parts} />
          ) : (
            <p className="dialog-note">loading…</p>
          )
        ) : (
          // Files with no line diff show the size change in the same frame (so the layout does not
          // jump)
          <pre className="history-diff">
            <span className="diff-skip">
              {`  ${focused.path}: `}
              {focused.current ? formatSize(focused.current.size) : '(none)'} →{' '}
              {focused.selected ? formatSize(focused.selected.size) : '(none)'}
              {noLineDiffReason(focused)}
            </span>
          </pre>
        ))}
    </div>
  )
}

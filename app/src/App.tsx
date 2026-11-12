import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { Bubbles, Folder } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAX_PAGE_SIZE } from '../../shared/files'
import {
  createFolder,
  deleteFolder,
  deleteSite,
  fetchShareLink,
  findSitesBySourceName,
  getSite,
  listFolders,
  listSites,
  replaceSiteFile,
  restoreSite,
  updateFolder,
  updateSite,
  uploadSite,
} from './api'
import { BrandMenu } from './components/brand-menu'
import { ConflictDialog } from './components/conflict-dialog'
import { DropDock } from './components/drop-dock'
import { Dropzone } from './components/dropzone'
import { EntryDialog } from './components/entry-dialog'
import { FilesDialog } from './components/files-dialog'
import { FolderBar } from './components/folder-bar'
import { MoveDialog } from './components/move-dialog'
import { PreviewSheet } from './components/preview-sheet'
import { ReplaceMismatchDialog } from './components/replace-mismatch-dialog'
import { SelectionBar } from './components/selection-bar'
import type { SelectHow } from './components/site-card'
import { SiteList } from './components/site-list'
import { ThemeToggle } from './components/theme-toggle'
import { Toast } from './components/toast'
import { UploadQueue } from './components/upload-queue'
import { VersionHistory } from './components/version-history'
import { copyWhenReady } from './lib/clipboard'
import { siteDownload } from './lib/download'
import { type DropPayload, htmlDraft, ingest, type SiteDraft, withEntry } from './lib/ingest'
import { sendTree } from './lib/upload'
import type { FolderMeta, FolderSelection, SiteMeta, VersionMeta } from './types'
import { useMarquee } from './use-marquee'
import { invalidItem, useUploadQueue } from './use-upload-queue'

// A draft for which matching a re-drop found a same-named site. The user chooses between update and
// new
interface Conflict {
  draft: SiteDraft
  matches: SiteMeta[]
}

interface ToastState {
  message: string
  undoSiteId?: string
  // Target of the "publish and copy URL" action after a single successful upload
  publishSite?: SiteMeta
  // Generic undo, e.g. for Folder moves (separate from the restore-based undoSiteId)
  undo?: () => Promise<void>
}

// What is being dragged. Used for the DragOverlay preview and for deciding the pills' drop
// highlight. showDock is the result of checking the folder bar's visibility at drag start
// (autoScroll is off, so visibility does not change during the drag and the one-time check at start
// holds to the end). sites is the whole Selection when the drag started on a selected card, and
// only the dragged card otherwise
type DragState =
  | { type: 'site'; sites: SiteMeta[]; showDock: boolean }
  | { type: 'folder'; folder: FolderMeta }
  | null

// Top area covered by the sticky brand bar (top 24px + height ~44px).
// If the folder bar's top edge is above this, it counts as hidden and the dock is shown
const BRAND_OVERLAY_HEIGHT = 72

// Site drags use pointerWithin only: a drop counts only when released right over a pill, and
// releasing anywhere else does nothing (= cancel). Mixing in closestCenter would always make the
// nearest Folder a candidate, so releasing elsewhere could no longer cancel. Only Folder reordering
// (sortable) needs detection in the gaps between items, so it keeps the fallback
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  if (String(args.active.id).startsWith('site-')) return pointerCollisions
  if (pointerCollisions.length > 0) return pointerCollisions
  return closestCenter(args)
}

// Key for matching re-drops. Same rule as the server's sourceName derivation (parseHtmlUpload)
const sourceNameOf = (file: File) => file.name.replace(/\.html?$/i, '') || 'untitled'

// Make it usable as a download name. Spaces and the like are kept as is (changing them would break
// the sourceName match on download → re-drop, so only forbidden characters are replaced)

// Limit for titles embedded in toast text. CSS truncation (clamping from the end) would cut
// the verb part (such as "moved") first, so the variable title is cut here
const ellipsize = (s: string, max = 30) => (s.length > max ? `${s.slice(0, max)}…` : s)

export function App() {
  const [sites, setSites] = useState<SiteMeta[]>([])
  const [total, setTotal] = useState(0)
  // Not true until the first fetch finishes. Without telling "not fetched yet" from "really zero",
  // 0 sites / No sites yet flashes right after a reload
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The global upload queue (shown right below the Dropzone). The assets dialog has its own
  // instance
  const {
    items: uploads,
    uploading,
    progress,
    patch: patchUpload,
    remove: removeUpload,
    push: pushUploads,
    enqueue,
    extendBatch,
    run: runUpload,
  } = useUploadQueue()
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  // Drafts whose Entry could not be decided (several HTML files and no index.html at the root). The
  // user picks one at a time
  const [entryChoices, setEntryChoices] = useState<SiteDraft[]>([])
  // Pending confirmation when the file chosen for replace does not match the site's name (replace
  // is one at a time, so no queue)
  const [replaceConfirm, setReplaceConfirm] = useState<{ site: SiteMeta; file: File } | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [historySite, setHistorySite] = useState<SiteMeta | null>(null)
  const [previewSite, setPreviewSite] = useState<SiteMeta | null>(null)
  const [filesSite, setFilesSite] = useState<SiteMeta | null>(null)
  // Folder bar selection (null = all). It is the list's filter itself
  const [folder, setFolder] = useState<FolderSelection>(null)
  const [folders, setFolders] = useState<FolderMeta[]>([])
  const [unfiledCount, setUnfiledCount] = useState(0)
  // Target sites of the move to folder… dialog (one from a card menu, or the whole Selection)
  const [moveSites, setMoveSites] = useState<SiteMeta[] | null>(null)
  const openMove = useCallback((site: SiteMeta) => setMoveSites([site]), [])
  // The Selection (site ids). Only Sites in the list shown: it is cleared when the Folder or the
  // search changes and pruned to the list after each refresh
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  // The last card toggled, where a Shift+click range starts
  const selectionAnchor = useRef<string | null>(null)
  const [dragging, setDragging] = useState<DragState>(null)

  // Refetch the site list and the Folder list (counts) together (moves and deletes change both).
  // folder is read through the closure, so when the selection changes refresh's identity changes
  // too and the useEffect refetches
  const refresh = useCallback(
    async (q: string, f: FolderSelection = folder) => {
      try {
        const [siteRes, folderRes] = await Promise.all([listSites(q, f), listFolders()])
        setSites(siteRes.sites)
        setTotal(siteRes.total)
        setFolders(folderRes.folders)
        setUnfiledCount(folderRes.unfiledCount)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load sites')
      }
      // Set loaded on failure too (an error message is shown, so do not keep the skeleton spinning)
      setLoaded(true)
    },
    [folder],
  )

  useEffect(() => {
    refresh(query)
  }, [refresh, query])

  // Navigation from the shell (SSR bar): ?history={id} opens history, ?files={id} the files dialog
  // (also accepting ?assets= from shells left open and old links),
  // ?move={id} the move to folder dialog
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const historyId = params.get('history')
    const filesId = params.get('files') ?? params.get('assets')
    const moveId = params.get('move')
    if (!historyId && !filesId && !moveId) return
    history.replaceState(null, '', '/sites')
    const [id, open] = historyId
      ? ([historyId, setHistorySite] as const)
      : filesId
        ? ([filesId, setFilesSite] as const)
        : ([moveId as string, openMove] as const)
    getSite(id)
      .then(open)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load site'))
  }, [openMove])

  // Run one item; on success remove the entry and return the SiteMeta. On failure set the entry to
  // error and carry on. With target, this is a replace of an existing site rather than a new upload
  const runOne = useCallback(
    async (key: string, file: File, target?: SiteMeta): Promise<SiteMeta | null> => {
      // A new upload while a Folder is shown goes straight into that Folder
      const intoFolder = typeof folder === 'string' && folder !== 'unfiled' ? folder : undefined
      return runUpload(
        key,
        () => (target ? replaceSiteFile(target.id, file) : uploadSite(file, intoFolder)),
        target ? 'update failed' : 'upload failed',
      )
    },
    [runUpload, folder],
  )

  // Run one replace. The caller has already enqueued the entry. A replace is confirmed one at a
  // time from a dialog or menu, so each gets its own toast rather than an aggregate
  const runReplace = useCallback(
    async (key: string, target: SiteMeta, file: File) => {
      extendBatch(1)
      const site = await runOne(key, file, target)
      if (site) {
        await refresh(query)
        setToast({ message: `Updated "${ellipsize(site.title)}"`, undoSiteId: target.id })
      }
    },
    [extendBatch, runOne, refresh, query],
  )

  // Send a multi-file draft as one tree, making one Version in one Commit.
  // With target, replace that site's tree with this drop's content (files not in the drop are
  // gone from the new Version and stay in older Versions. ADR-004)
  const runTree = useCallback(
    async (key: string, draft: SiteDraft, target?: SiteMeta): Promise<SiteMeta | null> => {
      const intoFolder = typeof folder === 'string' && folder !== 'unfiled' ? folder : undefined
      return runUpload(
        key,
        () =>
          sendTree(
            target
              ? { siteId: target.id }
              : { create: { sourceName: draft.sourceName, folderId: intoFolder } },
            draft.entry as string,
            draft.files,
            (message) => patchUpload(key, { message }),
          ),
        target ? 'update failed' : 'upload failed',
      )
    },
    [runUpload, folder, patchUpload],
  )

  // Run one draft. A single loose HTML takes the existing route (POST /sites for new, an Entry-only
  // replace for updates, keeping the other files. Decision 1). Everything else is sent as a tree
  const runDraft = useCallback(
    (key: string, draft: SiteDraft, target?: SiteMeta): Promise<SiteMeta | null> => {
      const only = draft.files.length === 1 ? draft.files[0] : undefined
      if (only && draft.naming === 'html') {
        return runOne(key, only.file, target)
      }
      return runTree(key, draft, target)
    },
    [runOne, runTree],
  )

  // One draft = one site. With target, an update of an existing site
  const runGroup = useCallback(
    async (draft: SiteDraft, target?: SiteMeta): Promise<SiteMeta | null> => {
      const entry = draft.files.find((f) => f.path === draft.entry) ?? draft.files[0]
      const key = enqueue(entry?.file as File, target ? 'replace' : 'upload', target, draft)
      extendBatch(1)
      return runDraft(key, draft, target)
    },
    [enqueue, extendBatch, runDraft],
  )

  // Batch completion toast. For a single item, offer "publish and copy URL" (new sites are created
  // private). The asset count is not shown (failures are visible as error entries in the queue)
  const finishBatch = useCallback((succeeded: SiteMeta[]) => {
    const first = succeeded[0]
    if (succeeded.length === 1 && first) {
      setToast({
        message: `Uploaded "${ellipsize(first.title)}"`,
        publishSite: first,
      })
    } else if (succeeded.length >= 2) {
      setToast({ message: `Uploaded ${succeeded.length} sites` })
    }
  }, [])

  // Match drafts before sending. They are matched against all sites regardless of the search and
  // Folder filters, so an exact sourceName route is used instead of the list. Directories are
  // looked up by several names (SiteDraft.matchNames)
  const processDrafts = useCallback(
    async (drafts: SiteDraft[]) => {
      if (drafts.length === 0) return
      const found: Conflict[] = []
      const fresh: SiteDraft[] = []
      try {
        for (const draft of drafts) {
          const lists = await Promise.all(draft.matchNames.map(findSitesBySourceName))
          const matches = [...new Map(lists.flat().map((m) => [m.id, m])).values()]
          if (matches.length === 0) fresh.push(draft)
          else found.push({ draft, matches })
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'upload failed')
        return
      }
      if (found.length > 0) setConflicts((prev) => [...prev, ...found])
      if (fresh.length === 0) return

      // One failure does not stop the rest. Serial for simplicity, not for ordering or the like
      const succeeded: SiteMeta[] = []
      for (const draft of fresh) {
        const site = await runGroup(draft)
        if (site) succeeded.push(site)
      }
      await refresh(query)
      finishBatch(succeeded)
    },
    [refresh, query, runGroup, finishBatch],
  )

  // Taking in a drop. Ingest turns files, directories and zips into drafts per Site
  // (app/src/lib/ingest.ts). What cannot be taken in is not silently discarded but shown as an
  // error entry (not retryable). Drafts whose Entry cannot be decided are sent after choosing in
  // the selection dialog
  const handleDropPayload = useCallback(
    async (payload: DropPayload) => {
      setError(null)
      let result: Awaited<ReturnType<typeof ingest>>
      try {
        result = await ingest(payload)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to read the drop')
        return
      }
      pushUploads(result.errors.map((e) => invalidItem(e.name, e.message)))
      const pending = result.drafts.filter((d) => d.entry === null)
      if (pending.length > 0) setEntryChoices((prev) => [...prev, ...pending])
      await processDrafts(result.drafts.filter((d) => d.entry !== null))
    },
    [pushUploads, processDrafts],
  )

  const entryChoice = entryChoices[0]

  const shiftEntryChoice = useCallback(() => {
    setEntryChoices((prev) => prev.slice(1))
  }, [])

  const handleEntryChoose = useCallback(
    async (page: string) => {
      const draft = entryChoices[0]
      if (!draft) return
      shiftEntryChoice()
      await processDrafts([withEntry(draft, page)])
    },
    [entryChoices, shiftEntryChoice, processDrafts],
  )

  const handleRetryUpload = useCallback(
    async (key: string) => {
      const item = uploads.find((u) => u.key === key)
      if (!item?.file || item.state !== 'error' || !item.retryable) return
      setError(null)
      patchUpload(key, { state: 'uploading', message: undefined })
      if (item.draft) {
        extendBatch(1)
        const site = await runDraft(key, item.draft, item.target)
        if (site) {
          await refresh(query)
          if (item.target) {
            setToast({ message: `Updated "${ellipsize(site.title)}"`, undoSiteId: site.id })
          } else {
            finishBatch([site])
          }
        }
        return
      }
      if (item.kind === 'replace' && item.target) {
        await runReplace(key, item.target, item.file)
        return
      }
      extendBatch(1)
      const site = await runOne(key, item.file)
      if (site) {
        await refresh(query)
        finishBatch([site])
      }
    },
    [uploads, patchUpload, runDraft, runReplace, extendBatch, runOne, refresh, query, finishBatch],
  )

  // The toast's "publish and copy URL". An await in between expires transient activation and
  // Safari and others throw NotAllowedError, so copy synchronously first, then publish
  const handlePublishCopy = useCallback(() => {
    const site = toast?.publishSite
    if (!site) return
    void navigator.clipboard.writeText(`${location.origin}/p/${site.id}`)
    setToast(null)
    updateSite(site.id, { published: true })
      .then(async () => {
        await refresh(query)
        setToast({ message: 'Published and copied the URL' })
      })
      .catch(() => setError('Copied the URL, but publishing failed'))
  }, [toast, refresh, query])

  // Issue and copy a short-lived share link. The fetch starts right under the click without
  // awaiting, and the clipboard write is reserved before the value arrives (copyWhenReady). Calling
  // writeText after an await expires transient activation and Safari and others throw
  // NotAllowedError (the same constraint as handlePublishCopy)
  const handleShareLink = useCallback(async (site: SiteMeta) => {
    const req = fetchShareLink(site.id)
    const copied = await copyWhenReady(req.then((link) => link.url))
    const link = await req.catch(() => null)
    if (!link) {
      setError('Failed to create the share link')
      return
    }
    const until = new Date(Date.now() + link.expiresIn * 1000)
    const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`
    const minutes = Math.round(link.expiresIn / 60)
    // If the reservation did not work, ask the user to press again. Holding the issued link and
    // waiting for a second click would also work, but pressing again gets the full 10 minutes, so
    // it is not kept
    setToast({
      message: copied
        ? `Copied a link valid for ${minutes} min (until ${hhmm})`
        : 'Could not copy. Please try again',
    })
  }, [])

  const shiftConflict = useCallback(() => {
    setConflicts((prev) => prev.slice(1))
  }, [])

  const handleConflictUpdate = useCallback(
    async (target: SiteMeta) => {
      const conflict = conflicts[0]
      if (!conflict) return
      shiftConflict()
      setError(null)
      // The dialog closes as soon as a choice is made; the queue row shows the progress
      const site = await runGroup(conflict.draft, target)
      if (site) {
        await refresh(query)
        setToast({ message: `Updated "${ellipsize(site.title)}"`, undoSiteId: target.id })
      }
    },
    [conflicts, shiftConflict, runGroup, refresh, query],
  )

  const handleConflictCreateNew = useCallback(async () => {
    const conflict = conflicts[0]
    if (!conflict) return
    shiftConflict()
    setError(null)
    const site = await runGroup(conflict.draft)
    if (site) {
      await refresh(query)
      finishBatch([site])
    }
  }, [conflicts, shiftConflict, runGroup, refresh, query, finishBatch])

  const handleReplace = useCallback(
    async (site: SiteMeta, file: File) => {
      setError(null)
      // Same as the drop route: an oversized file is shown as a non-retryable error entry
      if (file.size > MAX_PAGE_SIZE) {
        pushUploads([
          invalidItem(file.name, `Exceeds ${MAX_PAGE_SIZE / 1024 / 1024}MB`, 'replace', site),
        ])
        return
      }
      // A file name mismatch is likely a mistake, so ask for confirmation. A match (correct use)
      // stays frictionless
      if (sourceNameOf(file) !== site.sourceName) {
        setReplaceConfirm({ site, file })
        return
      }
      await runReplace(enqueue(file, 'replace', site), site, file)
    },
    [enqueue, pushUploads, runReplace],
  )

  const handleMismatchUpdate = useCallback(async () => {
    if (!replaceConfirm) return
    const { site, file } = replaceConfirm
    setReplaceConfirm(null)
    await runReplace(enqueue(file, 'replace', site), site, file)
  }, [replaceConfirm, enqueue, runReplace])

  const handleMismatchCreateNew = useCallback(async () => {
    if (!replaceConfirm) return
    const { file } = replaceConfirm
    setReplaceConfirm(null)
    setError(null)
    let draft: SiteDraft
    try {
      draft = htmlDraft(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed')
      return
    }
    const site = await runGroup(draft)
    if (site) {
      await refresh(query)
      finishBatch([site])
    }
  }, [replaceConfirm, runGroup, refresh, query, finishBatch])

  const handleDownload = useCallback(async (site: SiteMeta) => {
    setError(null)
    try {
      // A multi-file Site's zip is built in the browser. It takes time, so progress is shown in a
      // toast
      const { blob, filename } = await siteDownload(site, (message) => setToast({ message }))
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      // For a zip, replace the progress toast with a completion message (a single HTML shows no
      // toast)
      if (filename.endsWith('.zip')) setToast({ message: `Downloaded ${filename}` })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'download failed')
    }
  }, [])

  // restore from the history dialog. It works by revert (adding the selected Version's content as a
  // new Version), so the toast's undo (handleUndo = restore without a version) undoes it as is
  const handleRestoreVersion = useCallback(
    async (site: SiteMeta, version: VersionMeta) => {
      setHistorySite(null)
      setError(null)
      try {
        const restored = await restoreSite(site.id, version.version)
        await refresh(query)
        const d = new Date(version.createdAt)
        const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        setToast({
          message: `Restored "${ellipsize(restored.title)}" to the version from ${stamp}`,
          undoSiteId: site.id,
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'restore failed')
      }
    },
    [refresh, query],
  )

  const handleUndo = useCallback(async () => {
    if (!toast?.undoSiteId) return
    const id = toast.undoSiteId
    setToast(null)
    setError(null)
    try {
      await restoreSite(id)
      await refresh(query)
      setToast({ message: 'Undone' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'restore failed')
    }
  }, [toast, refresh, query])

  const handleTogglePublished = useCallback(
    async (site: SiteMeta) => {
      setError(null)
      try {
        await updateSite(site.id, { published: !site.published })
        await refresh(query)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'update failed')
      }
    },
    [refresh, query],
  )

  const handleDelete = useCallback(
    async (site: SiteMeta): Promise<boolean> => {
      if (!confirm(`Delete "${site.title}"?`)) return false
      setError(null)
      try {
        await deleteSite(site.id)
        await refresh(query)
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : 'delete failed')
        return false
      }
    },
    [refresh, query],
  )

  const folderNames = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders])
  // Count for the all pill. The list's total is after the search and Folder filters, so it comes
  // from the counts
  const allCount = useMemo(
    () => folders.reduce((sum, f) => sum + f.siteCount, unfiledCount),
    [folders, unfiledCount],
  )

  // Moving sites to a Folder (shared by DnD, the move dialog and the selection bar). Runs silently +
  // undo toast. Sites already in the Folder are left out. The Selection is cleared when what moved
  // came from it (dragging a card outside the Selection keeps the Selection)
  const moveSitesToFolder = useCallback(
    async (targets: SiteMeta[], folderId: string | null) => {
      setMoveSites(null)
      setError(null)
      const moving = targets.filter((s) => s.folderId !== folderId)
      if (moving.length === 0) return
      const name = folderId === null ? 'unfiled' : (folderNames.get(folderId) ?? 'folder')
      setSelection((prev) => (moving.some((s) => prev.has(s.id)) ? new Set() : prev))
      // One PATCH per Site, in parallel. A failure of some leaves the rest moved
      const results = await Promise.allSettled(moving.map((s) => updateSite(s.id, { folderId })))
      const moved = moving.filter((_, i) => results[i]?.status === 'fulfilled')
      await refresh(query)
      if (moved.length < moving.length) {
        setError(`${moving.length - moved.length} of ${moving.length} sites could not be moved`)
      }
      if (moved.length === 0) return
      const first = moved[0] as SiteMeta
      const what = moved.length === 1 ? `"${ellipsize(first.title)}"` : `${moved.length} sites`
      const already = targets.length - moving.length
      setToast({
        message: `Moved ${what} to ${name}${already > 0 ? ` (${already} already there)` : ''}`,
        undo: async () => {
          await Promise.allSettled(moved.map((s) => updateSite(s.id, { folderId: s.folderId })))
          await refresh(query)
          setToast({ message: 'Undone' })
        },
      })
    },
    [refresh, query, folderNames],
  )

  // Selecting. Toggle flips one card; range selects every card between the last toggled one and
  // this one in the list's order (adding to the Selection, as in Finder)
  const handleSelect = useCallback(
    (site: SiteMeta, how: SelectHow) => {
      // Read the anchor now: the updater runs later, after the anchor below has moved to this card
      const anchor = selectionAnchor.current
      setSelection((prev) => {
        const next = new Set(prev)
        const ids = sites.map((s) => s.id)
        const from = anchor ? ids.indexOf(anchor) : -1
        const to = ids.indexOf(site.id)
        if (how === 'range' && from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from]
          for (const id of ids.slice(lo, hi + 1)) next.add(id)
        } else if (next.has(site.id)) {
          next.delete(site.id)
        } else {
          next.add(site.id)
        }
        return next
      })
      selectionAnchor.current = site.id
    },
    [sites],
  )

  const clearSelection = useCallback(() => {
    setSelection((prev) => (prev.size === 0 ? prev : new Set()))
  }, [])

  // The Selection covers only the list shown, so a new Folder or search starts it over
  // biome-ignore lint/correctness/useExhaustiveDependencies: folder and query are the triggers
  useEffect(() => {
    clearSelection()
  }, [folder, query, clearSelection])

  // Drop ids that left the list (deleted, or moved out of the Folder shown)
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev
      const ids = new Set(sites.map((s) => s.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [sites])

  const selectedSites = useMemo(() => sites.filter((s) => selection.has(s.id)), [sites, selection])

  const handleCreateFolder = useCallback(async () => {
    const name = prompt('New folder name')?.trim()
    if (!name) return
    setError(null)
    try {
      const created = await createFolder(name)
      await refresh(query)
      setToast({ message: `Created folder "${created.name}"` })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed')
    }
  }, [refresh, query])

  const handleRenameFolder = useCallback(
    async (target: FolderMeta) => {
      const name = prompt('Folder name', target.name)?.trim()
      if (!name || name === target.name) return
      setError(null)
      try {
        await updateFolder(target.id, { name })
        await refresh(query)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'rename failed')
      }
    },
    [refresh, query],
  )

  const handleDeleteFolder = useCallback(
    async (target: FolderMeta) => {
      const suffix =
        target.siteCount > 0 ? ` Its ${target.siteCount} sites go back to unfiled.` : ''
      if (!confirm(`Delete folder "${target.name}"?${suffix}`)) return
      setError(null)
      try {
        await deleteFolder(target.id)
        // If the selected Folder was deleted, go to all (setFolder triggers refresh)
        if (folder === target.id) setFolder(null)
        else await refresh(query)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'delete failed')
      }
    },
    [folder, refresh, query],
  )

  // DnD. Mouse starts after moving 8px (to tell from a click), touch after a 200ms long press (to
  // tell from scrolling)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  // Whether the whole folder bar is visible (not hidden by the brand bar).
  // If it is, no dock is shown (the same targets appearing twice would be confusing)
  const folderBarRef = useRef<HTMLElement>(null)
  const isFolderBarVisible = useCallback(() => {
    const el = folderBarRef.current
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return rect.top >= BRAND_OVERLAY_HEIGHT && rect.bottom <= window.innerHeight
  }, [])

  // What a drag of this card carries: the whole Selection (in the list's order) when the card is
  // in it, and only the card otherwise. The Selection cannot change during a drag, so the start
  // and the end agree
  const carriedBy = useCallback(
    (site: SiteMeta) => (selection.has(site.id) ? selectedSites : [site]),
    [selection, selectedSites],
  )

  const handleDragStart = useCallback(
    (e: DragStartEvent) => {
      const id = String(e.active.id)
      if (id.startsWith('site-')) {
        const site = sites.find((p) => p.id === id.slice(5))
        if (!site) return
        setDragging({ type: 'site', sites: carriedBy(site), showDock: !isFolderBarVisible() })
      } else if (id.startsWith('folder-')) {
        const f = folders.find((x) => x.id === id.slice(7))
        if (f) setDragging({ type: 'folder', folder: f })
      }
    },
    [sites, folders, carriedBy, isFolderBarVisible],
  )

  // Use the active.id prefix to tell a site move from a Folder reorder
  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setDragging(null)
      const activeId = String(e.active.id)
      // DropDock pills are registered with a dock- prefix to avoid registering the same ids as the
      // folder bar, so strip it here to normalize them to the same handling
      const rawOverId = e.over ? String(e.over.id) : null
      const overId = rawOverId?.startsWith('dock-') ? rawOverId.slice(5) : rawOverId
      if (!overId) return

      if (activeId.startsWith('site-')) {
        const site = sites.find((p) => p.id === activeId.slice(5))
        if (!site) return
        const target =
          overId === 'unfiled' ? null : overId.startsWith('folder-') ? overId.slice(7) : undefined
        if (target === undefined) return
        void moveSitesToFolder(carriedBy(site), target)
        return
      }

      if (activeId.startsWith('folder-') && overId.startsWith('folder-') && activeId !== overId) {
        const from = folders.findIndex((f) => `folder-${f.id}` === activeId)
        const to = folders.findIndex((f) => `folder-${f.id}` === overId)
        if (from < 0 || to < 0) return
        // Update locally and optimistically, and persist only the rows whose position changed,
        // fire-and-forget (a failure is corrected by the next refresh)
        const next = arrayMove(folders, from, to).map((f, i) => ({ ...f, position: i }))
        const prevPos = new Map(folders.map((f) => [f.id, f.position]))
        setFolders(next)
        for (const f of next) {
          if (prevPos.get(f.id) !== f.position) {
            updateFolder(f.id, { position: f.position }).catch(() => {})
          }
        }
      }
    },
    [sites, folders, carriedBy, moveSitesToFolder],
  )

  const conflict = conflicts[0]
  // While an overlay is shown, take the background out of focus and interaction (making aria-modal
  // effective)
  const overlayOpen = Boolean(
    previewSite ||
      historySite ||
      filesSite ||
      conflict ||
      entryChoice ||
      replaceConfirm ||
      moveSites,
  )

  // Esc clears the Selection and ⌘A / Ctrl+A selects every Site in the list, unless typing in a
  // field or an overlay is open (the overlays handle their own keys)
  useEffect(() => {
    if (overlayOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'Escape') clearSelection()
      if (e.key === 'a' && (e.metaKey || e.ctrlKey) && sites.length > 0) {
        e.preventDefault()
        setSelection(new Set(sites.map((s) => s.id)))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [overlayOpen, sites, clearSelection])

  const marquee = useMarquee({
    enabled: !overlayOpen && dragging === null,
    selection,
    onSelect: useCallback((ids: Set<string>) => {
      setSelection((prev) =>
        prev.size === ids.size && [...ids].every((id) => prev.has(id)) ? prev : ids,
      )
    }, []),
  })
  const draggingIds = useMemo(
    () => (dragging?.type === 'site' ? new Set(dragging.sites.map((s) => s.id)) : undefined),
    [dragging],
  )
  // The toast's undo: the generic undo (Folder move) takes priority, otherwise the restore-based
  // one
  const toastUndoFn = toast?.undo
  const toastUndo = toastUndoFn
    ? () => {
        setToast(null)
        void toastUndoFn()
      }
    : toast?.undoSiteId
      ? handleUndo
      : undefined

  return (
    <div className="container">
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragging(null)}
        // The DropDock (fixed) always puts drop targets within reach during a drag,
        // so auto-scrolling during a drag is unnecessary. dnd-kit's scroll correction is known to
        // shift the rects of fixed elements, so scrolling is not allowed to happen at all
        autoScroll={false}
      >
        <div inert={overlayOpen}>
          <div className="brand glass">
            <h1 aria-label="drop" title="drop">
              <Bubbles size={20} />
            </h1>
            {loaded && <span className="count">{total} sites</span>}
            <ThemeToggle />
            <BrandMenu onCopied={() => setToast({ message: 'Copied the prompt' })} />
          </div>

          <Dropzone onDrop={handleDropPayload} uploading={uploading} />
          <UploadQueue
            items={uploads}
            progress={progress}
            onRetry={handleRetryUpload}
            onRemove={removeUpload}
          />
          {error && <p className="error">{error}</p>}

          <div className="search">
            <input
              type="search"
              placeholder="search title..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <FolderBar
            navRef={folderBarRef}
            folders={folders}
            unfiledCount={unfiledCount}
            totalCount={allCount}
            selected={folder}
            onSelect={setFolder}
            onCreate={handleCreateFolder}
            onRename={handleRenameFolder}
            onDelete={handleDeleteFolder}
            draggingSite={dragging?.type === 'site'}
          />

          <SiteList
            sites={sites}
            loading={!loaded}
            folderNames={folder === null ? folderNames : undefined}
            selection={selection}
            draggingIds={draggingIds}
            onSelect={handleSelect}
            onPreview={setPreviewSite}
            onCopied={() => setToast({ message: 'Copied the URL' })}
            onShareLink={handleShareLink}
            onTogglePublished={handleTogglePublished}
            onDelete={handleDelete}
            onReplace={handleReplace}
            onDownload={handleDownload}
            onHistory={setHistorySite}
            onFiles={setFilesSite}
            onMove={openMove}
          />
        </div>

        {/* While a site is dragged, show the drop-target dock at the bottom only when the folder
            bar is off screen (if the bar is visible, drop onto it; showing both would confuse) */}
        {dragging?.type === 'site' && dragging.showDock && (
          <DropDock folders={folders} unfiledCount={unfiledCount} />
        )}

        {/* Preview while dragging. The real element is dimmed, and this one follows the cursor.
            Several sites show as a stack with their count */}
        <DragOverlay dropAnimation={null}>
          {dragging?.type === 'site' ? (
            dragging.sites.length > 1 ? (
              <div className="drag-stack">
                <span className="drag-stack-ghost" />
                <div className="drag-preview">
                  {ellipsize(dragging.sites[0]?.title ?? '', 24)} +{dragging.sites.length - 1}
                </div>
                <span className="drag-count">{dragging.sites.length}</span>
              </div>
            ) : (
              <div className="drag-preview">{dragging.sites[0]?.title}</div>
            )
          ) : dragging?.type === 'folder' ? (
            <div className="folder-pill selected drag-preview-pill">
              <Folder size={14} />
              <span className="folder-pill-name">{dragging.folder.name}</span>
              <span className="n">{dragging.folder.siteCount}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {previewSite && (
        <PreviewSheet
          site={previewSite}
          onCopied={() => setToast({ message: 'Copied the URL' })}
          onShareLink={handleShareLink}
          onClose={() => setPreviewSite(null)}
          onTogglePublished={(p) => {
            void handleTogglePublished(p)
            setPreviewSite((prev) =>
              prev && prev.id === p.id ? { ...prev, published: !prev.published } : prev,
            )
          }}
          onDelete={(p) => {
            void handleDelete(p).then((deleted) => {
              if (deleted) setPreviewSite(null)
            })
          }}
          onReplace={handleReplace}
          onDownload={handleDownload}
          onHistory={setHistorySite}
          onFiles={setFilesSite}
          onMove={openMove}
        />
      )}

      {historySite && (
        <VersionHistory
          site={historySite}
          onRestore={(v) => handleRestoreVersion(historySite, v)}
          onClose={() => setHistorySite(null)}
        />
      )}

      {filesSite && (
        <FilesDialog
          site={filesSite}
          onCopied={() => setToast({ message: 'Copied the path' })}
          onChanged={() => refresh(query)}
          onClose={() => setFilesSite(null)}
        />
      )}

      {!conflict && entryChoice && (
        <EntryDialog
          name={entryChoice.label}
          pages={entryChoice.pages}
          onChoose={handleEntryChoose}
          onCancel={shiftEntryChoice}
        />
      )}
      {conflict && (
        <ConflictDialog
          name={conflict.draft.sourceName}
          replacesTree={!(conflict.draft.naming === 'html' && conflict.draft.files.length === 1)}
          fileCount={conflict.draft.files.length}
          matches={conflict.matches}
          folderNames={folderNames}
          onUpdate={handleConflictUpdate}
          onCreateNew={handleConflictCreateNew}
          onCancel={shiftConflict}
        />
      )}

      {moveSites && (
        <MoveDialog
          sites={moveSites}
          folders={folders}
          unfiledCount={unfiledCount}
          onMove={(folderId) => void moveSitesToFolder(moveSites, folderId)}
          onCancel={() => setMoveSites(null)}
        />
      )}

      {marquee && (
        <div
          className="marquee"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}

      {replaceConfirm && (
        <ReplaceMismatchDialog
          file={replaceConfirm.file}
          site={replaceConfirm.site}
          onUpdate={handleMismatchUpdate}
          onCreateNew={handleMismatchCreateNew}
          onCancel={() => setReplaceConfirm(null)}
        />
      )}

      {/* Shares the toast's spot, so it steps aside while a toast is shown (a move clears the
          Selection and shows its toast) and during a drag (the dock is there) */}
      {selection.size > 0 && !toast && !dragging && !overlayOpen && (
        <SelectionBar
          count={selection.size}
          onMove={() => setMoveSites(selectedSites)}
          onClear={clearSelection}
        />
      )}

      {toast && (
        <Toast
          message={toast.message}
          action={
            toast.publishSite
              ? { label: 'publish & copy url', onClick: handlePublishCopy }
              : undefined
          }
          onUndo={toastUndo}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  )
}

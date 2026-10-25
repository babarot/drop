import { type DragEvent, useRef, useState } from 'react'
import type { DropPayload, DroppedDir } from '../lib/ingest'
import type { IncomingFile } from '../lib/upload'

// This only reads what was dropped; assembling it into Sites (which make up one Site, which is the
// Entry) is done by Ingest (app/src/lib/ingest.ts). This is a thin wrapper over the browser-only
// API (webkitGetAsEntry)

interface Props {
  onDrop: (payload: DropPayload) => void
  uploading: boolean
}

// Promisify the callback API of FileSystemFileEntry.file()
function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

// readEntries is not guaranteed to return everything at once (Chrome returns 100 at a time), so
// loop until empty
async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

// Read a directory recursively. path is relative to inside the dropped directory
async function readTree(dir: FileSystemDirectoryEntry, prefix: string, out: IncomingFile[]) {
  for (const e of await readAllEntries(dir)) {
    if (e.isDirectory) {
      await readTree(e as FileSystemDirectoryEntry, `${prefix}${e.name}/`, out)
    } else if (e.isFile) {
      out.push({ path: `${prefix}${e.name}`, file: await entryFile(e as FileSystemFileEntry) })
    }
  }
}

async function readDir(entry: FileSystemDirectoryEntry): Promise<DroppedDir> {
  const files: IncomingFile[] = []
  await readTree(entry, '', files)
  return { name: entry.name, files }
}

// Extract a DataTransfer along with its directory structure. Where webkitGetAsEntry is unavailable,
// fall back to dt.files (directory contents cannot be read, so loose files only)
export async function readPayload(dt: DataTransfer): Promise<DropPayload> {
  // DataTransferItem is invalidated once an await intervenes, so take every entry and File
  // synchronously first
  const picked = Array.from(dt.items ?? []).map((item) => ({
    entry: item.webkitGetAsEntry?.() ?? null,
    file: item.getAsFile?.() ?? null,
  }))
  if (picked.every((p) => p.entry === null)) {
    return { loose: Array.from(dt.files ?? []), dirs: [] }
  }

  const loose: File[] = []
  const dirs: DroppedDir[] = []
  for (const { entry, file } of picked) {
    if (entry?.isDirectory) {
      dirs.push(await readDir(entry as FileSystemDirectoryEntry))
    } else if (file) {
      loose.push(file)
    }
  }
  return { loose, dirs }
}

export function Dropzone({ onDrop, uploading }: Props) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void readPayload(e.dataTransfer).then((payload) => {
      if (payload.loose.length > 0 || payload.dirs.length > 0) onDrop(payload)
    })
  }

  return (
    <button
      type="button"
      className={`dropzone${over ? ' over' : ''}`}
      aria-busy={uploading}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <span className="icon">⬇</span>
      {uploading
        ? 'uploading...'
        : 'Drop your HTML (with assets), a folder or a zip, or click to browse'}
      {/* No extension filter (archives routinely hold files outside the allowlist. Decision 3) */}
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length > 0) onDrop({ loose: files, dirs: [] })
        }}
      />
    </button>
  )
}

import type { SiteMeta } from '../types'
import { type SelectHow, SiteCard } from './site-card'

interface Props {
  sites: SiteMeta[]
  // First fetch in progress. Show a skeleton, distinct from the empty state (No sites yet)
  loading?: boolean
  // Lookup for showing each card's Folder name in the all-sites view (not shown if undefined)
  folderNames?: Map<string, string>
  selection: Set<string>
  // Sites carried by the drag in progress (dimmed, like the card being dragged)
  draggingIds?: Set<string>
  onSelect: (site: SiteMeta, how: SelectHow) => void
  onPreview: (site: SiteMeta) => void
  onCopied: () => void
  onShareLink: (site: SiteMeta) => void
  onTogglePublished: (site: SiteMeta) => void
  onDelete: (site: SiteMeta) => void
  onReplace: (site: SiteMeta, file: File) => void
  onDownload: (site: SiteMeta) => void
  onHistory: (site: SiteMeta) => void
  onFiles: (site: SiteMeta) => void
  onMove: (site: SiteMeta) => void
}

export function SiteList({
  sites,
  loading,
  folderNames,
  selection,
  draggingIds,
  onSelect,
  onPreview,
  onCopied,
  onShareLink,
  onTogglePublished,
  onDelete,
  onReplace,
  onDownload,
  onHistory,
  onFiles,
  onMove,
}: Props) {
  if (loading) {
    return (
      <div className="grid" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card skeleton">
            <div className="skeleton-line skeleton-title" />
            <div className="skeleton-line skeleton-meta" />
            <div className="skeleton-line skeleton-actions" />
          </div>
        ))}
      </div>
    )
  }
  if (sites.length === 0) {
    return <p className="empty">No sites yet. Drop an HTML file above.</p>
  }
  return (
    <div className={`grid${selection.size > 0 ? ' selecting' : ''}`}>
      {sites.map((site) => (
        <SiteCard
          key={site.id}
          site={site}
          selected={selection.has(site.id)}
          selecting={selection.size > 0}
          dimmed={draggingIds?.has(site.id) ?? false}
          onSelect={onSelect}
          folderName={site.folderId !== null ? folderNames?.get(site.folderId) : undefined}
          onPreview={onPreview}
          onCopied={onCopied}
          onShareLink={onShareLink}
          onTogglePublished={onTogglePublished}
          onDelete={onDelete}
          onReplace={onReplace}
          onDownload={onDownload}
          onHistory={onHistory}
          onFiles={onFiles}
          onMove={onMove}
        />
      ))}
    </div>
  )
}

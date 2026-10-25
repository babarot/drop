// The part of drop's admin API (/api) used for sync. Same endpoints as the admin UI
// (src/routes/api.ts)

import { encodePath } from '../shared/files'
import type { SiteFilesResponse, SiteListResponse, SiteMeta } from '../src/types'

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface TreeFile {
  path: string
  sha256: string
  size: number
}

export interface PutTreeBody {
  entry: string
  files: TreeFile[]
  base?: number
  create?: { sourceName: string }
}

// Result of PUT /tree. conflict: base was not the latest (409); gone: the Site does not exist (404)
export type PutTreeResult =
  | { kind: 'ok'; site: SiteMeta; version: number }
  | { kind: 'conflict' }
  | { kind: 'gone' }

export class DropClient {
  private readonly fetchImpl: Fetch

  constructor(
    readonly remote: string,
    private readonly headers: Record<string, string> = {},
    fetchImpl?: Fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.remote}/api${path}`, {
      ...init,
      // Do not follow the redirect to the Access login page; report missing credentials instead
      redirect: 'manual',
      headers: { 'X-Drop-Request': '1', ...this.headers, ...init.headers },
    })
    if (res.status >= 300 && res.status < 400) {
      throw new ApiError(res.status, 'could not sign in to drop; set credentials with drop login')
    }
    return res
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init)
    if (!res.ok) throw new ApiError(res.status, await errorOf(res))
    return (await res.json()) as T
  }

  // Every Site on drop. The list returns at most 100 per request, so page through it
  async allSites(): Promise<SiteMeta[]> {
    const sites: SiteMeta[] = []
    for (let offset = 0; ; offset += 100) {
      const q = new URLSearchParams({ limit: '100', offset: String(offset) })
      const page = await this.json<SiteListResponse>(`/sites?${q}`)
      sites.push(...page.sites)
      if (page.sites.length < 100 || sites.length >= page.total) return sites
    }
  }

  // The tree of the current Version (version, Entry, file list). null if the Site does not exist
  async currentTree(siteId: string): Promise<SiteFilesResponse | null> {
    const res = await this.request(`/sites/${siteId}/files`)
    if (res.status === 404) return null
    if (!res.ok) throw new ApiError(res.status, await errorOf(res))
    return (await res.json()) as SiteFilesResponse
  }

  // The original bytes of one File in a Version
  async fileBytes(siteId: string, version: number, path: string): Promise<Uint8Array> {
    const res = await this.request(`/sites/${siteId}/versions/${version}/files/${encodePath(path)}`)
    if (!res.ok) throw new ApiError(res.status, await errorOf(res))
    return new Uint8Array(await res.arrayBuffer())
  }

  // Sites whose sourceName matches exactly (same endpoint as re-drop matching)
  async sitesBySourceName(sourceName: string): Promise<SiteMeta[]> {
    const q = new URLSearchParams({ sourceName, limit: '100' })
    return (await this.json<{ sites: SiteMeta[] }>(`/sites?${q}`)).sites
  }

  async missing(siteId: string, hashes: string[]): Promise<string[]> {
    if (hashes.length === 0) return []
    const res = await this.json<{ missing: string[] }>(`/sites/${siteId}/objects/missing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256: hashes }),
    })
    return res.missing
  }

  async putObject(siteId: string, sha256: string, body: Blob): Promise<void> {
    const res = await this.request(`/sites/${siteId}/objects/${sha256}`, {
      method: 'PUT',
      body,
    })
    if (!res.ok) throw new ApiError(res.status, await errorOf(res))
  }

  async putTree(siteId: string, body: PutTreeBody): Promise<PutTreeResult> {
    const res = await this.request(`/sites/${siteId}/tree`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 409 && body.create === undefined) return { kind: 'conflict' }
    if (res.status === 404) return { kind: 'gone' }
    if (!res.ok) throw new ApiError(res.status, await errorOf(res))
    const site = (await res.json()) as SiteMeta
    if (site.version === undefined) throw new ApiError(res.status, 'missing version')
    return { kind: 'ok', site, version: site.version }
  }
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `HTTP ${res.status}`
}

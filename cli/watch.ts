// drop watch: watch the sync directory and push changed folders automatically.
// Change events are only a hint for which folder to recheck; it always rescans before committing
// (events can be missed). A periodic full scan picks up anything missed

import { watch } from 'node:fs'
import { type PushOutcome, pushAll, pushSite, type SyncContext } from './push'

// Push a folder once it has been quiet this long since its last change (AI writes dozens of files
// in a row)
export const QUIET_MS = 3000
export const RESCAN_MS = 5 * 60 * 1000

export function startWatch(
  ctx: SyncContext,
  opts: { quietMs?: number; rescanMs?: number } = {},
): { stop(): void; settled(): Promise<void> } {
  const quietMs = opts.quietMs ?? QUIET_MS
  const timers = new Map<string, Timer>()
  // One at a time per folder. Changes that arrive while running trigger another run afterwards
  const running = new Map<string, Promise<PushOutcome | undefined>>()
  const again = new Set<string>()

  const run = (dirName: string) => {
    if (running.has(dirName)) {
      again.add(dirName)
      return
    }
    const p = pushSite(ctx, dirName)
      .catch((e) => {
        ctx.notify.warn(
          `dir:${dirName}`,
          `${dirName}: ${e instanceof Error ? e.message : String(e)}`,
        )
        return undefined
      })
      .finally(() => {
        running.delete(dirName)
        if (again.delete(dirName)) schedule(dirName)
      })
    running.set(dirName, p)
  }

  const schedule = (dirName: string) => {
    clearTimeout(timers.get(dirName))
    timers.set(
      dirName,
      setTimeout(() => {
        timers.delete(dirName)
        run(dirName)
      }, quietMs),
    )
  }

  const watcher = watch(ctx.dir, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const top = filename.toString().split(/[/\\]/)[0]
    if (top && !top.startsWith('.')) schedule(top)
  })
  const rescan = setInterval(() => void pushAll(ctx), opts.rescanMs ?? RESCAN_MS)

  return {
    stop() {
      watcher.close()
      clearInterval(rescan)
      for (const t of timers.values()) clearTimeout(t)
    },
    async settled() {
      while (running.size > 0) await Promise.all(running.values())
    },
  }
}

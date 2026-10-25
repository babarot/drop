// Notices: a log (stderr) and, on macOS, Notification Center. The same notice is not repeated until
// the state changes

import type { State } from './state'

export interface Notifier {
  // One notice per key (a Site id or a folder name)
  warn(key: string, message: string): void
  clear(key: string): void
  info(message: string): void
}

const stamp = () => new Date().toISOString().slice(11, 19)

export function notifier(state: State, opts: { desktop: boolean }): Notifier {
  return {
    warn(key, message) {
      if (!state.recordNotice(key, message)) return
      console.error(`${stamp()} ! ${message}`)
      if (opts.desktop && process.platform === 'darwin') {
        // Strip quotes and backslashes since it goes into an osascript string
        const text = message.replace(/["\\]/g, '')
        Bun.spawn(['osascript', '-e', `display notification "${text}" with title "drop"`], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
      }
    },
    clear(key) {
      state.clearNotice(key)
    },
    info(message) {
      console.error(`${stamp()}   ${message}`)
    },
  }
}

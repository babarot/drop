// Browser-only theme handling. Without an explicit setting (light/dark) in localStorage,
// treat it as auto and follow the OS prefers-color-scheme
export type Theme = 'light' | 'dark'
export type ThemeMode = Theme | 'auto'

const STORAGE_KEY = 'drop-theme'
const CYCLE: ThemeMode[] = ['auto', 'light', 'dark']

export function currentMode(): ThemeMode {
  try {
    const t = localStorage.getItem(STORAGE_KEY)
    if (t === 'light' || t === 'dark') return t
  } catch {
    // Always auto where localStorage is unavailable
  }
  return 'auto'
}

export function applyMode(mode: ThemeMode): void {
  if (mode === 'auto') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = mode
  }
  try {
    if (mode === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // The switch still takes effect even if it cannot be saved
  }
}

// Cycles auto → light → dark → auto
export function cycleMode(): ThemeMode {
  const next = CYCLE[(CYCLE.indexOf(currentMode()) + 1) % CYCLE.length] ?? 'auto'
  applyMode(next)
  return next
}

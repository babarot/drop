import { Moon, Sun, SunMoon } from 'lucide-react'
import { useState } from 'react'
import type { ThemeMode } from '../theme'
import { currentMode, cycleMode } from '../theme'

const LABELS: Record<ThemeMode, string> = {
  auto: 'theme: auto (follows OS)',
  light: 'theme: light',
  dark: 'theme: dark',
}

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => currentMode())
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={LABELS[mode]}
      title={LABELS[mode]}
      onClick={() => setMode(cycleMode())}
    >
      {mode === 'auto' ? (
        <SunMoon size={15} />
      ) : mode === 'light' ? (
        <Sun size={15} />
      ) : (
        <Moon size={15} />
      )}
    </button>
  )
}

// Light/dark theme tokens and the glass effect utility (the same pattern as img).
// Used by the Worker (shell SSR), the admin UI (injected into index.html by a vite plugin) and the
// delivery-time injection into uploaded HTML (src/lib/rewrite.ts).
// This map is the single source of the values; a change here reaches every consumer

const tokens = {
  bg: { light: '#f7f7f8', dark: '#0c0d10' },
  'bg-elevated': { light: '#ffffff', dark: '#16181d' },
  'bg-hover': { light: '#f0f0f2', dark: '#1c1f26' },
  text: { light: '#17181c', dark: '#e9eaee' },
  'text-muted': { light: '#6b7280', dark: '#9aa0ab' },
  border: { light: '#e4e5e9', dark: '#26282f' },
  'border-strong': { light: '#cfd1d6', dark: '#3a3d46' },
  accent: { light: '#16a34a', dark: '#4ade80' },
  'accent-glow': { light: 'rgba(22, 163, 74, 0.18)', dark: 'rgba(74, 222, 128, 0.2)' },
  danger: { light: '#b91c1c', dark: '#f0a0a0' },
  'danger-border': { light: '#e5b8b8', dark: '#6a3a3a' },
  'danger-bg': { light: '#fdf1f1', dark: '#2a1a1a' },
  overlay: { light: 'rgba(0, 0, 0, 0.35)', dark: 'rgba(0, 0, 0, 0.55)' },
  'glass-bg': { light: 'rgba(255, 255, 255, 0.6)', dark: 'rgba(20, 22, 27, 0.55)' },
  'glass-border': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.1)' },
  'glass-highlight': { light: 'rgba(255, 255, 255, 0.8)', dark: 'rgba(255, 255, 255, 0.12)' },
  'glass-shadow': { light: '0 4px 24px rgba(0, 0, 0, 0.1)', dark: '0 4px 24px rgba(0, 0, 0, 0.5)' },
  ring: { light: 'rgba(23, 24, 28, 0.45)', dark: 'rgba(233, 234, 238, 0.55)' },
  'ring-soft': { light: 'rgba(23, 24, 28, 0.1)', dark: 'rgba(233, 234, 238, 0.12)' },
} as const

type TokenName = keyof typeof tokens
type Mode = 'light' | 'dark'

function declarations(names: readonly TokenName[], mode: Mode, prefix = ''): string {
  return names.map((n) => `  --${prefix}${n}: ${tokens[n][mode]};`).join('\n')
}

const ALL_TOKENS = Object.keys(tokens) as TokenName[]

// The full dark set. The same values go into both the explicit setting ([data-theme='dark']) and
// the OS setting (prefers-color-scheme). color-scheme is not a token but part of the theme
// definition, so it is set here (it is not part of the token injection in rewrite.ts, which is
// governed by a separate safety condition: unstyled HTML only)
const darkBlock = `  color-scheme: dark;\n${declarations(ALL_TOKENS, 'dark')}`

export const themeCss = `
:root {
  color-scheme: light;
${declarations(ALL_TOKENS, 'light')}
}

[data-theme='dark'] {
${darkBlock}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${darkBlock}
  }
}

/* Match the keyboard focus ring to the theme (it does not show on mouse clicks) */
:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.glass {
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(16px) saturate(1.5);
  backdrop-filter: blur(16px) saturate(1.5);
  border: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 var(--glass-highlight), var(--glass-shadow);
}
`

// The minimal set of variables exposed to uploaded HTML. A name, once exposed, is effectively an
// API and hard to remove, so tokens internal to the shell (glass-*, ring-* and so on) are not
// exposed.
// Convention: docs/theming.md
const PUBLIC_TOKENS = [
  'bg',
  'bg-elevated',
  'text',
  'text-muted',
  'border',
  'accent',
  'danger',
] as const satisfies readonly TokenName[]

// CSS for the --drop-* variables injected at delivery time. Variables do nothing unless
// referenced, so they can always be injected into every page (opting in is up to the page that
// references them).
// Two modes: fixed values without a media query when theme is fixed, following the OS when unset
export function dropTokensCss(theme: Mode | null): string {
  if (theme) {
    return `:root {\n${declarations(PUBLIC_TOKENS, theme, 'drop-')}\n}`
  }
  return `:root {
${declarations(PUBLIC_TOKENS, 'light', 'drop-')}
}
@media (prefers-color-scheme: dark) {
  :root {
${declarations(PUBLIC_TOKENS, 'dark', 'drop-')}
  }
}`
}

// Apply the explicit setting from localStorage before rendering to prevent FOUC. Placed inline at
// the start of <head>
export const themeInitScript = `(function () {
  try {
    var t = localStorage.getItem('drop-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {}
})();`

// The favicon (shared/favicon.ts) cannot use CSS variables and needs hex values directly.
// Rather than copying the theme values, it takes them from here
export const accentHex = { light: tokens.accent.light, dark: tokens.accent.dark } as const

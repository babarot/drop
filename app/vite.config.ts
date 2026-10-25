import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { faviconHref, faviconLocalScript } from '../shared/favicon'
import { siteMenuPillCss } from '../shared/site-menu'
import { themeCss, themeInitScript } from '../shared/theme'

// Inject the theme tokens, the FOUC-prevention script and the favicon into index.html at build
// time (same pattern as img). The script goes at the top of head so data-theme is applied before
// the first paint. The pill (action menu item) styles are injected the same way and share a single
// source with views/shell.tsx (SSR) to prevent drift. The favicon likewise has shared/favicon.ts as
// its single source; the localhost swap script needs to grab the link, so it goes after the link
function injectTheme(): Plugin {
  return {
    name: 'inject-theme',
    transformIndexHtml() {
      return [
        { tag: 'script', children: themeInitScript, injectTo: 'head-prepend' },
        { tag: 'style', children: themeCss, injectTo: 'head' },
        { tag: 'style', children: siteMenuPillCss, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'icon', href: faviconHref }, injectTo: 'head' },
        { tag: 'script', children: faviconLocalScript, injectTo: 'head' },
      ]
    },
  }
}

// Setting base to /sites/ and writing the output to app/dist/sites makes
// the URL path match the directory layout (same pattern as img).
// wrangler's assets.directory is app/dist
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  base: '/sites/',
  plugins: [react(), injectTheme()],
  build: {
    outDir: 'dist/sites',
    emptyOutDir: true,
  },
})

// The icon shown in the tab. It is lucide Bubbles, the same as the header logo (<h1> in
// app/src/App.tsx), so the logo on screen and the tab artwork match. As in money / numi, there is
// no file: the SVG is self-contained in a data URI (adding nothing to public/ or the build config).
// Used in three places: the admin SPA (injected by app/vite.config.ts), the shell (SSR) and
// the 404.
// Copying the data URI into three places would drift, so this is the single source (the same
// reason as ADR-001)
import { accentHex } from './theme'

// Copied verbatim from bubbles in lucide-react v1.33. SSR runs on the Worker, so it cannot import
// lucide-react, which depends on React, and the paths have to be kept as strings.
// When changing the icon, change <Bubbles /> in the header at the same time
const BUBBLES =
  "<path d='M7.001 15.085A1.5 1.5 0 0 1 9 16.5'/>" +
  "<circle cx='18.5' cy='8.5' r='3.5'/>" +
  "<circle cx='7.5' cy='16.5' r='5.5'/>" +
  "<circle cx='7.5' cy='4.5' r='2.5'/>"

// The stroke width is 2.5, thicker than the header's (2). At 16px, 2 makes the three circles look
// thin and faint.
// CSS variables do not reach a favicon, so the colors are hex values, and light/dark switching is
// done with a media query inside the SVG (Chrome / Firefox evaluate it inside a favicon SVG)
function svg(light: string, dark: string): string {
  return (
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'" +
    " stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'>" +
    `<style>svg{stroke:${light}}@media(prefers-color-scheme:dark){svg{stroke:${dark}}}</style>` +
    `${BUBBLES}</svg>`
  )
}

// Escaping is kept to a minimum (the same form as money). Single quotes also become %27 because
// vite's transformIndexHtml rewrites ' in attribute values to &#39;, making the data URI hard to
// read (it still works, but it gets in the way when reading the generated index.html)
const dataUri = (s: string) =>
  `data:image/svg+xml,${s
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/#/g, '%23')
    .replace(/'/g, '%27')}`

export const faviconHref = dataUri(svg(accentHex.light, accentHex.dark))

// On localhost the icon is grayscale, so it is told apart from production's green at a glance.
// Black or white follows the OS prefers-color-scheme, not the app theme. The browser (= the OS
// setting) decides the tab bar's background, so even with the app fixed to light, the tab bar
// stays black when the OS is dark, and following the app theme would put black on black and the
// icon would vanish
export const faviconLocalHref = dataUri(svg('#000', '#fff'))

export const isLocalHostname = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1'

export const faviconHrefFor = (hostname: string) =>
  isLocalHostname(hostname) ? faviconLocalHref : faviconHref

// For the admin SPA. index.html is fixed at build time, so the localhost check can only happen in
// the browser (the SSR side can see the hostname on the server, so it does not ship this JS).
// href is embedded as a JS literal with JSON.stringify. With ' turned into %27 in the data URI,
// plain interpolation would not break today, but if the escaping were ever loosened, a syntax
// error would kill the whole script (not even catch could save it), and this avoids that
export const faviconLocalScript = `(function () {
  try {
    var h = location.hostname;
    if (h !== 'localhost' && h !== '127.0.0.1') return;
    var l = document.querySelector('link[rel="icon"]');
    if (l) l.href = ${JSON.stringify(faviconLocalHref)};
  } catch (e) {}
})();`

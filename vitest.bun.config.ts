// Run the same tests as Workers on Bun, against the Bun backend (pnpm test:bun).
// `cloudflare:test` is replaced with test/bun/cloudflare-test.ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      // Do what the rules in wrangler.toml do (read *.md as Text)
      name: 'markdown-as-text',
      transform(code, id) {
        if (id.endsWith('.md')) return { code: `export default ${JSON.stringify(code)}`, map: null }
      },
    },
  ],
  resolve: {
    alias: {
      'cloudflare:test': fileURLToPath(new URL('./test/bun/cloudflare-test.ts', import.meta.url)),
    },
  },
  test: {
    // test/cli holds CLI tests that use Bun APIs (bun:sqlite, Bun.file, etc), so run them only here
    include: ['test/*.test.ts', 'test/cli/*.test.ts'],
  },
})

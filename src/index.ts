// The Workers entry point. Builds a Workers backend (D1 + R2 + Access) per request and hands it to
// the shared app

import { Hono } from 'hono'
import { app } from './app'
import type { DropEnv } from './backend/types'
import { type Env, workersBackend } from './backend/workers'

const worker = new Hono<{ Bindings: Env } & DropEnv>()

worker.use('*', async (c, next) => {
  c.set('backend', workersBackend(c.env, c.executionCtx))
  await next()
})
worker.route('/', app)

export default worker

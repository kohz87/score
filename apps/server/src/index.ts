import { buildApp } from './app.ts'

const host = process.env.SCORE_HOST ?? '127.0.0.1'
const port = Number(process.env.SCORE_PORT ?? 8740)

const app = buildApp()
try {
  await app.listen({ host, port })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

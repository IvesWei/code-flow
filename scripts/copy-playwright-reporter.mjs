import { copyFile, mkdir } from 'node:fs/promises'

const destination = new URL('../dist-server/server/verification/', import.meta.url)
await mkdir(destination, { recursive: true })
await copyFile(
  new URL('../server/verification/playwright-reporter.cjs', import.meta.url),
  new URL('playwright-reporter.cjs', destination),
)
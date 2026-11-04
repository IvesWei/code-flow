import { captureExistingPages } from './page-capture.js'
import { testLoginConfig } from './test-login-config.js'

const config = await testLoginConfig()
if (!config) throw new Error('未配置测试登录账号')
try {
  const captures = await captureExistingPages(config.origin, [{ blockId: 'verification', path: '/dashboard/projects/star' }], new AbortController().signal)
  console.log(JSON.stringify({ authenticated: true, captures: captures.length, imageBytes: captures[0].png.length }))
} catch (error) {
  const code = error instanceof Error ? /\[(PAGE_[A-Z_]+)\]/.exec(error.message)?.[1] : undefined
  console.log(JSON.stringify({ authenticatedCapture: false, code: code ?? 'VERIFICATION_FAILED' }))
  process.exitCode = 1
}
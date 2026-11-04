import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { executionEnvironment } from '../execution/execution-environment.js'

export function validateRepository(input: string): string {
  const url = new URL(input)
  const allowedHost = (url.hostname === 'github.com' && url.protocol === 'https:') ||
    (url.hostname === 'code.sunmi.com' && ['http:', 'https:'].includes(url.protocol))
  if (!allowedHost || url.username || url.password || url.port || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname)) {
    throw new Error('请输入 GitHub HTTPS 或 code.sunmi.com 仓库地址')
  }
  return url.toString()
}

export function run(command: string, args: string[], cwd: string, timeoutMs: number, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...executionEnvironment(environment), GIT_TERMINAL_PROMPT: '0' },
    })
    let output = ''
    let timedOut = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { output = (output + stdoutDecoder.write(chunk)).slice(-12000) })
    child.stderr.on('data', (chunk: Buffer) => { output = (output + stderrDecoder.write(chunk)).slice(-12000) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      output = (output + stdoutDecoder.end() + stderrDecoder.end()).slice(-12000)
      if (timedOut) reject(new Error(`${command} 超时: ${output}`))
      else if (code !== 0) reject(new Error(`${command} 退出码 ${code}: ${output}`))
      else resolve(output.trim())
    })
  })
}
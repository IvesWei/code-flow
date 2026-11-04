import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolArguments, toolOutput } from './tool-detail.js'

test('tool details retain commands and output without common credentials', () => {
  const command = toolArguments({ command: 'npm test --token=gho_abc123', hidden: 'do not display', path: 'src/index.ts' })
  assert.match(command || '', /npm test/)
  assert.doesNotMatch(command || '', /gho_abc123|do not display/)
  const output = toolOutput('Bearer abc123\nclient_secret=private\napi_key: secret\nTest failed')
  assert.match(output || '', /Test failed/)
  assert.doesNotMatch(output || '', /abc123|private|api_key: secret/)
  assert.match(toolArguments({ code: 'print("hello")', file_path: 'src/main.py' }) || '', /code: print\("hello"\)[\s\S]*file_path: src\/main.py/)
})

test('tool output removes terminal color and cursor controls without losing Chinese text', () => {
  assert.equal(toolOutput('\u001b[32m中文测试通过\u001b[0m\r\u001b[2K'), '中文测试通过\r')
})
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodeDirectoryInput } from '../../../src/features/requirements/CodeDirectoryInput.js'

test('directory input SSR exposes native directory selection, explicit snapshot action and disabled state', () => {
  let submissions = 0
  for (const disabled of [false, true]) {
    const markup = renderToStaticMarkup(React.createElement(CodeDirectoryInput, { disabled, onAdd: async () => { submissions++ } }))
    assert.match(markup, /type="file"[^>]*webkitdirectory=""/)
    assert.match(markup, /aria-label="本地已有项目代码"/)
    assert.match(markup, /候选 0 个文件/)
    assert.match(markup, /已排除 0 个文件/)
    assert.match(markup, /type="submit" disabled=""[^>]*>.*添加代码快照/s)
    assert.equal(/<fieldset disabled="">/.test(markup), disabled)
  }
  assert.equal(submissions, 0)
})
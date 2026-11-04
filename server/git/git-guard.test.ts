import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prohibitedGitOperation } from './git-guard.js'

test('Copilot tool commands cannot directly publish or create a PR', () => {
  for (const command of ['git push origin HEAD:refs/heads/main', 'git -C . commit -m save', 'git.exe -c core.quotePath=false push origin HEAD', 'gh pr create --fill']) {
    assert.equal(prohibitedGitOperation(command), true, command)
  }
  for (const command of ['git status --short', 'git diff HEAD', 'npm run build', 'npm test']) {
    assert.equal(prohibitedGitOperation(command), false, command)
  }
})
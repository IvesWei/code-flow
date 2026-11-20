import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { executionEnvironment } from '../../execution/execution-environment.js'
import type { RequirementProject } from '../../../shared/requirements.js'

test('clarification shows one question, advances on selection and retains all drafts and partial submissions', { timeout: 120000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'requirements-clarification-ui-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const at = '2026-11-12T08:00:00.000Z'
  const root = '/api/requirements/projects'
  const longChoice = '保留现有筛选条件、角色权限及客户状态规则，并在查询无匹配数据时展示完整的空结果提示，不改变现有业务流程'
  const fixture: RequirementProject = {
    schemaVersion: 1, id: 'clarification-ui', ownerId: 7, version: 1, title: '隔离澄清交互回归', description: '保持原始需求、答案与确认规则不变。', modelId: 'auto', createdAt: at, updatedAt: at, status: 'needs_input',
    sources: [], evidence: [], decisions: [], revisions: [], jobs: [], events: [],
    questions: [
      { id: 'Q1', priority: 'P0', text: '是否保留现有权限？', impact: '影响角色权限边界。', choices: ['保留现有权限', '新建独立权限策略'], recommendation: '保留现有权限' },
      { id: 'Q2', priority: 'P1', text: '客户列表的组合筛选、状态约束及无匹配数据反馈应该遵循哪些规则以保持与现有系统行为一致？', impact: '影响筛选结果与客户数据展示。', choices: [longChoice, '提供其他规则说明'], recommendation: longChoice },
      { id: 'Q3', priority: 'P2', text: '查询条件是否需要保留？', impact: '影响再次进入页面时的筛选状态。', choices: ['保留查询条件', '每次重新输入'], recommendation: '' },
      { id: 'Q4', priority: 'P2', text: '还有哪些需要补充的业务规则？', impact: '兼容只支持手动输入的历史问题。', choices: [], recommendation: '旧建议不应单独重复展示' },
    ],
  }
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    for (const width of [1440, 1367, 390, 320]) {
      let project = structuredClone(fixture), failSubmit = true
      const writes: unknown[] = [], unexpected: string[] = [], errors: string[] = []
      const page = await browser.newPage({ viewport: { width, height: 1000 } })
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/api/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname
        const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
        if (request.method() === 'GET') {
          if (path === '/api/auth/status') return reply({ configured: true, authenticated: true, login: 'fixture', userId: 7 })
          if (path === '/api/copilot/models' || path === '/api/models') return reply({ defaultModelId: 'auto', models: [{ id: 'auto', name: 'Auto', vision: true }] })
          if (path === '/api/tasks') return reply({ items: [], busy: false })
          if (path === root) return reply([project])
          if (path === `${root}/${project.id}`) return reply(project)
        }
        if (request.method() === 'POST' && path === `${root}/${project.id}/answers`) {
          const body = request.postDataJSON() as { version: number; answers: { questionId: string; answer: string }[] }
          writes.push(body)
          assert.equal(body.version, project.version)
          if (failSubmit) { failSubmit = false; return reply({ error: '隔离测试：提交失败，请重试' }, 503) }
          for (const answer of body.answers) {
            const question = project.questions.find(item => item.id === answer.questionId)
            assert.ok(question)
            project.decisions.push({ question, answer: answer.answer, at })
          }
          project.version++
          return reply(project)
        }
        unexpected.push(`${request.method()} ${path}`)
        return reply({ error: 'Unexpected endpoint' }, 404)
      })
      const clarification = page.getByRole('region', { name: '待澄清问题', exact: true })
      const previous = clarification.getByRole('button', { name: '上一条', exact: true })
      const next = clarification.getByRole('button', { name: '下一条', exact: true })
      const submit = clarification.getByRole('button', { name: '提交已填写答案', exact: true })
      const goToQuestions = () => page.getByRole('button', { name: '去填写答案', exact: true }).click()
      const question = (id: string) => clarification.getByRole('textbox', { name: `回答 · ${id}`, exact: true })
      const assertCurrent = async (id: string, index: number, total = 4) => {
        await expect(question(id)).toBeVisible()
        await expect(clarification.locator('.requirements-question')).toHaveCount(1)
        await expect(clarification.getByRole('textbox')).toHaveCount(1)
        await expect(clarification.getByRole('status')).toContainText(`第 ${index} / ${total} 条`)
      }
      const assertFit = async () => {
        const controls = clarification.locator('.requirements-question-navigation button, .requirements-question-footer > button')
        const boxes = await controls.evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }))
        for (const [index, box] of boxes.entries()) {
          assert.ok(box.left >= 0 && box.right <= width + 1)
          for (const other of boxes.slice(index + 1)) assert.ok(box.right <= other.left + 1 || other.right <= box.left + 1 || box.bottom <= other.top + 1 || other.bottom <= box.top + 1)
        }
        assert.equal(await clarification.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      }
      await page.goto(`http://127.0.0.1:${address.port}/requirements/${project.id}`, { waitUntil: 'networkidle' })
      await goToQuestions()
      await assertCurrent('Q1', 1)
      await expect(previous).toBeDisabled()
      await expect(submit).toBeDisabled()
      const recommended = clarification.getByRole('radio', { name: '保留现有权限', exact: true })
      await expect(recommended).toHaveAccessibleDescription('【推荐】')
      await expect(clarification.getByText('【推荐】', { exact: true })).toHaveCount(1)
      await expect(clarification).not.toContainText('建议：')
      await recommended.locator('..').click()
      await assertCurrent('Q2', 2)
      await expect(clarification.locator('legend')).toBeFocused()
      await expect(clarification.getByRole('status')).toContainText('已填写 1 / 4')
      assert.equal(writes.length, 0, 'Selecting an answer must not submit or generate anything')
      await assertFit()
      const longOption = clarification.getByRole('radio', { name: longChoice, exact: true })
      await expect(longOption).toHaveAccessibleDescription('【推荐】')
      assert.equal((await clarification.innerText()).split(longChoice).length - 1, 1, 'Recommended answer text appears only inside its option')
      await page.screenshot({ path: join(temporary, `clarification-long-choice-${width}.png`), fullPage: true })
      await previous.click()
      await assertCurrent('Q1', 1)
      await expect(clarification.locator('legend')).toHaveCSS('outline-style', 'none')
      await expect(recommended).toBeChecked()
      await expect(question('Q1')).toHaveValue('保留现有权限')
      await clarification.getByRole('radio', { name: '新建独立权限策略', exact: true }).focus()
      await page.keyboard.press('ArrowUp')
      await assertCurrent('Q1', 1)
      await expect(recommended).toBeChecked()
      await page.keyboard.press('Space')
      await assertCurrent('Q2', 2)
      await question('Q2').fill('手动补充，不要在输入中自动翻题')
      await assertCurrent('Q2', 2)
      await next.focus(); await page.keyboard.press('Enter')
      await assertCurrent('Q3', 3)
      await expect(clarification.locator('legend')).toBeFocused()
      await expect(clarification.locator('legend')).toHaveCSS('outline-style', 'solid')
      await expect(clarification.getByText('【推荐】', { exact: true })).toHaveCount(0)
      await next.click()
      await assertCurrent('Q4', 4)
      await expect(clarification.locator('legend')).toBeFocused()
      await expect(clarification.locator('legend')).toHaveCSS('outline-style', 'none')
      await expect(next).toBeDisabled()
      await expect(clarification.getByRole('radio')).toHaveCount(0)
      await expect(clarification).not.toContainText('旧建议不应单独重复展示')
      await question('Q4').fill('最后一条的补充说明')
      await page.getByRole('tab', { name: '系统产物', exact: true }).click()
      await goToQuestions()
      await assertCurrent('Q4', 4)
      await expect(question('Q4')).toHaveValue('最后一条的补充说明')
      await previous.click(); await previous.click()
      await assertCurrent('Q2', 2)
      await expect(question('Q2')).toHaveValue('手动补充，不要在输入中自动翻题')
      await question('Q2').fill('')
      await page.reload({ waitUntil: 'networkidle' })
      await goToQuestions()
      await assertCurrent('Q1', 1)
      await expect(recommended).toBeChecked()
      await next.click(); await assertCurrent('Q2', 2)
      await expect(question('Q2')).toHaveValue('')
      await next.click(); await next.click()
      await expect(question('Q4')).toHaveValue('最后一条的补充说明')
      await submit.click()
      await expect(page.getByRole('tabpanel', { name: /^澄清与决策/ }).getByRole('alert')).toContainText('隔离测试：提交失败')
      await assertCurrent('Q4', 4)
      await expect(question('Q4')).toHaveValue('最后一条的补充说明')
      assert.deepEqual(writes[0], { version: 1, answers: [{ questionId: 'Q1', answer: '保留现有权限' }, { questionId: 'Q4', answer: '最后一条的补充说明' }] })
      await submit.click()
      await assertCurrent('Q2', 1, 2)
      await expect(previous).toBeDisabled()
      await expect(clarification.getByRole('status')).toContainText('已填写 0 / 2')
      await expect(submit).toBeDisabled()
      await longOption.focus(); await page.keyboard.press('Enter')
      await assertCurrent('Q3', 2, 2)
      await clarification.getByRole('radio', { name: '保留查询条件', exact: true }).click()
      await assertCurrent('Q3', 2, 2)
      await expect(next).toBeDisabled()
      assert.equal(writes.length, 2, 'The last selection must not auto-submit')
      await expect(clarification.getByRole('status')).toContainText('已填写 2 / 2')
      await previous.click(); await assertCurrent('Q2', 1, 2)
      await expect(longOption).toBeChecked()
      await longOption.locator('..').click()
      await assertCurrent('Q3', 2, 2)
      await assertFit()
      await submit.click()
      await expect(clarification).toHaveCount(0)
      await expect(page.getByText('当前没有待澄清问题', { exact: true })).toBeVisible()
      await expect(page.getByText('已确认决策 · 4', { exact: true })).toBeVisible()
      assert.deepEqual(writes[2], { version: 2, answers: [{ questionId: 'Q2', answer: longChoice }, { questionId: 'Q3', answer: '保留查询条件' }] })
      project = { ...structuredClone(fixture), version: 4, questions: [fixture.questions[0]], status: 'running', jobs: [{ id: 'held-job', stage: 'analyze', status: 'running', startedAt: at }] }
      await page.reload({ waitUntil: 'networkidle' })
      await goToQuestions()
      await assertCurrent('Q1', 1, 1)
      await expect(previous).toBeDisabled()
      await expect(next).toBeDisabled()
      await expect(recommended).toBeDisabled()
      await expect(question('Q1')).toBeDisabled()
      await expect(submit).toBeDisabled()
      assert.deepEqual(unexpected, [])
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS === '1') console.log(`Clarification screenshots: ${temporary}`)
    else rmSync(temporary, { recursive: true, force: true })
  }
})

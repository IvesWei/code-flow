import { CopilotClient, type SessionConfig } from '@github/copilot-sdk'
import { mkdir, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, basename, relative } from 'node:path'
import type { CodingTask, SelfTestArtifact, SelfTestCase, AcceptanceAssessment } from '../../shared/task.js'
import { casePolicy, createExecutionPlan, executionSummary } from '../../shared/test-policy.js'
import { customReady } from '../../shared/case-review.js'
import { changedFiles, taskChangeFiles } from '../git/changes.js'
import { run } from '../git/git.js'
import { prohibitedGitOperation } from '../git/git-guard.js'
import { executeTestCase, supportedTestScript, shouldRunBrowserCase } from '../verification/self-test.js'
import { generateTestBatches } from '../verification/test-plan-generation.js'
import { batches, testPlanPolicy } from '../verification/test-plan-policy.js'
import { browserPlanInstructions, browserProtocolVersion, executeBrowserScript, generateBrowserPlan, localPreviewUrl, parseBrowserPlan } from '../verification/browser-automation.js'
import { publicationSnapshot } from '../git/publish.js'
import { TaskStorageError, TaskStore } from '../tasks/store.js'
import { toolArguments, toolOutput } from './tool-detail.js'
import { defaultModel } from './models.js'
import { ModelTurn } from './model-turn.js'
import { applyExecutionReview, assessExecutionReadiness, applyQualityReview, assessAcceptance, parseAcceptanceBaseline, qualityRepairIds } from '../verification/acceptance.js'
import { executionEnvironment } from './execution-environment.js'
import { resumeContext } from './resume-context.js'
import { openTaskSession, SessionRestoreError } from './copilot-session.js'
import { SessionProgressWaiter } from './session-progress.js'
import { modelTimeouts } from './model-timeouts.js'
import { caseInputs, fileFingerprint, fingerprint, SelfTestArtifacts, selfTestRulesVersion, workspaceFingerprint } from '../verification/self-test-artifacts.js'
import { canWriteTestFile } from '../verification/self-test-permissions.js'
import { attachModelUsage, type ModelUsageObserver } from './model-usage.js'
import { appendSerializedDecisionSuffix } from './prompts.js'
import { CodingAgent } from './coding-agent.js'
import { AgentBoundaryError } from '../agents/runtime.js'
import { agentFileAccess } from '../agents/workspace.js'

interface UserAnswer {
  answer: string
  wasFreeform: boolean
}

export class CodingWorker {
  private pending = new Map<string, { resolve: (answer: UserAnswer) => void; reject: (error: unknown) => void; stage: 'CODING' | 'SELF_TEST' | 'TEST_EXECUTION' }>()
  private running = new Set<string>()

  constructor(private readonly store: TaskStore, private readonly root: string) {}

  isRunning(id: string): boolean { return this.running.has(id) }

  answer(id: string, answer: string): boolean {
    const pending = this.pending.get(id)
    const task = this.store.get(id)
    if (!pending || task?.status !== 'NEEDS_INPUT' || !task.question) return false
    const wasFreeform = !task.question.choices?.includes(answer)
    if (wasFreeform && !task.question.allowFreeform) return false
    this.pending.delete(id)
    this.store.entry(id, 'answer', answer)
    this.store.update(id, { confirmedDecisions: [...(task.confirmedDecisions || []), { at: this.store.get(id)!.entries.at(-1)!.at, question: task.question.text, answer, stage: pending.stage }], question: undefined, status: pending.stage })
    if (this.store.asynchronousPersistence) void this.store.flush().then(() => pending.resolve({ answer, wasFreeform })).catch(pending.reject)
    else pending.resolve({ answer, wasFreeform })
    return true
  }

  async execute(task: CodingTask, prdPath: string, designPaths: string[], token: string, guidance?: string, selfTestOnly = false, allowNewSession = false, selectedCaseIds: string[] = [], intent: 'repair' | 'execute' = 'repair'): Promise<void> {
    if (this.running.has(task.id)) throw new AgentBoundaryError('AGENT_BUSY')
    task = structuredClone(task)
    const agent = new CodingAgent(task, async event => {
      this.store.entry(task.id, event.kind === 'failed' ? 'error' : 'info', `agent:${JSON.stringify(event)}`)
      await this.store.flush()
    }, { guidance, selfTestOnly, selectedCaseIds, intent })
    let agentFailed = false
    let agentCompleted = false
    let client: CopilotClient | undefined
    let session: Awaited<ReturnType<CopilotClient['createSession']>> | undefined
    const previousError = task.error
    const previousChecks = task.checks
    const previousTests = task.selfTests
    const previousPublication = task.publication
    let recoveryContext = guidance || selfTestOnly ? resumeContext(task) : undefined
    let planningSelfTest = false
    let progressWaiter: SessionProgressWaiter | undefined
    const usageObservers: ModelUsageObserver[] = []
    this.running.add(task.id)
    try {
      await agent.record('started')
      const workspace = join(this.root, 'workspaces', task.id)
      if (selfTestOnly) {
        this.store.status(task.id, 'SELF_TEST', '在现有分支和工作目录上补跑编码自测')
        this.store.update(task.id, { selfTestError: undefined, changes: taskChangeFiles(this.store.get(task.id)!) })
      } else if (!guidance) {
        this.store.status(task.id, 'CLONING', '正在拉取仓库')
        await this.store.flush()
        await mkdir(join(this.root, 'workspaces'), { recursive: true })
        const cloneArgs = ['clone', '--depth', '1']
        if (task.branch) cloneArgs.push('--branch', task.branch, '--single-branch')
        cloneArgs.push('--', task.repository, workspace)
        await run('git', cloneArgs, this.root, 120_000)
        const createdBranch = `copilot/task-${task.id.slice(0, 8)}`
        await run('git', ['switch', '-c', createdBranch], workspace, 15_000)
        this.store.update(task.id, { workspace, createdBranch })
        this.store.entry(task.id, 'info', `已创建本地分支 ${createdBranch}`)
        this.store.status(task.id, 'CODING', '仓库已拉取，Copilot 正在编码')
      } else {
        this.store.status(task.id, 'CODING', '根据你的补充说明，在原工作目录继续编码')
      }

      const sessionDirectory = join(this.root, 'sessions', task.id)
      await mkdir(sessionDirectory, { recursive: true })
      const initialModel = this.store.get(task.id)?.modelId || defaultModel()
      const baseSessionConfig: SessionConfig = {
        model: initialModel,
        streaming: true,
        gitHubToken: token,
        workingDirectory: workspace,
        hooks: { onPreToolUse: (input) => {
          if (/^(bash|shell|powershell|run_in_terminal|execute|terminal)$/i.test(input.toolName) &&
              prohibitedGitOperation(JSON.stringify(input.toolArgs))) return { permissionDecision: 'deny', permissionDecisionReason: '提交、推送和创建 PR 必须通过用户确认后的平台接口执行' }
        } },
        onPermissionRequest: async (request) => {
          if ('managedApprovalRequired' in request && request.managedApprovalRequired) return { kind: 'user-not-available' }
          if (intent === 'execute' && planningSelfTest && request.kind !== 'read') return { kind: 'reject', feedback: '执行已有用例时只读评审，不允许修改用例或业务文件' }
          if (request.kind === 'shell' && prohibitedGitOperation(request.fullCommandText)) return { kind: 'reject', feedback: '提交、推送和创建 PR 必须通过用户确认后的平台接口执行' }
          if (planningSelfTest && !['read', 'write'].includes(request.kind)) {
            return { kind: 'reject', feedback: '自测设计阶段仅允许读取代码和编写测试文件，测试命令由平台逐条执行' }
          }
          if (!planningSelfTest && (request.kind === 'read' || request.kind === 'write')) {
            const path = request.kind === 'write' ? request.resolvedPath || request.fileName : request.path
            if (request.requestSandboxBypass || typeof path !== 'string' || !await agentFileAccess(workspace, path, request.kind, [prdPath, ...designPaths])) return { kind: 'reject', feedback: 'Coding file access is limited to the assigned workspace and exact read-only attachments.' }
          }
          return { kind: 'approve-once' }
        },
        onUserInputRequest: async (request) => {
          progressWaiter?.pause()
          const currentStage = this.store.get(task.id)?.status
          const stage = currentStage === 'SELF_TEST' || currentStage === 'TEST_EXECUTION' ? currentStage : 'CODING'
          this.store.update(task.id, {
            status: 'NEEDS_INPUT',
            question: {
              text: request.question,
              choices: request.choices,
              allowFreeform: request.allowFreeform !== false,
            },
          })
          this.store.entry(task.id, 'info', 'Copilot 正在等待你的回答', request.question)
          try {
            return await new Promise<UserAnswer>((resolve, reject) => this.pending.set(task.id, { resolve, reject, stage }))
          } finally { progressWaiter?.resume() }
        },
      }
      const sessionConfig = agent.configure(baseSessionConfig)
      if (!selfTestOnly) {
        client = new CopilotClient({ workingDirectory: workspace, baseDirectory: sessionDirectory, gitHubToken: token, useLoggedInUser: false, env: executionEnvironment() })
        const opened = await openTaskSession(client, this.store, task.id, sessionDirectory, sessionConfig, !!guidance, allowNewSession)
        session = opened.session
        if (opened.restored) recoveryContext = undefined
        this.store.entry(task.id, 'info', opened.restored ? '已恢复原 SDK 会话与对话历史；中断命令不会自动重放' : '已创建并保存 SDK 会话')
      } else this.store.entry(task.id, 'info', '自测采用独立阶段短会话和版本化产物；不恢复或替换原编码会话')
      if (guidance) this.store.update(task.id, { error: undefined, checks: undefined, selfTestError: undefined, publication: undefined, acceptanceBaseline: undefined, acceptanceAssessment: undefined, testExecutionPlan: undefined, acceptanceSelection: undefined, executionAssessment: undefined })
      const trackSession = (tracked: Awaited<ReturnType<CopilotClient['createSession']>>) => {
      tracked.on('assistant.message', (event) => {
        if (event.data.content?.trim() && !(this.store.get(task.id)?.status === 'TEST_EXECUTION' && planningSelfTest)) this.store.entry(task.id, 'agent', event.data.content)
      })
      const toolNames = new Map<string, string>()
      tracked.on('tool.execution_start', (event) => {
        toolNames.set(event.data.toolCallId, event.data.toolName)
        this.store.entry(task.id, 'info', `Copilot 正在执行 ${event.data.toolName}`, toolArguments(event.data.arguments), { toolCallId: event.data.toolCallId, toolEvent: 'start' })
      })
      tracked.on('tool.execution_complete', (event) => {
        const name = toolNames.get(event.data.toolCallId) || '工具'
        toolNames.delete(event.data.toolCallId)
        this.store.entry(task.id, event.data.success ? 'info' : 'error', `${name} ${event.data.success ? '执行完成' : '执行失败'}`, toolOutput(event.data.result?.detailedContent || event.data.result?.content || event.data.error?.message), { toolCallId: event.data.toolCallId, toolEvent: 'complete' })
      })
      }
      if (session) trackSession(session)
      const activeSession = session
      const sendWithModel = async (options: Parameters<NonNullable<typeof activeSession>['send']>[0], timeout: number) => {
        if (!activeSession) throw new Error('编码会话不存在')
        const modelTurn = new ModelTurn(this.store, task.id, initialModel, activeSession)
        progressWaiter = new SessionProgressWaiter(agent.session({ send: activeSession.send.bind(activeSession), on: activeSession.on.bind(activeSession) }))
        const limits = modelTimeouts(timeout)
        const stage = this.store.get(task.id)?.status
        const label = stage === 'CODING' ? '编码执行' : stage === 'SELF_TEST' ? intent === 'execute' ? '已有用例只读评审' : '生成用例与验收评审' : intent === 'execute' ? '已有用例执行计划' : '测试执行与修正'
        return modelTurn.send((report) => progressWaiter!.send(options, limits, report), label, limits)
      }
      const attachments = [prdPath, ...designPaths].map((path) => ({ type: 'file' as const, path, displayName: basename(path) }))
      for (const [index, path] of [prdPath, ...designPaths].entries()) {
        const bytes = await readFile(path)
        this.store.recordFile(task.id, { kind: index === 0 ? 'prd' : 'design', storageKey: relative(this.root, path).split('\\').join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, metadata: { displayName: basename(path) } })
      }
      this.store.recordFile(task.id, { kind: 'session_manifest', storageKey: relative(this.root, sessionDirectory).split('\\').join('/'), metadata: { directory: true } })
      if (session) usageObservers.push(attachModelUsage(session, (observation) => this.store.recordUsage(task.id, { ...observation, body: { ...observation.body } }), () => ({ taskId: task.id, turnId: this.store.get(task.id)?.modelTurn?.id, model: this.store.get(task.id)?.activeModelId, phase: 'coding' })))
      const artifacts = new SelfTestArtifacts(this.store, task.id)
      let sourceIdentity = ''
      const phaseNames = { baseline: '提取验收基线', generation: '生成或修正用例批次', review: '独立用例质量评审', browser: '独立浏览器规划' }
      const sendPhase = async (options: Parameters<NonNullable<typeof activeSession>['send']>[0], timeout: number, phase: SelfTestArtifact['phase'], scope: string, identity: string, refs: string[], validate?: (content: string) => NonNullable<SelfTestArtifact['output']>, allowedExisting: string[] = [], label = phaseNames[phase]) => {
        const phaseAgent = agent.forRole(phase === 'generation' ? 'test-authoring' : phase === 'review' ? 'test-review' : phase === 'browser' ? 'browser-planning' : 'test-planning')
        const model = this.store.get(task.id)?.modelId || defaultModel()
        const artifact = await artifacts.start(phase, scope, identity, refs, model)
        const directory = join(sessionDirectory, 'self-test', artifact.id)
        await mkdir(directory, { recursive: true })
        const phaseClient = new CopilotClient({ workingDirectory: workspace, baseDirectory: directory, gitHubToken: token, useLoggedInUser: false, env: executionEnvironment() })
        let phaseSession: Awaited<ReturnType<CopilotClient['createSession']>> | undefined
        const writtenFiles = new Set<string>()
        let usageObserver: ModelUsageObserver | undefined
        try {
          phaseSession = await phaseClient.createSession(phaseAgent.configure({ ...baseSessionConfig, model,
            ...(phase === 'generation' ? {} : { availableTools: ['view', 'glob', 'grep', 'ask_user'] }),
            onPermissionRequest: async (request) => {
            if ('managedApprovalRequired' in request && request.managedApprovalRequired) return { kind: 'user-not-available' }
            if (request.kind === 'read') {
              const path = request.path
              if (!request.requestSandboxBypass && typeof path === 'string' && await agentFileAccess(workspace, path, 'read', [prdPath, ...designPaths])
                && !(phase === 'review' && /\.(?:test|spec)\.[a-z0-9]+$/i.test(path))) return { kind: 'approve-once' }
              return { kind: 'reject', feedback: 'Stage reads are limited to assigned sources; review cannot read test scripts.' }
            }
            if (phase === 'generation' && request.kind === 'write' && !request.requestSandboxBypass && await canWriteTestFile(workspace, request.resolvedPath || request.fileName, [...allowedExisting, ...writtenFiles])) {
              writtenFiles.add(request.resolvedPath || request.fileName)
              return { kind: 'approve-once' }
            }
            return { kind: 'reject', feedback: '独立自测阶段禁止执行命令；只有生成阶段可编写测试文件，其他阶段只读' }
          } }))
          if (!phaseSession.sessionId) throw new Error('SDK 未返回独立阶段会话 ID')
          await artifacts.bindSession(artifact.id, phaseSession.sessionId)
          usageObserver = attachModelUsage(phaseSession, (observation) => this.store.recordUsage(task.id, { ...observation, body: { ...observation.body } }), () => ({ taskId: task.id, turnId: this.store.get(task.id)?.modelTurn?.id, artifactId: artifact.id, model: this.store.get(task.id)?.activeModelId || model, phase }))
          trackSession(phaseSession)
          this.store.entry(task.id, 'info', `${phaseNames[phase]}：独立会话 ${phaseSession.sessionId}；产物 ${artifact.id}`)
          const limits = modelTimeouts(timeout)
          progressWaiter = new SessionProgressWaiter(phaseAgent.session({ send: phaseSession.send.bind(phaseSession), on: phaseSession.on.bind(phaseSession) }))
          const turn = new ModelTurn(this.store, task.id, model, phaseSession)
          const decisions = JSON.stringify(this.store.get(task.id)?.confirmedDecisions || [])
          const response = await turn.send((report) => progressWaiter!.send({ ...options, prompt: appendSerializedDecisionSuffix(options.prompt, decisions) }, limits, report), label, limits)
          const content = response?.data.content || ''
          if (!content.trim()) throw new Error('Copilot 没有返回阶段产物')
          const output = { ...(validate ? validate(content) : { content }), ...(writtenFiles.size ? { writtenFiles: [...writtenFiles] } : {}) }
          await artifacts.finish(artifact.id, { status: validate ? 'complete' : 'blocked', sessionId: phaseSession.sessionId, output })
          return response
        } catch (error) {
          await phaseSession?.abort().catch(() => {})
          if (!(error instanceof TaskStorageError)) await artifacts.finish(artifact.id, { status: 'failed', sessionId: phaseSession?.sessionId, output: writtenFiles.size ? { writtenFiles: [...writtenFiles] } : undefined, error: error instanceof Error ? error.message : String(error) })
          throw error
        } finally {
          progressWaiter = undefined
          await phaseSession?.disconnect().catch(() => {})
          await phaseClient.stop().catch(() => {})
          usageObserver?.dispose()
          await usageObserver?.flush()
          for (const path of writtenFiles) {
            try {
              const bytes = await readFile(path)
              this.store.recordFile(task.id, { kind: 'test', storageKey: relative(this.root, path).split('\\').join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, metadata: { artifactId: artifact.id } })
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          }
          await this.store.flush()
        }
      }
      if (recoveryContext) {
        this.store.entry(task.id, 'info', '已加载历史问答与执行进展，正在重建 Copilot 上下文')
      }
      if (!selfTestOnly) {
      const response = await sendWithModel({
        prompt: [
          '你是本地编码执行者。请在当前工作目录中根据所附 PRD 和设计图修改代码。',
          `用户任务：${task.instruction}`,
          ...(recoveryContext ? [recoveryContext] : []),
          ...(guidance ? [`用户补充说明：${guidance}`, `上次失败：${previousError || '执行未完成'}`, `上次验收结果：${(previousChecks || []).filter((check) => !check.passed).map((check) => `${check.name}: ${check.output}`).join('\n').slice(0, 6000)}`, `上次自测问题：${(previousTests || []).filter((item) => item.status !== 'passed').map((item) => `${item.id} ${item.title}: ${item.output || item.status}`).join('\n').slice(0, 6000)}`, '请先解决上次失败的原因，保留已有代码修改，再继续完成任务。'] : []),
          '先阅读仓库约定和附件。遇到确实需要用户做业务决策的问题时使用 ask_user 工具，不要猜测。',
          '完成代码后运行仓库现有的相关验证，不要提交、推送代码或部署。最后简述修改和未解决的问题。',
        ].join('\n'),
        attachments,
      }, 20 * 60_000)
      if (!response) throw new Error('Copilot 未返回完成消息')
      this.store.entry(task.id, 'info', 'Copilot 编码结束，正在汇总变更和可用的项目脚本')
      const changes = await changedFiles(workspace)
      this.store.update(task.id, { changes })
      this.store.entry(task.id, 'info', `检测到 ${changes.length} 个变更文件`)
      if (!changes.length) throw new Error('Copilot 已结束，但仓库中没有代码变更')

      const checks: NonNullable<CodingTask['checks']> = []
      try {
        const packageJson = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
        for (const name of ['test', 'build']) {
          if (!packageJson.scripts?.[name]) continue
          this.store.entry(task.id, 'info', `开始执行 npm run ${name}`)
          try {
            const command = process.platform === 'win32' ? 'cmd.exe' : 'npm'
            const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', 'run', name] : ['run', name]
            await this.store.flush()
            const output = await run(command, args, workspace, 180_000)
            checks.push({ name: `npm run ${name}`, passed: true, output: toolOutput(output)?.slice(-3000) || '' })
            this.store.entry(task.id, 'info', `npm run ${name} 通过`, toolOutput(output))
          } catch (error) {
            checks.push({ name: `npm run ${name}`, passed: false, output: toolOutput(String(error))?.slice(-3000) || '' })
            this.store.entry(task.id, 'warning', `npm run ${name} 未通过（不阻断完成）`, toolOutput(String(error)))
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.store.update(task.id, { checks })
      try {
        const publication = await publicationSnapshot(this.store.get(task.id)!, workspace)
        this.store.update(task.id, { publication: { ...publication, previousCommit: previousPublication?.pushedAt ? previousPublication.commit : previousPublication?.previousCommit } })
      } catch (error) {
        this.store.update(task.id, { publication: { files: [], snapshot: '', error: error instanceof Error ? error.message : String(error) } })
      }
      this.store.status(task.id, 'PUBLISH_PENDING', '编码检查完成，等待确认远端任务分支与待推送文件')
      return
      }
      const checks = selfTestOnly ? task.checks || [] : this.store.get(task.id)?.checks || []
      this.store.status(task.id, 'SELF_TEST', intent === 'execute' ? '正在核对已有用例执行范围，不重新生成用例' : '现有检查已结束，Copilot 正在根据需求生成或修正自测用例')
      try {
        const policy = testPlanPolicy()
        const testScript = intent === 'execute' ? undefined : await supportedTestScript(workspace)
        const sourceInputs = { files: await fileFingerprint([prdPath, ...designPaths]), instruction: task.instruction, decisions: this.store.get(task.id)?.confirmedDecisions || [] }
        sourceIdentity = fingerprint({ ...sourceInputs, rules: selfTestRulesVersion })
        planningSelfTest = true
        let baseline = this.store.get(task.id)?.acceptanceBaseline
        const savedBaseline = this.store.get(task.id)?.selfTestArtifacts?.findLast((item) => item.phase === 'baseline' && item.scope === 'baseline' && item.status === 'complete')
        const compatibleBaseline = savedBaseline?.inputFingerprint === fingerprint({ ...sourceInputs, rules: savedBaseline?.rulesVersion })
        if (baseline?.length && savedBaseline && !compatibleBaseline) {
          if (intent === 'execute') throw new Error('需求附件或已确认决策已变化，旧基线失效；请明确生成或修正用例')
          baseline = undefined
          this.store.update(task.id, { acceptanceAssessment: undefined, executionAssessment: undefined })
        }
        if (intent === 'execute' && !baseline?.length) {
          this.store.update(task.id, { selfTestPlanningStatus: 'rejected' })
          this.store.status(task.id, 'REVIEW', '缺少需求基线，未生成或修改用例；请明确选择生成用例')
          return
        }
        if (!baseline?.length) {
          this.store.entry(task.id, 'info', '验收基线：正在从需求附件提取验收条件与适用场景')
          const response = await sendPhase({ prompt: [
            '仅依据 PRD、设计图和用户目标建立需求验收基线，不得把现有代码行为当作正确答案，不修改文件。只返回 1 至 50 项 JSON 数组。',
            '每项字段：id（REQ-001 格式）、feature（所属功能点的简短名称，同一功能点使用一致名称）、source（可追溯的需求条款）、criterion（明确可观察的验收条件）、required（布尔值）、scenarios（从 normal、boundary、negative、permission、state 中选适用场景）。',
            '用户明确要求的需求必须 required=true；按风险选择场景，不得为减少测试而遗漏异常、边界、权限或持久化验证。不能自行豁免用户要求。遇到需求歧义使用 ask_user，不猜测。',
            'required=false 仅用于需求之外、明确标注为建议的补充验证。不得仅因性能、安全、执行成本或缺少环境而将明确要求改为非必验。明确 SLA/性能指标必须必验；没有阈值的探索性容量测试可作为补充建议，不能编造验收阈值。',
            `用户目标：${task.instruction}`, ...(guidance ? [`补充说明：${guidance}`] : []),
            ...(recoveryContext ? [recoveryContext] : []),
          ].join('\n'), attachments }, 120_000, 'baseline', 'baseline', sourceIdentity, [sourceIdentity], (content) => ({ baseline: parseAcceptanceBaseline(content) }))
          baseline = parseAcceptanceBaseline(response?.data.content || '')
          this.store.update(task.id, { acceptanceBaseline: baseline })
          this.store.entry(task.id, 'info', `验收基线已保存：${baseline.length} 项需求`)
        }
        if (!await artifacts.lookup('baseline', 'baseline', sourceIdentity)) {
          const imported = await artifacts.start('baseline', 'baseline', sourceIdentity, [sourceIdentity], 'legacy-import')
          await artifacts.finish(imported.id, { status: 'complete', output: { baseline } })
          this.store.entry(task.id, 'info', savedBaseline && compatibleBaseline ? '需求输入指纹兼容，已有基线已登记到当前规则版本；旧规则评审不复用，重新进行只读评审' : '已有基线已登记为版本化产物；历史来源无法追溯，后续重新进行只读质量评审')
        }
        const baselineArtifact = (await artifacts.lookup('baseline', 'baseline', sourceIdentity))!
        const reviewIdentity = (scope: SelfTestCase[], snapshot: string, mode: 'default' | 'custom', reason = '') => fingerprint({ sourceIdentity, baseline, cases: caseInputs(scope), workspace: snapshot, mode, reason, model: this.store.get(task.id)?.modelId || defaultModel(), rules: selfTestRulesVersion })
        let reviewedSnapshot: string | undefined
        let reviewArtifactId: string | undefined
        const verifySource = async () => {
          if (fingerprint({ files: await fileFingerprint([prdPath, ...designPaths]), instruction: task.instruction, decisions: this.store.get(task.id)?.confirmedDecisions || [], rules: selfTestRulesVersion }) !== sourceIdentity) throw new Error('需求或已确认决策发生变化，旧产物已失效；未允许执行')
        }
        const reviewCases = async (scope: SelfTestCase[], mode: 'default' | 'custom', reason = ''): Promise<AcceptanceAssessment> => {
          this.store.update(task.id, { selfTestPlanningStatus: 'reviewing' })
          await verifySource()
          const snapshot = await workspaceFingerprint(workspace)
          const identity = reviewIdentity(scope, snapshot, mode, reason)
          let assessment = mode === 'custom' ? assessExecutionReadiness(baseline!, scope) : assessAcceptance(baseline!, scope)
          assessment = { ...assessment, inputFingerprint: identity }
          const canReview = mode === 'custom' ? assessment.readiness !== 'blocked' : assessment.status === 'qualified'
          const definitions = await artifacts.start('generation', `${mode}:review-input`, fingerprint({ sourceIdentity, baseline, cases: caseInputs(scope), workspace: snapshot }), [baselineArtifact.id, snapshot, ...this.store.get(task.id)!.selfTestArtifacts!.filter((item) => item.phase === 'generation' && item.scope === 'cases' && item.status === 'complete').slice(-1).map((item) => item.id)], 'platform-snapshot')
          this.store.entry(task.id, 'info', `评审输入快照：${mode}；${scope.length} 条；不生成或修改用例`)
          await artifacts.finish(definitions.id, { status: canReview ? 'complete' : 'blocked', output: { cases: structuredClone(scope), coverage: baseline!.flatMap((requirement) => requirement.scenarios.map((scenario) => ({ requirementId: requirement.id, scenario, caseIds: scope.filter((item) => item.requirementIds?.includes(requirement.id) && item.scenario === scenario).map((item) => item.id) }))) } })
          const saveAssessment = async (complete = false) => {
            const result = complete ? assessment : { ...assessment, ...(mode === 'custom' ? { readiness: 'checking' as const } : {}), status: 'rejected' as const, issues: [...assessment.issues, '质量评审尚未完成，暂不允许执行'] }
            this.store.update(task.id, { selfTestPlanningStatus: complete ? assessment.status : 'reviewing', ...(mode === 'custom' ? { executionAssessment: { ...result, caseIds: scope.map((item) => item.id) } } : { acceptanceAssessment: result }) })
            await this.store.flush()
          }
          await saveAssessment()
          const consumedReviewArtifacts: string[] = []
          if (canReview) {
            const reviewBatches = batches(scope, policy.batchSize)
            for (let index = 0; index < reviewBatches.length; index++) {
              const batch = reviewBatches[index]
              const key = fingerprint({ identity, batch: caseInputs(batch) })
              const batchScope = `${mode}:${batch.map((item) => item.id).join(',')}`
              const batchLabel = `${mode} 第 ${index + 1}/${reviewBatches.length} 批（${batch.map(item => item.id).join(',')}）`
              assessment = { ...assessment, caseReviews: assessment.caseReviews?.map(review => batch.some(item => item.id === review.caseId) ? { ...review, status: 'reviewing' } : review) }
              await saveAssessment()
              this.store.entry(task.id, 'info', `用例质量评审：第 ${index + 1}/${reviewBatches.length} 批；${batchLabel}`)
              const cached = await artifacts.lookup('review', batchScope, key)
              let content = cached?.output?.content
              if (content) consumedReviewArtifacts.push(cached!.id)
              if (content) {
                this.store.entry(task.id, 'info', `复用已完成评审批次 ${index + 1}/${reviewBatches.length}：${cached!.id}`)
                this.store.recordUsage(task.id, { sessionId: 'platform', artifactId: cached!.id, model: cached!.model, phase: 'review:reuse', sourceEventId: randomUUID(), observedAt: new Date().toISOString(), body: { counting: 'reuse', aggregation: 'platform-only', reusedArtifactId: cached!.id, requestsAvoided: 1 } })
              }
              else {
                const response = await sendPhase({ prompt: [
                  ...(mode === 'custom' ? [
                    '你是独立用例质量评审者。只读检查需求附件和用例设计，不读取测试文件、不修改文件、不运行命令。仅返回 JSON：{"findings":[{"code":"问题标识","category":"coverage|quality|executability|conflict|safety","message":"问题及需求或设计依据","caseIds":["本批TC编号"]}]}。无问题返回 {"findings":[]}，不得添加其他字段。',
                    '仅审查设计合理性，核对原始需求及已确认决策，不只依赖基线摘要。coverage（需求或场景覆盖不足）和 quality（弱断言、mock、恒真断言、映射或分类不完整）仅为警告，不阻止执行，也不得改报为阻断类别。只有设计本身无法判定预期结果或未定义必要前置条件属于 executability；与需求或已确认决策存在实际矛盾属于 conflict；不安全操作设计属于 safety，这三类阻断。不检查测试文件、预览 URL、runner 或实际环境是否存在或可用，这些由执行准备核对。检查预期、前置条件、数据、步骤、断言和清理，列出设计依据和受影响的本批用例。需求歧义使用 ask_user，不猜测；不得生成或修复用例。',
                  ] : [
                    '你是独立用例质量评审者。只读检查需求附件和用例设计，不读取测试文件、不修改文件、不运行命令。仅返回 JSON：{"qualified":true或false,"issues":[具体问题],"caseIssues":[{"caseId":"本批TC编号","message":"问题及需求或设计依据"}]}。',
                    '仅审查设计合理性，核对原始需求及已确认决策，不只依赖基线摘要。检查映射、真实业务断言设计、持久化及副作用、前置条件、数据、步骤、清理和操作安全性，不能只设计 mock 或恒真断言。不检查测试文件、预览 URL、runner 或实际环境是否存在或可用，不因缺少这些执行资源拒绝设计；脚本与设计一致性由执行准备核对。设计无法确认时拒绝；需求歧义使用 ask_user。通过时两列表为空，拒绝须列出设计依据和受影响用例。',
                  ]),
                  mode === 'custom' ? '只读评审本次选中用例，不要求覆盖未选需求。' : '全量结构及必验场景覆盖由平台检查，不要求本批覆盖其他批次需求。',
                  `用户目标：${task.instruction}`, `验收基线：${JSON.stringify(baseline)}`, `范围理由：${reason}`,
                  `完整用例索引（检查跨用例矛盾、重复及数据清理冲突）：${JSON.stringify(caseInputs(scope).map(({ id, title, requirementIds, scenario, preconditions, cleanup }) => ({ id, title, requirementIds, scenario, preconditions, cleanup })))}`,
                  `本批用例（${index + 1}/${reviewBatches.length}）：${JSON.stringify(caseInputs(batch))}`,
                ].join('\n'), attachments }, 120_000, 'review', batchScope, key, [baselineArtifact.id, definitions.id, snapshot, identity], (output) => {
                  const validated = mode === 'custom' ? applyExecutionReview(assessExecutionReadiness(baseline!, batch), output, batch.map(item => item.id)) : applyQualityReview(assessAcceptance(baseline!.map((item) => ({ ...item, required: false })), batch), output, batch.map((item) => item.id))
                  return { content: output, assessment: validated }
                }, [], `用例质量评审：${batchLabel}`)
                content = response!.data.content
                const completed = await artifacts.lookup('review', batchScope, key)
                if (!completed) throw new Error('质量评审批次缺少持久化产物')
                consumedReviewArtifacts.push(completed.id)
              }
              await verifySource()
              if (await workspaceFingerprint(workspace) !== snapshot) throw new Error('评审期间代码变化，旧批次结果不再适用；未允许执行')
              assessment = mode === 'custom' ? applyExecutionReview(assessment, content, batch.map(item => item.id)) : applyQualityReview(assessment, content, batch.map((item) => item.id))
              await saveAssessment()
              this.store.entry(task.id, 'info', `评审批次完成：${batchLabel}`)
            }
          }
          if (mode === 'custom' && canReview) assessment = applyExecutionReview(assessment, '{"findings":[]}', scope.map(item => item.id))
          const aggregate = await artifacts.start('review', `${mode}:aggregate`, identity, [baselineArtifact.id, definitions.id, snapshot, ...consumedReviewArtifacts], this.store.get(task.id)?.modelId || defaultModel())
          await artifacts.finish(aggregate.id, { status: 'complete', output: { assessment } })
          reviewedSnapshot = snapshot
          reviewArtifactId = aggregate.id
          await saveAssessment(true)
          return assessment
        }
        let needsAssessment = this.store.get(task.id)?.acceptanceAssessment?.status !== 'qualified'
        const previousPlanning = this.store.get(task.id)?.selfTestPlanningStatus
        const rejectionIssues = previousPlanning === 'generating' || previousPlanning === 'reviewing' ? [] : this.store.get(task.id)?.acceptanceAssessment?.issues || []
        let cases = [...(this.store.get(task.id)?.selfTests || [])]
        const initialSnapshot = await workspaceFingerprint(workspace)
        const evidenceIdentity = (item: SelfTestCase, snapshot: string) => fingerprint({ sourceIdentity, baseline, case: caseInputs([item]), executionBinding: item.executionBinding, workspace: snapshot, url: task.automationUrl, ...(shouldRunBrowserCase(item, task.automationUrl) ? { browserProtocol: browserPlanInstructions } : {}) })
        cases = cases.map((item) => item.status === 'passed' && item.evidenceInputFingerprint && item.evidenceInputFingerprint !== evidenceIdentity(item, initialSnapshot) ? { ...item, status: 'pending', output: '输入版本发生变化，历史通过证据已失效', evidenceInputFingerprint: undefined, executionResult: undefined } : item)
        this.store.update(task.id, { selfTests: cases })
        if (cases.some((item) => item.status === 'passed' && !item.evidenceInputFingerprint)) this.store.entry(task.id, 'warning', '保留旧任务的历史 passed 证据；该证据没有版本指纹，无法追溯认证代码版本')
        const priorReview = await artifacts.lookup('review', 'default:aggregate', reviewIdentity(cases, initialSnapshot, 'default'))
        if (intent !== 'execute' && !priorReview?.output?.assessment) needsAssessment = true
        if (priorReview?.output?.assessment?.status === 'qualified') { reviewedSnapshot = initialSnapshot; reviewArtifactId = priorReview.id }
        const selection = intent === 'execute' ? task.acceptanceSelection : undefined
        let executionPlan = createExecutionPlan(baseline, cases, selectedCaseIds, selection)
        const repairAssessment = this.store.get(task.id)?.acceptanceAssessment
        let draft = this.store.get(task.id)?.selfTestDraft
        if (intent === 'execute') {
          if (!cases.length || (selection && selection.caseIds.some((id) => !cases.some((item) => item.id === id)))) {
            this.store.update(task.id, { selfTestPlanningStatus: 'rejected' })
            this.store.status(task.id, 'REVIEW', '验收范围为空或用例已改变，执行已阻止；请重新确认')
            return
          }
          if (selection) {
            const scope = cases.filter((item) => selection.caseIds.includes(item.id))
            const assessment = await reviewCases(scope, 'custom', selection.reason)
            this.store.update(task.id, { executionAssessment: { ...assessment, caseIds: selection.caseIds } })
            if (!customReady(assessment)) {
              this.store.status(task.id, 'REVIEW', '本次选中用例存在执行阻断，未生成或修改用例；请查看评审问题')
              return
            }
            if (assessment.status === 'rejected') this.store.entry(task.id, 'warning', '本次范围可执行，但保留覆盖或质量警告；默认门禁结果不变', assessment.issues.join('\n'))
          } else if (needsAssessment || this.store.get(task.id)?.selfTestDraft) {
            this.store.update(task.id, { selfTestPlanningStatus: 'rejected' })
            this.store.status(task.id, 'REVIEW', '默认用例门禁未通过，执行已阻止；未重新生成或修正用例')
            return
          } else {
            const assessment = await reviewCases(cases, 'default')
            if (assessment.status !== 'qualified') { this.store.status(task.id, 'REVIEW', '已有用例只读评审未通过，未修改用例'); return }
          }
          needsAssessment = false
          draft = undefined
        }
        const currentAcceptance = this.store.get(task.id)!
        if (currentAcceptance.acceptanceAssessment?.status === 'rejected' && currentAcceptance.selfTests?.length) {
          this.store.update(task.id, { acceptanceHistory: [...(currentAcceptance.acceptanceHistory || []), { at: new Date().toISOString(), baseline: currentAcceptance.acceptanceBaseline, assessment: currentAcceptance.acceptanceAssessment, cases: currentAcceptance.selfTests, automationRuns: currentAcceptance.automationRuns || [] }] })
        }
        if (needsAssessment) this.store.update(task.id, { acceptanceAssessment: undefined, testExecutionPlan: undefined, executionAssessment: undefined })
        this.store.entry(task.id, 'info', intent === 'execute' ? `执行已有清单：${cases.length} 条；不重新生成或修正用例` : `按需求场景分批生成用例：每批最多 ${policy.batchSize} 条，总量安全上限 ${policy.maxCases} 条；已有 ${cases.length} 条`)
        const browserFailures = new Set<string>()
        for (let attempt = 0; attempt < 3; attempt++) {
          const targets = intent === 'execute' ? [] : cases.filter((item) => ['invalid', 'failed', 'skipped', 'running'].includes(item.status) && (needsAssessment || casePolicy(baseline!, item).gatePolicy === 'blocking') && !browserFailures.has(item.id))
          if (intent !== 'execute' && !needsAssessment && cases.length && !targets.length && !draft && !cases.some((item) => casePolicy(baseline!, item, selectedCaseIds.includes(item.id)).selected && (item.status === 'pending' || (item.status === 'manual' && (selectedCaseIds.includes(item.id) || shouldRunBrowserCase(item, task.automationUrl)) && !this.store.get(task.id)?.automationRuns?.some((run) => run.caseId === item.id))))) break
          if (intent !== 'execute' && (needsAssessment || targets.length || draft || !cases.length)) {
          if (attempt > 0) this.store.status(task.id, 'SELF_TEST', '正在定点修正未通过的自测用例')
          planningSelfTest = true
          const affectedIds = qualityRepairIds(repairAssessment, cases)
          const repairIds = cases.filter((item) => item.status !== 'passed' && (targets.some((target) => target.id === item.id) || (needsAssessment && affectedIds.includes(item.id)) || assessAcceptance(baseline!.map((requirement) => ({ ...requirement, required: false })), [item]).issues.length > 0)).map((item) => item.id)
          if (repairIds.length) this.store.update(task.id, { automationRuns: (this.store.get(task.id)?.automationRuns || []).filter((run) => !repairIds.includes(run.caseId)) })
          this.store.update(task.id, { selfTestPlanningStatus: 'generating' })
          cases = await generateTestBatches({
            baseline, previous: cases, repairIds, policy, instruction: task.instruction, testScript, context: recoveryContext, issues: rejectionIssues, draft,
            send: async (prompt, batch) => {
              const scope = `generation-request:${fingerprint(batch)}`
              const repairs = cases.filter((item) => batch.repairIds.includes(item.id) && item.status !== 'passed').flatMap((item) => item.testFile ? [item.testFile] : [])
              const partialFiles = this.store.get(task.id)!.selfTestArtifacts!.filter((item) => item.phase === 'generation' && item.scope === scope && item.inputRefs.includes(baselineArtifact.id)).flatMap((item) => item.output?.writtenFiles || [])
              return (await sendPhase({ prompt, attachments }, 20 * 60_000, 'generation', scope, fingerprint({ sourceIdentity, baseline, prompt, workspace: await workspaceFingerprint(workspace) }), [baselineArtifact.id], undefined, [...repairs, ...partialFiles]))?.data.content
            },
            save: async (saved, pendingDraft) => {
              const previousDefinitions = new Map((this.store.get(task.id)?.selfTests || []).map((item) => [item.id, fingerprint(caseInputs([item]))]))
              const changedDefinitions = saved.filter((item) => previousDefinitions.get(item.id) !== fingerprint(caseInputs([item])))
              if (!pendingDraft) await verifySource()
              this.store.update(task.id, { selfTests: [...saved], selfTestDraft: pendingDraft, selfTestError: undefined })
              await this.store.flush()
              if (!pendingDraft) {
                const request = this.store.get(task.id)!.selfTestArtifacts!.findLast((item) => item.phase === 'generation' && item.scope.startsWith('generation-request:'))
                const generated = await artifacts.start('generation', 'cases', fingerprint({ sourceIdentity, baseline, cases: caseInputs(saved), workspace: await workspaceFingerprint(workspace) }), [baselineArtifact.id, ...(request ? [request.id] : [])], this.store.get(task.id)?.modelId || defaultModel())
                await artifacts.finish(generated.id, { status: 'complete', output: { cases: structuredClone(changedDefinitions) } })
              }
            },
            log: (message) => this.store.entry(task.id, 'info', message),
          })
          draft = undefined
          this.store.update(task.id, { selfTestPlanningStatus: 'reviewing' })
          this.store.status(task.id, 'SELF_TEST', '用例验收：正在检查需求覆盖、适用场景与断言质量')
          planningSelfTest = true
          const assessment = await reviewCases(cases, 'default')
          this.store.update(task.id, { acceptanceAssessment: assessment, selfTestPlanningStatus: assessment.status })
          this.store.entry(task.id, assessment.status === 'qualified' ? 'info' : 'warning', `用例验收${assessment.status === 'qualified' ? '通过' : '未通过'}`, assessment.issues.join('\n'))
          if (assessment.status !== 'qualified') {
            this.store.status(task.id, 'REVIEW', '用例验收未通过，已阻止自动执行；请查看缺项并继续生成用例')
            return
          }
          planningSelfTest = false
          needsAssessment = false
          this.store.entry(task.id, 'info', `已保存 ${cases.length} 条自测用例`)
          }
          planningSelfTest = false
          executionPlan = createExecutionPlan(baseline, cases, selectedCaseIds, selection)
          await verifySource()
          const executionSnapshot = await workspaceFingerprint(workspace)
          if (!reviewedSnapshot || executionSnapshot !== reviewedSnapshot || !reviewArtifactId) throw new Error('代码版本缺少有效质量评审绑定，未允许执行')
          executionPlan = { ...executionPlan, inputFingerprint: fingerprint({ sourceIdentity, baseline, cases: caseInputs(cases), workspace: executionSnapshot }), artifactRefs: [baselineArtifact.id, reviewArtifactId] }
          this.store.update(task.id, { testExecutionPlan: executionPlan })
          this.store.entry(task.id, 'info', `执行计划：选中 ${executionPlan.cases.filter((item) => item.selected).length} 条，必验 ${executionPlan.cases.filter((item) => item.gatePolicy === 'blocking').length} 条，按需未选中 ${executionPlan.cases.filter((item) => !item.selected).length} 条`)
          this.store.entry(task.id, 'info', '执行准备核对文件安全、runner 可用性、支持的命令配置及脚本声明/断言结构；尚未实现脚本与用例设计的完整语义一致性验证，设计通过不代表执行通过')
          this.store.status(task.id, 'TEST_EXECUTION', '正在逐条自动执行可运行用例并记录测试证据')
          await this.store.flush()
        const executionTestScript = await supportedTestScript(workspace)
        for (let index = 0; index < cases.length; index++) {
          if (!executionPlan.cases.find((entry) => entry.caseId === cases[index].id)?.selected) continue
          if (cases[index].status === 'passed' && cases[index].evidenceInputFingerprint && cases[index].evidenceInputFingerprint !== evidenceIdentity(cases[index], executionSnapshot)) {
            cases[index] = { ...cases[index], status: 'pending', evidenceInputFingerprint: undefined, executionResult: undefined, output: '生成或修正后输入版本变化，历史通过证据已失效' }
            this.store.update(task.id, { selfTests: [...cases] })
          }
          const browserCase = !cases[index].executionBinding && shouldRunBrowserCase(cases[index], task.automationUrl)
          if (cases[index].status === 'passed' && !(intent === 'execute' && cases[index].executionBinding)) continue
          if (intent !== 'execute' && cases[index].status !== 'pending' && !((browserCase || selectedCaseIds.includes(cases[index].id)) && cases[index].status === 'manual' && !this.store.get(task.id)?.automationRuns?.some((run) => run.caseId === cases[index].id))) continue
          cases[index] = { ...cases[index], executionResult: undefined, evidenceInputFingerprint: undefined, startedAt: undefined, finishedAt: undefined }
          if (!cases[index].executionBinding) this.store.update(task.id, { automationRuns: (this.store.get(task.id)?.automationRuns || []).filter((run) => run.caseId !== cases[index].id || run.runner !== 'playwright-test') })
          if (browserCase) {
            const testCase = cases[index]
            try { localPreviewUrl(task.automationUrl!) }
            catch (error) {
              cases[index] = { ...testCase, status: 'skipped', output: `执行准备受阻：${error instanceof Error ? error.message : String(error)}` }
              this.store.update(task.id, { selfTests: [...cases] })
              continue
            }
            const runs = this.store.get(task.id)?.automationRuns || []
            const previousRun = runs.find((item) => item.caseId === testCase.id)
            const saveRun = (run: typeof runs[number]) => {
              this.store.update(task.id, { automationRuns: [...(this.store.get(task.id)?.automationRuns || []).filter((item) => item.caseId !== testCase.id), run] })
            }
            cases[index] = { ...testCase, status: 'running', startedAt: new Date().toISOString() }
            this.store.update(task.id, { selfTests: [...cases] })
            const browserIdentity = evidenceIdentity(testCase, executionSnapshot)
            let script = previousRun?.inputFingerprint === browserIdentity && (previousRun?.status === 'generating' || previousRun?.status === 'running') ? previousRun.script : (await artifacts.lookup('browser', `${testCase.id}:validated`, browserIdentity))?.output?.content
            try {
              if (!script) {
                saveRun({ caseId: testCase.id, status: 'generating', startedAt: cases[index].startedAt })
                planningSelfTest = true
                const generated = await generateBrowserPlan(async (feedback) => {
                  const response = await sendPhase({ prompt: [
                    '先只读检查工作目录中相关页面、路由与控件，不运行命令。必须逐项实现完整用例的验收断言，不能用文本存在替代键盘、属性或副作用验证；能力不足返回 capability，环境缺失返回 environment，凭据或权限缺失返回 authorization，真实参与者等不可自动化项目返回 manual，不确定返回 unknown。不得伪造结果，不得输出真实秘密。',
                    browserPlanInstructions,
                    `本机预览地址：${task.automationUrl}`, `用例：${JSON.stringify(caseInputs([testCase])[0])}`,
                    ...(feedback ? [`上一次脚本不合规：${feedback}。请修正格式，若用例无法用浏览器完成则返回 blocked。`] : []),
                  ].join('\n'), attachments }, 120_000, 'browser', testCase.id, fingerprint({ sourceIdentity, case: caseInputs([testCase]), url: task.automationUrl, feedback, protocol: browserPlanInstructions, workspace: await workspaceFingerprint(workspace) }), [baselineArtifact.id])
                  return response?.data.content
                })
                script = generated.content
              }
              planningSelfTest = false
              if (!script) throw new Error('Copilot 没有返回浏览器脚本')
              const plan = parseBrowserPlan(script)
              await verifySource()
              if (await workspaceFingerprint(workspace) !== executionSnapshot) throw new Error('浏览器规划期间代码发生变化，脚本版本失效')
              const browserArtifact = await artifacts.start('browser', `${testCase.id}:validated`, browserIdentity, [baselineArtifact.id, reviewArtifactId], this.store.get(task.id)?.modelId || defaultModel())
              await artifacts.finish(browserArtifact.id, { status: plan.kind === 'blocked' ? 'blocked' : 'complete', output: { content: script } })
              if (plan.kind === 'blocked') {
                saveRun({ caseId: testCase.id, status: 'blocked', output: plan.reason, reasonCode: plan.reasonCode, requiredCapabilities: plan.requiredCapabilities, protocolVersion: browserProtocolVersion, finishedAt: new Date().toISOString() })
                cases[index] = { ...testCase, status: 'manual', output: `执行准备受阻：浏览器环境无法验证：${plan.reason}` }
                this.store.update(task.id, { selfTests: [...cases] })
                this.store.entry(task.id, 'warning', `${testCase.id} 执行准备受阻（${plan.reasonCode}）`, plan.reason)
                continue
              }
              saveRun({ caseId: testCase.id, status: 'running', script, inputFingerprint: browserIdentity, startedAt: cases[index].startedAt })
              await this.store.flush()
              const run = await executeBrowserScript(task.automationUrl!, script, testCase, join(this.root, 'evidence', task.id))
              run.protocolVersion = browserProtocolVersion
              if (run.screenshot) {
                const path = join(this.root, 'evidence', task.id, run.screenshot)
                const bytes = await readFile(path)
                this.store.recordFile(task.id, { kind: 'evidence', storageKey: relative(this.root, path).split('\\').join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, metadata: { caseId: testCase.id } })
              }
              run.inputFingerprint = browserIdentity
              if (run.failureKind === 'browser') {
                run.status = 'blocked'
                run.reasonCode = 'environment'
                run.output = `执行准备受阻：${run.output}`
              }
              saveRun(run)
              cases[index] = { ...testCase, status: run.status === 'passed' ? 'passed' : run.status === 'blocked' ? 'manual' : 'failed', startedAt: run.startedAt, finishedAt: run.finishedAt, output: run.output }
              if (cases[index].status === 'passed') cases[index].evidenceInputFingerprint = evidenceIdentity(cases[index], executionSnapshot)
            } catch (error) {
              agentFailed = true
              if (error instanceof TaskStorageError) throw error
              planningSelfTest = false
              const message = error instanceof Error ? error.message : String(error)
              browserFailures.add(testCase.id)
              saveRun({ caseId: testCase.id, status: 'failed', failureKind: /脚本|JSON|步骤/.test(message) ? 'script' : 'browser', script, output: message, finishedAt: new Date().toISOString() })
              cases[index] = { ...testCase, status: 'failed', output: message }
            }
            this.store.update(task.id, { selfTests: [...cases] })
            if (cases[index].status === 'failed') browserFailures.add(testCase.id)
            this.store.entry(task.id, cases[index].status === 'passed' ? 'info' : 'warning', `${testCase.id} 浏览器自动化：${cases[index].status}`, cases[index].output)
            continue
          }
          if (!cases[index].testFile && !cases[index].executionBinding) {
            cases[index] = { ...cases[index], status: 'manual', output: '执行准备受阻：无可执行测试文件或浏览器预览地址，需人工验证；设计审查结果不变' }
            this.store.update(task.id, { selfTests: [...cases] })
            continue
          }
          cases[index] = { ...cases[index], status: 'running', startedAt: new Date().toISOString() }
          this.store.update(task.id, { selfTests: [...cases] })
          await this.store.flush()
          cases[index] = await executeTestCase(workspace, cases[index], executionTestScript)
          const structuredResult = cases[index].executionResult
          if (structuredResult) this.store.update(task.id, { automationRuns: [...(this.store.get(task.id)?.automationRuns || []).filter(run => run.caseId !== cases[index].id), { caseId: cases[index].id, runner: 'playwright-test', executionResult: structuredResult, status: structuredResult.status === 'passed' ? 'passed' : structuredResult.status === 'failed' ? 'failed' : structuredResult.status === 'blocked' ? 'blocked' : 'skipped', output: structuredResult.reason, startedAt: structuredResult.startedAt, finishedAt: structuredResult.finishedAt }] })
          if (cases[index].status === 'passed') cases[index].evidenceInputFingerprint = evidenceIdentity(cases[index], executionSnapshot)
          this.store.update(task.id, { selfTests: [...cases] })
          this.store.entry(task.id, cases[index].status === 'failed' ? 'warning' : 'info', `${cases[index].id} ${cases[index].title}：${cases[index].status}`, cases[index].output)
        }
          if (intent === 'execute' || !cases.some((item) => casePolicy(baseline!, item).gatePolicy === 'blocking' && ['invalid', 'failed', 'skipped'].includes(item.status))) break
        }
        planningSelfTest = false
        await verifySource()
        if (reviewedSnapshot && await workspaceFingerprint(workspace) !== reviewedSnapshot) throw new Error('执行期间代码发生变化，通过证据不能用于当前版本；请重新评审执行')
        this.store.update(task.id, { changes: taskChangeFiles(this.store.get(task.id)!, await changedFiles(workspace)) })
        this.store.update(task.id, { testExecutionPlan: executionPlan })
        const summary = executionSummary(cases, executionPlan)
        const allPassed = (selection ? customReady(this.store.get(task.id)?.executionAssessment) : this.store.get(task.id)?.acceptanceAssessment?.status === 'qualified') && summary.qualified && checks.every((check) => check.passed)
        if (summary.advisoryFailed || summary.advisoryUnverified) this.store.entry(task.id, 'warning', `补充验证：失败 ${summary.advisoryFailed} 条，未验证 ${summary.advisoryUnverified} 条（其中按需未选中 ${summary.notSelected} 条）；不计为通过，不阻断必验结论`)
        if (allPassed) {
          await agent.record('completed')
          agentCompleted = true
        }
        this.store.status(task.id, allPassed ? 'SUCCESS' : 'REVIEW', allPassed ? selection ? `按用户选择范围验收通过；未选中项不计为通过，默认门禁结果仍保留${this.store.get(task.id)?.executionAssessment?.status === 'rejected' ? '；覆盖或质量警告仍保留，不表示全量质量通过' : ''}` : '必验用例及工程检查通过，编码完成；补充验证结果单独保留' : '必验用例或工程检查未通过，或缺少必验项，请查看证据并决定是否继续修复')
      } catch (error) {
        agentFailed = true
        if (error instanceof TaskStorageError) throw error
        planningSelfTest = false
        const message = error instanceof Error ? error.message : String(error)
        const current = this.store.get(task.id)!
        const partialExecution = current.executionAssessment
        this.store.update(task.id, { ...(intent === 'execute' && task.acceptanceSelection && partialExecution && partialExecution.readiness === 'checking' ? { executionAssessment: { ...partialExecution, readiness: 'unknown', caseReviews: partialExecution.caseReviews?.map(review => review.status === 'reviewing' || review.status === 'unreviewed' ? { ...review, status: 'unknown' } : review) } } : {}) })
        if (intent !== 'execute' && current.acceptanceBaseline?.length && current.selfTestPlanningStatus !== 'qualified') {
          const assessment = assessAcceptance(current.acceptanceBaseline, current.selfTests || [])
          const partial = current.acceptanceAssessment
          this.store.update(task.id, { acceptanceAssessment: { ...assessment, ...(current.selfTestPlanningStatus === 'reviewing' && partial ? { findings: partial.findings, caseReviews: partial.caseReviews?.map(review => review.status === 'reviewing' || review.status === 'unreviewed' ? { ...review, status: 'unknown' as const } : review) } : {}), status: 'rejected', issues: [...new Set([...assessment.issues, ...(partial?.issues || []), message, '生成或质量评审未完成，禁止执行'])], caseIssues: [...(assessment.caseIssues || []), ...(partial?.caseIssues || [])] } })
        }
        this.store.update(task.id, { selfTestError: message, changes: taskChangeFiles(this.store.get(task.id)!, await changedFiles(workspace)) })
        this.store.status(task.id, 'REVIEW', `自测清单未能生成或执行：${message}`)
      }
    } catch (error) {
      agentFailed = true
      try { await this.store.flush() }
      catch {
        console.error('任务持久化失败，停止当前任务；请恢复存储后重启后台')
        if (session) await session.abort().catch(() => {})
        return
      }
      if (error instanceof SessionRestoreError) {
        this.store.update(task.id, { status: selfTestOnly ? 'REVIEW' : 'FAILED', sessionRestoreError: error.message, question: undefined, modelInTurn: false })
        this.store.entry(task.id, 'warning', error.message)
        return
      }
      if (error instanceof TaskStorageError) {
        console.error('任务持久化失败', error.message)
        try { this.store.update(task.id, { status: 'REVIEW', selfTestError: error.message, question: undefined, modelInTurn: false }) }
        catch { console.error('任务持久化恢复失败') }
        return
      }
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = rawMessage.includes('Session was not created with authentication info')
        ? 'Copilot 尚未登录。请在启动后台的环境中完成 Copilot CLI 登录或配置 COPILOT_GITHUB_TOKEN，然后重新创建任务。'
        : rawMessage
      this.store.entry(task.id, 'error', message)
      this.store.update(task.id, selfTestOnly
        ? { status: 'REVIEW', selfTestError: message, question: undefined, modelInTurn: false }
        : { status: 'FAILED', error: message, question: undefined, modelInTurn: false })
      if (session) await session.abort().catch(() => {})
    } finally {
      this.pending.delete(task.id)
      try { if (agentFailed || !agentCompleted) await agent.record(agentFailed ? 'failed' : 'completed') }
      catch { console.error('Agent execution audit could not be saved; check task storage.') }
      try { await this.store.flush() }
      catch { console.error('任务结束时未能落库，请恢复存储后重启后台') }
      if (session) await session.disconnect().catch(() => {})
      if (client) await client.stop().catch(() => {})
      for (const observer of usageObservers) {
        observer.dispose()
        try { await observer.flush() } catch { console.error('模型用量记录未完成，请检查存储状态') }
      }
      try { await this.store.release(task.id) } catch { console.error('任务缓存释放前未能落库') }
      this.running.delete(task.id)
    }
  }
}
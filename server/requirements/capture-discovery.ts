import type { Page } from 'playwright-core'
import type { RequirementCaptureDiscovery } from '../../shared/requirements.js'
import { requirementPreviewEntry, requirementPreviewPath } from '../../shared/requirement-preview.js'
import { normalizeCodeSnapshotText } from './code-snapshot.js'
import { RequirementDiagnosticError } from './diagnostics.js'
import type { WorkspaceSnapshot } from './workspace.js'

const fail = (message: string): never => { throw new RequirementDiagnosticError('output_validation', 'PAGE_MAPPING', `详情发现提案无效：${message}`) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('必须为对象')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail('文本长度或格式无效')
  return value
}
function labels(value: unknown, max: number, repeated = false): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) return fail('列表长度无效')
  const result = value.map(item => text(item, 120))
  if (!repeated && new Set(result).size !== result.length) return fail('列表内容重复')
  return result
}
export function parseCaptureDiscoveries(value: unknown): RequirementCaptureDiscovery[] {
  if (!Array.isArray(value) || !value.length || value.length > 4) return fail('每个区块仅支持 1 至 4 个详情视图')
  return value.map(value => {
    const item = record(value)
    if (Object.keys(item).some(key => !['fromPath', 'path', 'column', 'queryKeys', 'sourceId', 'quote', 'columnQuote', 'handler', 'tabs', 'expectedFields', 'expectedContent'].includes(key))) return fail('包含未知字段')
    const fromPath = requirementPreviewPath(item.fromPath), path = requirementPreviewPath(item.path)
    if (path.includes('?') || path === fromPath.split('?')[0]) return fail('目标必须为不同的详情 pathname，不得猜测参数值')
    const column = text(item.column, 120)
    if (/^(?:操作|操作项|动作|actions?|删除|修改|复制|新建|提交|保存)$/i.test(column.trim())) return fail('不能以业务操作列作为记录入口')
    const queryKeys = labels(item.queryKeys, 8)
    for (const key of queryKeys) requirementPreviewPath(`/?${new URLSearchParams({ [key]: 'sample' })}`)
    for (const key of new URLSearchParams(fromPath.split('?')[1]).keys()) {
      if (!queryKeys.includes(key)) return fail('详情必须保留已批准列表的查询上下文')
    }
    const handler = item.handler === undefined ? undefined : text(item.handler, 80)
    if (handler && !/^[A-Za-z_$][\w$]{0,79}$/.test(handler)) return fail('记录打开函数名无效')
    return {
      fromPath, path, column, queryKeys, sourceId: text(item.sourceId, 120),
      quote: text(item.quote, 2000), columnQuote: text(item.columnQuote, 2000),
      ...(handler ? { handler } : {}),
      ...(item.tabs === undefined ? {} : { tabs: labels(item.tabs, 3) }),
      ...(item.expectedFields === undefined ? {} : { expectedFields: labels(item.expectedFields, 80, true) }),
      ...(item.expectedContent === undefined ? {} : { expectedContent: labels(item.expectedContent, 80) }),
    }
  })
}
export function verifyCaptureDiscoveries(value: unknown, snapshots: WorkspaceSnapshot[], entries: readonly string[], basePath: string): RequirementCaptureDiscovery[] {
  const discoveries = parseCaptureDiscoveries(value)
  if (discoveries[0].fromPath !== basePath) return fail('首个列表入口必须与区块已批准入口一致')
  for (const item of discoveries) {
    if (!entries.includes(item.fromPath)) return fail('列表入口必须由用户明确提供')
    const source = snapshots.find(source => source.sourceId === item.sourceId)
    if (!source) return fail('源码来源不存在')
    const contains = (quote: string) => normalizeCodeSnapshotText(source.text).includes(normalizeCodeSnapshotText(quote))
    if (!contains(item.quote) || !contains(item.columnQuote) || !item.quote.includes(item.path) || !source.text.includes(item.fromPath.split('?')[0])) return fail('列表、详情路径或引用缺少源码依据')
    if (!item.columnQuote.includes(item.column) || !/<(?:a|Link|Typography\.Link)\b/.test(item.columnQuote)) return fail('记录列及链接渲染缺少源码依据')
    if (item.handler) {
      const name = item.handler.replace(/[$]/g, '\\$&')
      if (!new RegExp(`\\b(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`).test(item.quote) || !new RegExp(`\\b${name}\\s*\\(`).test(item.columnQuote)) return fail('记录链接与详情打开函数未建立源码关系')
    }
    for (const key of item.queryKeys) {
      if (![ `"${key}"`, `'${key}'`, `?${key}=`, `&${key}=` ].some(literal => item.quote.includes(literal))) return fail('详情参数必须在导航引用中出现')
    }
    for (const name of [...(item.tabs ?? []), ...(item.expectedFields ?? []), ...(item.expectedContent ?? [])]) {
      if (!snapshots.some(source => source.text.includes(name))) return fail('目标内容或列表页签缺少源码依据')
    }
  }
  return discoveries
}
export function captureDiscoveryPathMatches(discovery: RequirementCaptureDiscovery, value: string, origin: string): boolean {
  let path: string
  try { path = requirementPreviewEntry(value, origin) } catch { return false }
  const url = new URL(path, origin)
  if (url.pathname !== discovery.path) return false
  const keys = [...url.searchParams.keys()]
  if (keys.length !== discovery.queryKeys.length || discovery.queryKeys.some(key => !url.searchParams.has(key))) return false
  for (const key of discovery.queryKeys) {
    const constants = new Set([...discovery.quote.matchAll(new RegExp(`[?&]${key}=([A-Za-z0-9_.-]+)(?=['"\`&])`, 'g'))].map(match => match[1]))
    if (constants.size === 1 && !constants.has(url.searchParams.get(key)!)) return false
  }
  const parent = new URL(discovery.fromPath, origin)
  return [...parent.searchParams].every(([key, value]) => url.searchParams.get(key) === value)
}

export async function openDiscoveredRecord(page: Page, discovery: RequirementCaptureDiscovery, origin: string, signal: AbortSignal): Promise<string> {
  const failure = (code: string, message: string) => new RequirementDiagnosticError('output_validation', code, message)
  signal.throwIfAborted()
  const header = page.getByRole('columnheader', { name: discovery.column, exact: true }).filter({ visible: true })
  try { await header.first().waitFor({ state: 'visible', timeout: 5000 }) }
  catch { throw failure('PAGE_CAPTURE_DISCOVERY_COLUMN', '列表未显示源码确认的记录名称列；请检查列表页签、权限或表格加载状态') }
  if (await header.count() !== 1) throw failure('PAGE_CAPTURE_DISCOVERY_COLUMN', '存在多个同名记录列，无法唯一定位目标列表；未点击任意业务操作')
  const index = await header.evaluate(element => element instanceof HTMLTableCellElement ? element.cellIndex : -1)
  if (index < 0) throw failure('PAGE_CAPTURE_DISCOVERY_COLUMN', '暂不支持此列表的自定义表格布局；请提供真实详情入口')
  const antd = await header.evaluate(element => Boolean(element.closest('.ant-table')))
  const table = antd ? header.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-table ")][1]') : header.locator('xpath=ancestor::table[1]')
  const rows = table.locator('tbody > tr').filter({ visible: true })
  let anchor
  for (let row = 0; row < Math.min(await rows.count(), 20); row++) {
    const candidate = rows.nth(row).locator('td').nth(index).locator('a').filter({ visible: true }).filter({ hasText: /\S/ }).first()
    if (await candidate.count()) { anchor = candidate; break }
  }
  if (!anchor) throw failure('PAGE_CAPTURE_DISCOVERY_EMPTY', '列表中没有可打开的已有记录或缺少详情权限；未创建样例数据，请提供一条可访问的详情入口')
  if (await anchor.evaluate(element => Boolean(element.closest('form')) || element.getAttribute('aria-disabled') === 'true')) throw failure('PAGE_CAPTURE_DISCOVERY_TARGET', '记录入口位于表单内或不可用，未执行点击')
  const href = await anchor.getAttribute('href')
  if (href && !captureDiscoveryPathMatches(discovery, new URL(href, page.url()).href, origin)) throw failure('PAGE_CAPTURE_DISCOVERY_TARGET', '记录链接不符合已验证详情路径或项目上下文，未访问该地址')
  if (!href && !discovery.handler) throw failure('PAGE_CAPTURE_DISCOVERY_TARGET', '记录没有实际链接且缺少已验证的打开函数，未执行未知点击')
  try {
    await anchor.click({ timeout: 5000 })
    await page.waitForURL(url => captureDiscoveryPathMatches(discovery, url.href, origin), { timeout: 8000, waitUntil: 'domcontentloaded' })
    signal.throwIfAborted()
  } catch {
    signal.throwIfAborted()
    throw failure('PAGE_CAPTURE_DISCOVERY_TARGET', '未能从已有记录打开指定详情，可能无权限或跳转上下文不符；未猜测计划编号或使用列表截图替代')
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  return requirementPreviewEntry(page.url(), origin)
}

export const captureDiscoveryPolicy = 'DETAIL DISCOVERY: Missing record IDs are runtime data, not missing functional evidence. Before asking the user for IDs, inspect the approved list record-name column and its link renderer/navigation handler. Prefer discover:[{fromPath:"exact approved list entry",path:"source-backed detail pathname without values",column:"exact record-name table header",queryKeys:["ALL keys passed by the source navigation, including inherited project context"],sourceId:"source ID",quote:"exact navigation function or href source containing the detail pathname and query keys",columnQuote:"exact column definition including header and record link renderer",handler:"optional source-backed navigation function name; required for anchors without href",tabs:["optional list tabs to activate before opening a record"],expectedFields:["optional per-view inventory overriding page fields"],expectedContent:["optional per-view content"]}]. page.path must equal the first fromPath and page.quote must prove its list pathname. The platform selects an existing visible record from that exact column and obtains real values by clicking the rendered link, not by generating IDs. page.activate applies AFTER entering detail. Supply one discovery view per materially different branch, e.g. self/test plans with distinct list entries and fields; at most 4 per block and 12 captures total. The platform preserves each view with its own screenshot and actual URL. Do not select action/delete/copy/edit columns, create sample data, fill forms or request write operations. All list entries must be user-approved; detail path, column, handler, parameters and inventory need exact source evidence. Report an entry_context gap only if no approved list can reach the detail safely or source evidence is insufficient; do not demand hand-entered IDs merely because no detail URL was supplied.'

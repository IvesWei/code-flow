import type { PrdRequirement, StructuredPrd } from '../../../shared/requirements.js'
import { prdFunctionCode } from '../../../shared/prd-template.js'

export function dualPrdFixture(base: StructuredPrd): StructuredPrd {
  let fieldNumber = 0, criterionNumber = 0
  return {
    ...structuredClone(base), templateVersion: 2,
    blocks: base.blocks.map(block => {
      const { table: _table, ...rest } = structuredClone(block)
      return { ...rest, module: block.module || '样例模块' }
    }),
    requirements: base.requirements.map((requirement, index): PrdRequirement => {
      const suffix = String(index + 1).padStart(2, '0')
      return {
        ...structuredClone(requirement), scenario: requirement.scenario || '待确认', fields: structuredClone(requirement.fields || []),
        specification: {
          fields: (requirement.fields || []).map(field => ({ name: field.name, id: `FLD-${String(++fieldNumber).padStart(2, '0')}`, type: '待确认', required: '待确认', source: '待确认', options: [] })),
          transitions: [],
          rules: [{ id: `BR-${suffix}`, kind: '校验规则', business: '待确认：本功能的校验规则', detail: '待确认：校验细节', validation: '待确认', scope: '本功能' }],
          exceptions: [{ id: `EX-${suffix}`, condition: '待确认的异常', outcome: '待确认', dataImpact: '待确认' }],
          permissions: [{ id: `RM-${suffix}`, role: '待确认', operation: '待确认', availability: '待确认', scope: '待确认' }],
          criteria: requirement.acceptance.map(acceptance => ({ id: `AC-${String(++criterionNumber).padStart(2, '0')}`, acceptanceId: acceptance.id, given: '前置条件待确认', when: '触发本功能（待确认）', then: acceptance.text, example: '具体数值示例待确认', refs: [prdFunctionCode(index), `BR-${suffix}`, `EX-${suffix}`] })),
        },
      }
    }),
  }
}

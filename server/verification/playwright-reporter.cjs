const fs = require('node:fs')

class ExecutionReporter {
  constructor() {
    this.tests = []
    this.errors = 0
  }

  onError() { this.errors += 1 }

  onTestEnd(test, result) {
    const checks = []
    const visit = (step) => {
      const marker = /^\[assertion:([^\]]+)\]$/.exec(step.title)
      if (marker && step.category === 'test.step') {
        let expectCount = 0
        let failed = false
        let skipped = false
        const inspect = (child) => {
          if (child !== step && child.category === 'test.step' && /^\[assertion:/.test(child.title)) return
          if (child.category === 'expect' && child.steps.length === 0) expectCount += 1
          if (child.error) failed = true
          if ((child.annotations || []).some(annotation => annotation.type === 'skip')) skipped = true
          for (const descendant of child.steps) inspect(descendant)
        }
        inspect(step)
        checks.push({ id: marker[1], expectCount, failed, skipped })
      }
      for (const child of step.steps) visit(child)
    }
    for (const step of result.steps) visit(step)
    this.tests.push({
      file: test.location.file,
      titlePath: test.titlePath(),
      fullTitle: test.titlePath().slice(3).join(' '),
      project: test.parent.project().name,
      status: result.status,
      expectedStatus: test.expectedStatus,
      retry: result.retry,
      errorCount: result.errors.length,
      skipped: (test.annotations || []).some(annotation => annotation.type === 'skip'),
      checks,
    })
  }

  onEnd(result) {
    const output = process.env.CODEFLOW_PLAYWRIGHT_REPORT
    if (!output) throw new Error('Execution report destination missing')
    fs.writeFileSync(output, JSON.stringify({ version: 1, status: result.status, errors: this.errors, tests: this.tests }), { flag: 'wx' })
  }
}

module.exports = ExecutionReporter
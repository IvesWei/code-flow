import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { storedJson, taskState } from './contracts.js'
import { parseSqlScript } from './sql-script.js'

const schema = readFileSync(new URL('../../sql/mysql-schema.sql', import.meta.url), 'utf8')
const reset = readFileSync(new URL('../../sql/mysql-reset-v1-to-v2.sql', import.meta.url), 'utf8')
const expectedFields: Record<string, string[]> = {
  codeflow_schema: ['version', 'installed_at'],
  codeflow_tasks: ['id', 'owner_id', 'status', 'created_at', 'updated_at', 'row_version', 'body_version', 'state', 'next_event_seq', 'next_case_ordinal', 'next_run_seq', 'next_snapshot_seq'],
  codeflow_task_events: ['task_id', 'seq', 'created_at', 'kind', 'stage', 'turn_id', 'tool_call_id', 'body_version', 'body'],
  codeflow_self_test_artifacts: ['id', 'task_id', 'phase', 'scope', 'scope_hash', 'revision', 'status', 'input_fingerprint', 'rules_version', 'model', 'session_id', 'created_at', 'finished_at', 'body_version', 'output', 'error', 'input_refs'],
  codeflow_test_cases: ['task_id', 'case_id', 'ordinal', 'definition_revision', 'definition_fingerprint', 'body_version', 'definition', 'created_at', 'updated_at'],
  codeflow_case_runs: ['id', 'task_id', 'case_id', 'run_seq', 'definition_revision', 'input_fingerprint', 'execution_plan_id', 'review_artifact_id', 'executor', 'status', 'started_at', 'finished_at', 'body_version', 'body'],
  codeflow_acceptance_snapshots: ['id', 'task_id', 'seq', 'kind', 'created_at', 'input_fingerprint', 'body_version', 'body'],
  codeflow_task_files: ['id', 'task_id', 'kind', 'storage_key', 'storage_key_hash', 'sha256', 'size_bytes', 'created_at', 'body_version', 'metadata'],
  codeflow_model_usage: ['id', 'task_id', 'turn_id', 'session_id', 'artifact_id', 'model', 'phase', 'source_event_id', 'observed_at', 'body_version', 'body'],
}

function tables(sql: string) {
  return new Map([...sql.matchAll(/CREATE TABLE (codeflow_\w+) \(([\s\S]*?)\) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;/g)]
    .map(match => [match[1], match[2]]))
}

test('V2 contains exactly the nine planned InnoDB tables and exact field lists', () => {
  const actual = tables(schema)
  assert.deepEqual([...actual.keys()].sort(), Object.keys(expectedFields).sort())
  for (const [name, fields] of Object.entries(expectedFields)) {
    const columns = [...actual.get(name)!.matchAll(/^\s+(\w+) (?:VARCHAR|CHAR|BIGINT|SMALLINT|INT|DATETIME|MEDIUMTEXT|TEXT|JSON)\b/gm)].map(match => match[1])
    assert.deepEqual(columns, fields, name)
  }
  assert.doesNotMatch(actual.get('codeflow_tasks')!, /\bpayload\b/)
})

test('V2 uses planned types, positive counters, JSON shapes and separated task state', () => {
  for (const [name, ddl] of tables(schema)) {
    for (const column of ddl.split('\n').filter(line => /^\s+\w+ (?:VARCHAR|CHAR|BIGINT|SMALLINT|DATETIME|JSON)\b/.test(line))) {
      if (/\b(?:id|task_id|case_id|execution_plan_id|review_artifact_id|artifact_id) VARCHAR/.test(column)) {
        assert.match(column, /VARCHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin/, name)
      }
      if (/\bCHAR\(64\)/.test(column)) assert.match(column, /CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin/, name)
      if (/BIGINT|SMALLINT/.test(column)) assert.match(column, /UNSIGNED/, name)
      if (/DATETIME/.test(column)) assert.match(column, /DATETIME\(3\)/, name)
    }
    if (name !== 'codeflow_schema') assert.match(ddl, /body_version > 0/, name)
  }
  const task = tables(schema).get('codeflow_tasks')!
  for (const field of ['row_version', 'next_event_seq', 'next_case_ordinal', 'next_run_seq', 'next_snapshot_seq']) {
    assert.match(task, new RegExp(`${field} BIGINT UNSIGNED NOT NULL DEFAULT 1`))
    assert.ok(task.includes(`${field} > 0`))
  }
  assert.match(task, /JSON_TYPE\(state\) = 'OBJECT'/)
  for (const field of ['entries', 'selfTestArtifacts', 'selfTests', 'automationRuns', 'acceptanceHistory', 'acceptanceSelectionHistory', 'modelHistory', 'status', 'ownerId', 'createdAt', 'updatedAt', 'rowVersion']) {
    assert.ok(task.includes(`'$.${field}'`), field)
  }
  assert.match(schema, /CHECK \(status IN \('running', 'complete', 'failed', 'blocked'\)\)/)
  assert.match(schema, /JSON_TYPE\(input_refs\) = 'ARRAY'/)
  assert.match(schema, /CHECK \(kind IN \('baseline', 'default_review', 'scoped_review', 'execution_plan', 'selection', 'acceptance_history'\)\)/)
})

test('V2 cursor, reuse, ordering and deduplication indexes match the plan', () => {
  for (const index of [
    'KEY idx_tasks_owner_created (owner_id, created_at, id)',
    'KEY idx_tasks_status_updated (status, updated_at, id)',
    'PRIMARY KEY (task_id, seq)',
    'KEY idx_events_turn (task_id, turn_id, seq)',
    'KEY idx_events_created (task_id, created_at, seq)',
    'UNIQUE KEY uq_artifacts_revision (task_id, phase, scope_hash, revision)',
    'KEY idx_artifacts_reuse (task_id, phase, scope_hash, input_fingerprint, status, revision)',
    'PRIMARY KEY (task_id, case_id)',
    'UNIQUE KEY uq_cases_ordinal (task_id, ordinal)',
    'UNIQUE KEY uq_runs_attempt (task_id, case_id, run_seq)',
    'KEY idx_runs_status (task_id, status, run_seq)',
    'UNIQUE KEY uq_snapshots_seq (task_id, seq)',
    'KEY idx_snapshots_kind (task_id, kind, seq)',
    'UNIQUE KEY uq_files_storage_key (task_id, storage_key_hash)',
    'UNIQUE KEY uq_usage_source (task_id, session_id, source_event_id)',
    'KEY idx_usage_turn (task_id, turn_id)',
    'KEY idx_usage_model_time (model, observed_at)',
  ]) assert.ok(schema.includes(index), index)
})

test('V2 references enforce same-task ownership without cascading away evidence', () => {
  const foreignKeys = [...schema.matchAll(/FOREIGN KEY \(([^)]+)\) REFERENCES (\w+) \(([^)]+)\) ON DELETE RESTRICT ON UPDATE RESTRICT/g)]
  assert.equal(foreignKeys.length, 10)
  for (const reference of [
    'FOREIGN KEY (task_id, case_id) REFERENCES codeflow_test_cases (task_id, case_id)',
    'FOREIGN KEY (task_id, execution_plan_id) REFERENCES codeflow_acceptance_snapshots (task_id, id)',
    'FOREIGN KEY (task_id, review_artifact_id) REFERENCES codeflow_self_test_artifacts (task_id, id)',
    'FOREIGN KEY (task_id, artifact_id) REFERENCES codeflow_self_test_artifacts (task_id, id)',
  ]) assert.ok(schema.includes(reference), reference)
  assert.doesNotMatch(schema, /\bCASCADE\b|FOREIGN_KEY_CHECKS\s*=\s*0/i)
  const created = new Set<string>()
  for (const [name, ddl] of tables(schema)) {
    for (const reference of ddl.matchAll(/REFERENCES (\w+)/g)) assert.ok(created.has(reference[1]), name)
    created.add(name)
  }
})

test('fresh install rejects existing tables and marks version 2 only after all DDL', () => {
  assert.match(schema, /IF DATABASE\(\) IS NULL THEN\s+SIGNAL SQLSTATE '45000'/)
  const rejection = schema.indexOf("MESSAGE_TEXT = 'Fresh V2 install requires no existing CodeFlow tables'")
  assert.ok(rejection > 0 && rejection < schema.indexOf('CREATE TABLE codeflow_schema'))
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS|INSERT IGNORE|VALUES \(1\)/)
  assert.ok(schema.lastIndexOf('CREATE TABLE') < schema.indexOf('INSERT INTO codeflow_schema (version) VALUES (2);'))
  assert.match(schema, /INSERT INTO codeflow_schema \(version\) VALUES \(2\);\s+END\$\$/)
  assert.match(schema, /CALL codeflow_install_v2\(\)\$\$/)
})

test('empty V1 reset creates exactly the same V2 tables as fresh installation', () => {
  assert.deepEqual(tables(reset), tables(schema))
  assert.equal([...reset.matchAll(/^\s+CREATE TABLE /gm)].length, 9)
  assert.match(reset, /INSERT INTO codeflow_schema \(version\) VALUES \(2\);\s+END\$\$/)
})

test('nonempty V1 rejection and every preflight guard precede destructive table DDL', () => {
  const destructive = reset.indexOf('DROP TABLE')
  const guard = reset.match(/IF EXISTS \(SELECT 1 FROM codeflow_tasks LIMIT 1\) THEN\s+SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Nonempty V1 tasks:[^']*';\s+END IF;/)
  assert.ok(guard)
  assert.ok(guard.index! < destructive)
  for (const message of [
    'Select a database before resetting V1',
    'Reset requires existing V1 schema and tasks tables',
    'Reset requires exactly schema version 1',
    'Reset requires the V1 payload table, not partial V2',
    'Existing V2 child tables: inspect partial installation',
  ]) {
    const position = reset.indexOf(`MESSAGE_TEXT = '${message}'`)
    assert.ok(position >= 0 && position < destructive, message)
  }
  assert.match(reset, /IF \(SELECT COUNT\(\*\) FROM codeflow_schema\) <> 1\s+OR NOT EXISTS \(SELECT 1 FROM codeflow_schema WHERE version = 1\) THEN/)
  assert.match(reset, /column_name = 'payload' AND data_type = 'json'/)
  assert.deepEqual([...reset.matchAll(/DROP TABLE (\w+);/g)].map(match => match[1]), ['codeflow_tasks', 'codeflow_schema'])
})

test('reset guards and all table DDL stay inside one abortable procedure', () => {
  const procedure = reset.match(/CREATE PROCEDURE codeflow_reset_v1_to_v2\(\)\s+BEGIN([\s\S]+)END\$\$/)
  assert.ok(procedure)
  const outside = reset.replace(procedure[0], '').replace(/^--.*$/gm, '')
  assert.doesNotMatch(outside, /\b(?:CREATE TABLE|DROP TABLE|INSERT INTO)\b/i)
  assert.match(outside, /CALL codeflow_reset_v1_to_v2\(\)\$\$\s+DROP PROCEDURE codeflow_reset_v1_to_v2\$\$/)
  for (const sql of [schema, reset]) {
    const statements = sql.replace(/^--.*$/gm, '')
    assert.doesNotMatch(statements, /\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+DATABASE\b|\bFOREIGN_KEY_CHECKS\b|\bCONTINUE HANDLER\b|\bSOURCE\b/i)
    assert.match(sql, /DDL implicitly commits/)
    assert.match(sql, /SHOW CREATE TABLE/)
  }
})

test('Node SQL parser preserves procedure bodies and ignores delimiters in strings/comments', () => {
  for (const sql of [schema, reset]) {
    const statements = parseSqlScript(sql)
    assert.equal(statements.length, 3)
    assert.match(statements[0], /^CREATE PROCEDURE codeflow_\w+\(\)\s+BEGIN/)
    assert.match(statements[0], /INSERT INTO codeflow_schema \(version\) VALUES \(2\);\s+END$/)
    assert.match(statements[1], /^CALL codeflow_\w+\(\)$/)
    assert.match(statements[2], /^DROP PROCEDURE codeflow_\w+$/)
    assert.ok(statements.every(statement => !/^DELIMITER/m.test(statement)))
  }
  assert.deepEqual(parseSqlScript("-- ; ignored\nDELIMITER $$\nSELECT ';', '$$', 'it''s', `a$$`; /* $$ */ SELECT 2$$\nDELIMITER ;\nSELECT 3; # ;\n"), ["SELECT ';', '$$', 'it''s', `a$$`;   SELECT 2", 'SELECT 3'])
  assert.throws(() => parseSqlScript("SELECT 'unterminated;"), /Unterminated/)
  assert.throws(() => parseSqlScript('SELECT 1\nDELIMITER $$\n'), /unfinished/)
})

test('DDL supports repository JSON metadata, scope size and Unicode external keys within InnoDB index limits', () => {
  const state = JSON.parse(storedJson(taskState({ id: 'task', repository: 'repo', instruction: '', prdName: '', designNames: [], status: 'REVIEW', createdAt: '2026-10-15T00:00:00.123Z', updatedAt: '2026-10-15T00:00:00.123Z', entries: [] })))
  assert.ok(Array.isArray(state.__codeflow_keys))
  assert.equal(typeof state._collections, 'object')
  assert.equal(Array.isArray(JSON.parse(storedJson([{ kind: 'content_fingerprint', value: 'a'.repeat(64) }]))), true)
  for (const sql of [schema, reset]) {
    assert.match(sql, /scope MEDIUMTEXT NOT NULL/)
    assert.match(sql, /error MEDIUMTEXT NULL/)
    for (const key of ['tool_call_id', 'session_id', 'source_event_id']) assert.match(sql, new RegExp(`${key} VARCHAR\\(128\\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`))
    assert.ok(64 + 128 * 4 + 128 * 4 < 3072)
    assert.match(sql, /UNIQUE KEY uq_files_storage_key \(task_id, storage_key_hash\)/)
    assert.doesNotMatch(sql, /KEY \w+ \([^)]*\bscope\b|KEY \w+ \([^)]*\bstorage_key\b/)
  }
})

test('both installation paths declare verifier-compatible collations, defaults and identifier widths', () => {
  for (const sql of [schema, reset]) {
    let columnCount = 0
    for (const [name, ddl] of tables(sql)) {
      for (const line of ddl.split('\n')) {
        const field = /^\s+(\w+) (VARCHAR\(\d+\)|CHAR\(\d+\)|BIGINT|SMALLINT|INT|DATETIME\(3\)|MEDIUMTEXT|JSON)(\s.*)/.exec(line)
        if (!field) continue
        columnCount++
        const [, fieldName, type, options] = field
        const label = `${name}.${fieldName}`
        const external = ['tool_call_id', 'session_id', 'source_event_id'].includes(fieldName)
        const identity = ['id', 'task_id', 'case_id', 'turn_id', 'execution_plan_id', 'review_artifact_id', 'artifact_id'].includes(fieldName)
        if (external) {
          assert.equal(type, 'VARCHAR(128)', label)
          assert.match(options, /CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/, label)
        } else if (identity) {
          assert.equal(type, 'VARCHAR(64)', label)
          assert.match(options, /CHARACTER SET ascii COLLATE ascii_bin/, label)
        }
        if (type === 'JSON' || /^(?:BIGINT|SMALLINT|INT|DATETIME)/.test(type)) assert.doesNotMatch(options, /COLLATE|CHARACTER SET/, label)
        if (['scope', 'error', 'model', 'rules_version', 'storage_key'].includes(fieldName)) assert.doesNotMatch(options, /COLLATE|CHARACTER SET/, label)
        const counter = name === 'codeflow_tasks' && ['row_version', 'next_event_seq', 'next_case_ordinal', 'next_run_seq', 'next_snapshot_seq'].includes(fieldName)
        const expectedDefault = name === 'codeflow_schema' && fieldName === 'installed_at' ? 'CURRENT_TIMESTAMP(3)' : counter ? '1' : undefined
        assert.equal(/\bDEFAULT ([^,\s]+)/.exec(options)?.[1], expectedDefault, label)
      }
      for (const foreignKey of ddl.split('\n').filter(line => /FOREIGN KEY/.test(line))) {
        assert.match(foreignKey.trim(), /ON DELETE RESTRICT ON UPDATE RESTRICT,?$/, name)
      }
    }
    assert.equal(columnCount, 92)
  }
})
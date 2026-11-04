ALTER TABLE codeflow_testing_records
  DROP CHECK testing_status,
  ADD CONSTRAINT testing_status CHECK (
    (kind = 'package' AND version = 1 AND status = 'immutable' AND created_at = updated_at)
    OR (kind = 'project' AND status IN ('draft', 'running', 'needs_input', 'completed', 'failed', 'interrupted', 'cancelled'))
    OR (kind = 'execution' AND status IN ('draft', 'preparing', 'ready', 'running', 'passed', 'failed', 'incomplete', 'blocked', 'cancelled', 'interrupted'))
  );
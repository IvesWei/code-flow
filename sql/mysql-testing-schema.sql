CREATE TABLE codeflow_testing_records (
  kind VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  created_at VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  updated_at VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (kind, id),
  KEY testing_owned_list (kind, owner_id, created_at, id),
  KEY testing_recovery (kind, status, id),
  CONSTRAINT testing_kind CHECK (kind IN ('project', 'package', 'execution')),
  CONSTRAINT testing_owner CHECK (owner_id > 0),
  CONSTRAINT testing_version CHECK (version > 0),
  CONSTRAINT testing_status CHECK (
    (kind = 'package' AND version = 1 AND status = 'immutable' AND created_at = updated_at)
    OR (kind = 'project' AND status IN ('draft', 'running', 'needs_input', 'completed', 'failed', 'interrupted', 'cancelled'))
    OR (kind = 'execution' AND status IN ('draft', 'preparing', 'ready', 'running', 'passed', 'failed', 'incomplete', 'blocked', 'cancelled', 'interrupted'))
  )
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
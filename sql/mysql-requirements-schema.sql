CREATE TABLE IF NOT EXISTS codeflow_requirement_projects (
  id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id),
  KEY requirements_owned_list (owner_id, created_at, id),
  KEY requirements_recovery (status, id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS codeflow_requirement_conversation_events (
  owner_id BIGINT UNSIGNED NOT NULL,
  project_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  job_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  conversation_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sdk_session_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  sequence BIGINT UNSIGNED NOT NULL,
  request_index BIGINT UNSIGNED NOT NULL,
  created_at VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (project_id, job_id, conversation_id, sequence),
  KEY requirements_conversations_owned (owner_id, project_id, job_id, created_at),
  CONSTRAINT requirements_conversation_project FOREIGN KEY (project_id)
    REFERENCES codeflow_requirement_projects (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
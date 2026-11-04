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
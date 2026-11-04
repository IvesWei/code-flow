-- MySQL 5.7.35+ or 8.0.16+; MariaDB is not supported.
-- Select the database; use a mysql client supporting DELIMITER.
-- CHECK clauses are parsed but ignored on 5.7; application equivalent validation
-- does not protect direct SQL writes that bypass it. CHECK is enforced on 8.0.16+.
-- Existing V2 tables need no migration or DDL for runtime compatibility.
-- Empty V1 ONLY. Stop the API and ALL other writers, and back up before executing.
-- This does not clear task data or touch uploads/evidence/sessions/workspaces.
-- All guards and destructive table DDL are in ONE procedure: SIGNAL aborts it,
-- even if a client continues with subsequent top-level statements after an error.
-- DDL implicitly commits; this is NOT an atomic transaction and cannot roll back.
-- After interruption inspect SHOW TABLES, SHOW CREATE TABLE for every table and
-- SELECT * FROM codeflow_schema. Version 2 is written only after all nine tables.
-- Missing version 2 means incomplete installation: keep the API stopped. Restore
-- the full V1 backup or review partial DDL offline before explicitly rebuilding
-- an empty database. Never change version alone or blindly rerun after failure.
-- On failure the helper may remain; inspect it before manually removing it.

DELIMITER $$
CREATE PROCEDURE codeflow_reset_v1_to_v2()
BEGIN
    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Select a database before resetting V1';
    END IF;
    IF (
        SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
            AND table_name IN ('codeflow_schema', 'codeflow_tasks')
    ) <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Reset requires existing V1 schema and tasks tables';
    END IF;
    IF EXISTS (SELECT 1 FROM codeflow_tasks LIMIT 1) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Nonempty V1 tasks: reset refused; no task data was removed';
    END IF;
    IF (SELECT COUNT(*) FROM codeflow_schema) <> 1
        OR NOT EXISTS (SELECT 1 FROM codeflow_schema WHERE version = 1) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Reset requires exactly schema version 1';
    END IF;
    IF (
        SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'codeflow_tasks'
    ) <> 6 OR (
        SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'codeflow_tasks'
            AND column_name IN ('id', 'owner_id', 'status', 'created_at', 'updated_at', 'payload')
    ) <> 6 OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'codeflow_tasks'
            AND column_name = 'payload' AND data_type = 'json'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Reset requires the V1 payload table, not partial V2';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN (
            'codeflow_task_events', 'codeflow_self_test_artifacts', 'codeflow_test_cases',
            'codeflow_case_runs', 'codeflow_acceptance_snapshots',
            'codeflow_task_files', 'codeflow_model_usage'
        )
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Existing V2 child tables: inspect partial installation';
    END IF;

    DROP TABLE codeflow_tasks;
    DROP TABLE codeflow_schema;

    CREATE TABLE codeflow_schema (
        version INT NOT NULL PRIMARY KEY,
        installed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE codeflow_tasks (
        id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        owner_id BIGINT UNSIGNED NULL,
        status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        body_version SMALLINT UNSIGNED NOT NULL,
        state JSON NOT NULL,
        next_event_seq BIGINT UNSIGNED NOT NULL DEFAULT 1,
        next_case_ordinal BIGINT UNSIGNED NOT NULL DEFAULT 1,
        next_run_seq BIGINT UNSIGNED NOT NULL DEFAULT 1,
        next_snapshot_seq BIGINT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        KEY idx_tasks_owner_created (owner_id, created_at, id),
        KEY idx_tasks_status_updated (status, updated_at, id),
        CONSTRAINT chk_tasks_versions CHECK (row_version > 0 AND body_version > 0),
        CONSTRAINT chk_tasks_sequences CHECK (next_event_seq > 0 AND next_case_ordinal > 0 AND next_run_seq > 0 AND next_snapshot_seq > 0),
        CONSTRAINT chk_tasks_state CHECK (JSON_TYPE(state) = 'OBJECT'),
        CONSTRAINT chk_tasks_state_collections CHECK (JSON_CONTAINS_PATH(state, 'one', '$.entries', '$.selfTestArtifacts', '$.selfTests', '$.automationRuns', '$.acceptanceHistory', '$.acceptanceSelectionHistory', '$.modelHistory') = 0),
        CONSTRAINT chk_tasks_state_columns CHECK (JSON_CONTAINS_PATH(state, 'one', '$.id', '$.ownerId', '$.owner_id', '$.status', '$.createdAt', '$.created_at', '$.updatedAt', '$.updated_at', '$.rowVersion', '$.row_version') = 0)
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE codeflow_task_events (
        task_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        seq BIGINT UNSIGNED NOT NULL,
        created_at DATETIME(3) NOT NULL,
        kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        stage VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
        turn_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        tool_call_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
        body_version SMALLINT UNSIGNED NOT NULL,
        body JSON NOT NULL,
        PRIMARY KEY (task_id, seq),
        KEY idx_events_turn (task_id, turn_id, seq),
        KEY idx_events_created (task_id, created_at, seq),
        CONSTRAINT fk_events_task FOREIGN KEY (task_id) REFERENCES codeflow_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT chk_events_versions CHECK (seq > 0 AND body_version > 0),
        CONSTRAINT chk_events_body CHECK (JSON_TYPE(body) = 'OBJECT')
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE codeflow_self_test_artifacts (
        id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        task_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        scope MEDIUMTEXT NOT NULL,
        scope_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        revision BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        input_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        rules_version VARCHAR(64) NOT NULL,
        model VARCHAR(128) NOT NULL,
        session_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
        created_at DATETIME(3) NOT NULL,
        finished_at DATETIME(3) NULL,
        body_version SMALLINT UNSIGNED NOT NULL,
        output JSON NULL,
        error MEDIUMTEXT NULL,
        input_refs JSON NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_artifacts_task_id (task_id, id),
        UNIQUE KEY uq_artifacts_revision (task_id, phase, scope_hash, revision),
        KEY idx_artifacts_reuse (task_id, phase, scope_hash, input_fingerprint, status, revision),
        CONSTRAINT fk_artifacts_task FOREIGN KEY (task_id) REFERENCES codeflow_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT chk_artifacts_versions CHECK (revision > 0 AND body_version > 0),
        CONSTRAINT chk_artifacts_status CHECK (status IN ('running', 'complete', 'failed', 'blocked')),
        CONSTRAINT chk_artifacts_refs CHECK (JSON_TYPE(input_refs) = 'ARRAY')
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE codeflow_test_cases (
        task_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        case_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        ordinal BIGINT UNSIGNED NOT NULL,
        definition_revision BIGINT UNSIGNED NOT NULL,
        definition_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        body_version SMALLINT UNSIGNED NOT NULL,
        definition JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY (task_id, case_id),
        UNIQUE KEY uq_cases_ordinal (task_id, ordinal),
        CONSTRAINT fk_cases_task FOREIGN KEY (task_id) REFERENCES codeflow_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT chk_cases_versions CHECK (ordinal > 0 AND definition_revision > 0 AND body_version > 0),
        CONSTRAINT chk_cases_definition CHECK (JSON_TYPE(definition) = 'OBJECT')
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE codeflow_acceptance_snapshots (
        id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        task_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        seq BIGINT UNSIGNED NOT NULL,
        kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        created_at DATETIME(3) NOT NULL,
        input_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        body_version SMALLINT UNSIGNED NOT NULL,
        body JSON NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_snapshots_task_id (task_id, id),
        UNIQUE KEY uq_snapshots_seq (task_id, seq),
        KEY idx_snapshots_kind (task_id, kind, seq),
        CONSTRAINT fk_snapshots_task FOREIGN KEY (task_id) REFERENCES codeflow_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT chk_snapshots_versions CHECK (seq > 0 AND body_version > 0),
        CONSTRAINT chk_snapshots_kind CHECK (kind IN ('baseline', 'default_review', 'scoped_review', 'execution_plan', 'selection', 'acceptance_history')),
        CONSTRAINT chk_snapshots_body CHECK (JSON_TYPE(body) = 'OBJECT')
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE codeflow_case_runs (
        id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        task_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        case_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        run_seq BIGINT UNSIGNED NOT NULL,
        definition_revision BIGINT UNSIGNED NOT NULL,
        input_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        execution_plan_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        review_artifact_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        executor VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        started_at DATETIME(3) NULL,
        finished_at DATETIME(3) NULL,
        body_version SMALLINT UNSIGNED NOT NULL,
        body JSON NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_runs_attempt (task_id, case_id, run_seq),
        KEY idx_runs_status (task_id, status, run_seq),
        KEY idx_runs_plan (task_id, execution_plan_id),
        KEY idx_runs_review (task_id, review_artifact_id),
        CONSTRAINT fk_runs_case FOREIGN KEY (task_id, case_id) REFERENCES codeflow_test_cases (task_id, case_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT fk_runs_plan FOREIGN KEY (task_id, execution_plan_id) REFERENCES codeflow_acceptance_snapshots (task_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT fk_runs_review FOREIGN KEY (task_id, review_artifact_id) REFERENCES codeflow_self_test_artifacts (task_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT chk_runs_versions CHECK (run_seq > 0 AND definition_revision > 0 AND body_version > 0),
        CONSTRAINT chk_runs_body CHECK (JSON_TYPE(body) = 'OBJECT')
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE codeflow_task_files (
        id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        task_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        storage_key VARCHAR(512) NOT NULL,
        storage_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        size_bytes BIGINT UNSIGNED NULL,
        created_at DATETIME(3) NOT NULL,
        body_version SMALLINT UNSIGNED NOT NULL,
        metadata JSON NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_files_storage_key (task_id, storage_key_hash),
        CONSTRAINT fk_files_task FOREIGN KEY (task_id) REFERENCES codeflow_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT chk_files_version CHECK (body_version > 0),
        CONSTRAINT chk_files_kind CHECK (kind IN ('prd', 'design', 'evidence', 'test', 'session_manifest')),
        CONSTRAINT chk_files_metadata CHECK (JSON_TYPE(metadata) = 'OBJECT')
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE codeflow_model_usage (
        id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        task_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        turn_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        session_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        artifact_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        model VARCHAR(128) NOT NULL,
        phase VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        source_event_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        observed_at DATETIME(3) NOT NULL,
        body_version SMALLINT UNSIGNED NOT NULL,
        body JSON NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_usage_source (task_id, session_id, source_event_id),
        KEY idx_usage_turn (task_id, turn_id),
        KEY idx_usage_model_time (model, observed_at),
        KEY idx_usage_artifact (task_id, artifact_id),
        CONSTRAINT fk_usage_task FOREIGN KEY (task_id) REFERENCES codeflow_tasks (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT fk_usage_artifact FOREIGN KEY (task_id, artifact_id) REFERENCES codeflow_self_test_artifacts (task_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT chk_usage_version CHECK (body_version > 0),
        CONSTRAINT chk_usage_body CHECK (JSON_TYPE(body) = 'OBJECT')
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    INSERT INTO codeflow_schema (version) VALUES (2);
END$$
CALL codeflow_reset_v1_to_v2()$$
DROP PROCEDURE codeflow_reset_v1_to_v2$$
DELIMITER ;
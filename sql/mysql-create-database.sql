-- MySQL 5.7.35+ or 8.0.16+; MariaDB is not supported.
-- Run with a database administration account; existing V2 needs no DDL for compatibility.
-- Companion schema CHECK clauses are parsed but ignored on 5.7; application
-- equivalent validation does not protect direct SQL writes that bypass it.
-- Keep this database name consistent with DB_NAME in the backend environment.
-- No users are created and no existing tables or data are removed.

CREATE DATABASE IF NOT EXISTS `codeflow_test`
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

ALTER DATABASE `codeflow_test`
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE `codeflow_test`;

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME = 'codeflow_test';
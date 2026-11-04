export function executionEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(?:DB_|TASK_STORAGE$|CODEFLOW_ENV_FILE$)/i.test(entry[0])))
}
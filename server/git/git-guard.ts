export function prohibitedGitOperation(command: string): boolean {
  return /\bgit(?:\.exe)?\b[\s\S]{0,200}?\b(?:push|commit)\b/i.test(command) ||
    /\bgh(?:\.exe)?\s+pr\s+create\b/i.test(command)
}
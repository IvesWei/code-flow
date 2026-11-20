import { createHash } from 'node:crypto'

export function jsonDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function parseSqlScript(source: string): string[] {
  const statements: string[] = []
  let delimiter = ';', buffer = '', quote = '', lineComment = false, blockComment = false
  for (let index = 0; index < source.length;) {
    const character = source[index], next = source[index + 1]
    if (lineComment) {
      if (character === '\n') { lineComment = false; buffer += '\n' }
      index++; continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; buffer += ' '; index += 2 } else index++
      continue
    }
    if (quote) {
      buffer += character; index++
      if (character === '\\' && quote !== '`' && index < source.length) { buffer += source[index++]; continue }
      if (character === quote) {
        if (source[index] === quote) buffer += source[index++]
        else quote = ''
      }
      continue
    }
    if (index === 0 || source[index - 1] === '\n') {
      const directive = source.slice(index).match(/^[\t ]*DELIMITER[\t ]+(\S+)[\t ]*\r?(?:\n|$)/i)
      if (directive) {
        if (buffer.trim()) throw new Error('DELIMITER inside an unfinished SQL statement')
        delimiter = directive[1]; index += directive[0].length; continue
      }
    }
    if (character === '#' || (character === '-' && next === '-' && /\s/.test(source[index + 2] ?? ' '))) { lineComment = true; index += character === '#' ? 1 : 2; continue }
    if (character === '/' && next === '*') { blockComment = true; index += 2; continue }
    if (source.startsWith(delimiter, index)) {
      if (buffer.trim()) statements.push(buffer.trim())
      buffer = ''; index += delimiter.length; continue
    }
    if (character === "'" || character === '"' || character === '`') quote = character
    buffer += character; index++
  }
  if (quote || blockComment || buffer.trim()) throw new Error('Unterminated SQL script')
  return statements
}
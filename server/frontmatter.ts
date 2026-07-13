/**
 * The one YAML-frontmatter parser the server uses. Deliberately minimal — the
 * SDD artifacts only ever carry flat `key: scalar` lines (mirroring the Python
 * validator's read_frontmatter), so this is a line scanner, not a YAML engine.
 *
 * Values are returned RAW (inline comments and quotes preserved); a caller that
 * needs config semantics normalizes with stripComment/unquote.
 */

/** Top-level scalar keys of a leading `---` frontmatter block. */
export function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const out: Record<string, string> = {}
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

/** `[a, b]` or `a, b` → ['a', 'b']; quotes stripped per item. */
export function parseList(v: string | undefined): string[] {
  if (!v) return []
  let s = v.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  return s
    .split(',')
    .map((x) => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** Config-value normalization: drop an inline `# comment`, strip outer quotes. */
export function configValue(raw: string): string {
  return raw.replace(/#.*$/, '').trim().replace(/^["']|["']$/g, '')
}

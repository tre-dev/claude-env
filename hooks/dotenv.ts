/**
 * Pure helpers for /env: reading and rewriting dotenv text, telling a
 * placeholder from a value, masking secrets and parsing the command line.
 * No engine calls live here, so `bun test` covers them directly.
 */

/** What a variable may be called: the reader's grammar and the pane's. */
const KEY_NAME = '[A-Za-z_][A-Za-z0-9_.-]*'

const KEY_LINE = new RegExp(`^(\\s*(?:export\\s+)?)(${KEY_NAME})(\\s*=\\s*)(.*)$`)
const KEY_ONLY = new RegExp(`^${KEY_NAME}$`)

/**
 * Whether the name is one `entriesOf` reads back. The pane asks before it
 * writes, so it cannot save a key the reader misses and then append a second
 * line for it the next time round.
 */
export function isKeyName(name: string): boolean {
  return KEY_ONLY.test(name)
}

export type DotenvEntry = {
  key: string
  /** The value as dotenv would read it (quotes and inline comment removed). */
  value: string
}

/** One key line of a dotenv text, with the lines its value spans. */
type Row = {
  key: string
  /** What stands left of the key: indentation and `export `. */
  lead: string
  /** The raw value, lines joined with '\n' when a quote spans several. */
  raw: string
  /** Index of the line the key is on. */
  start: number
  /** Index of the last line the value spans; `start` unless it is multi-line. */
  end: number
  /** The '\r' of that last line, so a CRLF file keeps its endings. */
  cr: string
}

/** A line without the '\r' a CRLF file leaves on it. */
function dropCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** The quote a value opens with, or null when it is bare. */
function quoteOf(s: string): string | null {
  const q = s[0]

  return q === '"' || q === "'" || q === '`' ? q : null
}

/**
 * Every key line of a dotenv text, a quoted value that spans lines taken
 * whole, so a multi-line value (a PEM key) is one row and never half a line.
 * The '\r' a CRLF file leaves on a line is kept aside rather than read as
 * part of the value, so such a file survives a rewrite with its endings.
 */
function rowsOf(lines: string[]): Row[] {
  const rows: Row[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = dropCr(lines[i] as string)
    const m = KEY_LINE.exec(line)

    // A comment line never matches: only whitespace and `export ` may stand
    // before the name, so a leading `#` already fails `KEY_LINE`.
    if (!m) {
      continue
    }

    let raw = m[4] as string
    let end = i
    const opener = raw.trimStart()
    const q = quoteOf(opener)

    // A value spans lines only when a later line closes the quote and holds
    // nothing after it but whitespace or a comment. An opening quote that is
    // never closed that way is read bare, as dotenv reads it, so an
    // unterminated `A="abc` cannot swallow the `B="x"` below it and a rewrite
    // of A cannot delete B's line.
    if (q !== null && closingQuoteOf(opener, q) < 0) {
      let acc = raw

      for (let j = i + 1; j < lines.length; j++) {
        acc += '\n' + dropCr(lines[j] as string)

        const close = closingQuoteOf(acc.trimStart(), q)

        if (close > 0) {
          if (/^(\s+#.*)?\s*$/.test(acc.trimStart().slice(close + 1))) {
            raw = acc
            end = j
          }

          break
        }
      }
    }

    const last = lines[end] as string

    rows.push({ key: m[2] as string, lead: m[1] as string, raw, start: i, end, cr: last.endsWith('\r') ? '\r' : '' })
    i = end
  }

  return rows
}

/**
 * Reads the key/value lines of a dotenv text; comments and blanks are skipped,
 * a key set twice keeps its last value.
 */
export function entriesOf(text: string): DotenvEntry[] {
  return rowsOf(text.split('\n')).map(row => ({ key: row.key, value: unquote(row.raw) }))
}

/**
 * `entriesOf` folded into one record, last write wins. The record has no
 * prototype, so a file holding a key named `toString` reads back as that
 * key's value and not as an inherited function.
 */
export function valuesOf(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>

  for (const { key, value } of entriesOf(text)) {
    out[key] = value
  }

  return out
}

/** The escapes a double-quoted value spells out, as dotenv and Bun read them. */
const ESCAPED: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' }

/**
 * Takes the quotes off a dotenv value and drops an unquoted inline comment,
 * the way a loader reads one value. Only a double-quoted value spells out
 * escapes; inside single quotes and backticks every character is itself.
 */
export function unquote(raw: string): string {
  return splitRaw(raw).value
}

/**
 * Cuts a raw value where the value ends and its comment begins. `mergeDotenv`
 * rewrites a line as the new value plus the old comment while `entriesOf`
 * reads the value back, so both halves have to be cut at the same point;
 * taking them from one scan makes that so by construction rather than by two
 * scanners being kept in agreement.
 */
function splitRaw(raw: string): { value: string; comment: string } {
  const s = raw.trim()
  const q = quoteOf(s)

  if (q !== null && s.length >= 2) {
    const end = closingQuoteOf(s, q)

    if (end > 0) {
      const inner = s.slice(1, end)
      const rest = s.slice(end + 1)

      return {
        value: q === '"' ? inner.replace(/\\([\s\S])/g, (m, c: string) => ESCAPED[c] ?? m) : inner,
        comment: /^\s+#/.test(rest) ? rest : '',
      }
    }
  }

  const hash = s.search(/\s#/)

  return hash < 0 ? { value: s, comment: '' } : { value: s.slice(0, hash).trim(), comment: s.slice(hash) }
}

/** The index of the closing quote, skipping a backslash-escaped one. */
function closingQuoteOf(s: string, q: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\' && q === '"') {
      i++
      continue
    }

    if (s[i] === q) {
      return i
    }
  }

  return -1
}

/** The ` # comment` a raw value ends with, or ''. */
function commentOf(raw: string): string {
  return splitRaw(raw).comment
}

/** A value that needs no quotes: nothing in it expands, comments or splits. */
const BARE = /^[A-Za-z0-9_@%+=:,./{}\[\]-]+$/

/**
 * Writes a value so a loader reads it back verbatim: bare when it is plain,
 * otherwise in the first quote the value itself does not use. Single quotes
 * come first because nothing inside them expands or unescapes — a secret
 * holding a backslash, a `#` or a quote survives dotenv, dotenv-expand,
 * docker-compose and Bun only there.
 *
 * One character is beyond any single spelling: Bun's own loader expands `$`
 * inside every quote and wants it written `\$`, which dotenv would then read
 * back with the backslash. The literal form is written, the one the rest
 * read correctly, and `isExpandable` tells the pane to say so.
 *
 * A value holding all three quote characters cannot be written verbatim; it
 * is escaped in double quotes, which dotenv reads back only in part.
 */
export function quote(value: string): string {
  if (BARE.test(value)) {
    return value
  }

  if (!value.includes("'")) {
    return `'${value}'`
  }

  if (!value.includes('`')) {
    return `\`${value}\``
  }

  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')

  return `"${escaped}"`
}

/**
 * Whether a loader that expands would rewrite this value: a `$` before a name
 * or a brace. Written literally, as `quote` writes it, dotenv and
 * docker-compose read it back whole and Bun's loader does not.
 */
export function isExpandable(value: string): boolean {
  return /\$[A-Za-z_{]/.test(value)
}

/**
 * Whether the value leaves `quote` no spelling a loader reads back whole: it
 * holds all three quote characters, so the escaped double-quoted form is
 * the only one left and dotenv, dotenv-expand and Bun all keep its
 * backslashes. Only this file reads such a value back as it was written.
 */
export function isLossy(value: string): boolean {
  return value.includes("'") && value.includes('`') && /["\\]/.test(value)
}

const MARKER = /^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|<[^>]*>)$/

/** Whether the value is a placeholder rather than a real value. */
export function isMarker(value: string): boolean {
  return value === '' || MARKER.test(value)
}

/** Every key an example file declares, in order, each once. */
export function wantedOf(exampleText: string): string[] {
  return [...new Set(entriesOf(exampleText).map(entry => entry.key))]
}

export type Merge = {
  text: string
  /** Keys whose existing line was rewritten. */
  replaced: string[]
  /** Keys appended at the end. */
  appended: string[]
}

/**
 * Sets each key in `fills` in a dotenv text: the lines the key already has are
 * rewritten in place (its comment kept), a key the file lacks is appended.
 * Other lines are left byte for byte, line endings included.
 */
export function mergeDotenv(text: string, fills: Record<string, string>): Merge {
  const lines = text.split('\n')
  const replaced: string[] = []
  const done = new Set<string>()
  const out: string[] = []
  let i = 0

  for (const row of rowsOf(lines)) {
    // `in` would walk the prototype chain, so a file holding a key named
    // `toString` would hand `quote` an inherited function and throw.
    if (!Object.hasOwn(fills, row.key)) {
      continue
    }

    while (i < row.start) {
      out.push(lines[i++] as string)
    }

    out.push(`${row.lead}${row.key}=${quote(fills[row.key] as string)}${commentOf(row.raw)}${row.cr}`)

    if (!done.has(row.key)) {
      replaced.push(row.key)
    }

    done.add(row.key)
    i = row.end + 1
  }

  while (i < lines.length) {
    out.push(lines[i++] as string)
  }

  const appended = Object.keys(fills).filter(k => !done.has(k))
  const eol = text.includes('\r\n') ? '\r\n' : '\n'

  let merged = out.join('\n')

  if (appended.length > 0) {
    if (merged !== '' && !merged.endsWith('\n')) {
      merged += eol
    }

    merged += appended.map(k => `${k}=${quote(fills[k] as string)}`).join(eol) + eol
  }

  return { text: merged, replaced, appended }
}

// What the scanner calls a values file has to be exactly what the guard
// denies: a name the pane would write secrets into and the guard would let
// the model read is the one bug this file cannot afford. So the name grammar
// is written once and the guard reaches its verdict by calling `isTargetName`
// on what it finds, rather than by spelling the same rules a second time.
//
// Every one is case-blind, as the file systems this runs on are.

/** `.env`, `.env.local`, `.env.production`: a file that holds values. */
const TARGET_NAME = /^\.env(\.[A-Za-z0-9_-]+)*$/i
/** `.env.example`, `.env.template`, `.env.local.example`: a file that lists keys. */
const EXAMPLE_NAME = /^(\.env(\.[A-Za-z0-9_-]+)*)\.(example|template|sample)$/i

// The leading class is what a name may follow: anything that is not part of
// a name, so a redirect (`<` + the name) or a brace counts while
// `process.env` does not. The trailing one makes the match take the name
// whole, so a values file is judged as one and not as the example it happens
// to begin with.
/** Every dotenv file a path or a command names, whatever it turns out to be. */
// The trailing lookahead refuses a name character or a further `.segment`,
// but not a bare trailing `.`: NTFS opens `.env.` as `.env`.
const MENTION = /(^|[^A-Za-z0-9_.-])(\.env(?:\.[A-Za-z0-9_-]+)*)(?![\w-]|\.[\w-])/gi

/** Whether the file name lists keys rather than holding values. */
export function isExampleName(name: string): boolean {
  return EXAMPLE_NAME.test(name)
}

/** Whether the file name holds values, which only the person may see. */
export function isTargetName(name: string): boolean {
  return TARGET_NAME.test(name) && !EXAMPLE_NAME.test(name)
}

/** The values file an example names: `.env.local.example` belongs to `.env.local`. */
export function targetOfExample(name: string): string | null {
  return EXAMPLE_NAME.exec(name)?.[1] ?? null
}

/**
 * Whether a path or a command names a file holding values: each name it holds
 * is put to `isTargetName`, so a command naming only examples passes and the
 * guard cannot come to disagree with the scanner.
 *
 * A name inside a code span is prose about the file, not a use of it: a
 * command that greps this project's own documentation names it many times
 * over without reading it. Only the code span is excused, because it is the
 * one wrapper a shell cannot spell for a read -- backticks there substitute
 * a command, so `` `.env` `` would run the file, never open it. A quoted
 * word is not excused and cannot be: `cat ".env"` reads the file, and no
 * reading of the text alone tells it apart from a quoted mention.
 */
export function isSecretMention(text: string): boolean {
  return [...text.matchAll(MENTION)].some(m => isTargetName(m[2] as string) && !isCodeSpan(text, m))
}

/** Whether this match is a `` `.env` `` code span rather than a name in use. */
function isCodeSpan(text: string, m: RegExpMatchArray): boolean {
  const start = (m.index as number) + (m[1] as string).length
  const end = start + (m[2] as string).length

  return text[start - 1] === '`' && text[end] === '`'
}

/**
 * Whether the path stays inside the project, as the pane's message promises:
 * relative, no `..` segment, and nothing that is absolute on either kind of
 * host. The engine does not confine a path itself — "an absolute path is
 * used as given" — so this is the only thing between a typed path and a
 * secret written outside the project.
 */
export function isInsideProject(path: string): boolean {
  if (path === '' || path !== path.trim() || path.includes('\\')) {
    return false
  }

  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path)) {
    return false
  }

  return !path.split('/').includes('..')
}

/**
 * The typed path as the scan spells it: `./apps/x/.env` and `apps//x/.env`
 * are both `apps/x/.env`, so a file saved under one spelling is the site
 * found under the other. Checked with `isInsideProject` first — this drops
 * an empty leading segment, which would make an absolute path relative.
 */
export function projectPath(path: string): string {
  return path
    .split('/')
    .filter(segment => segment !== '' && segment !== '.')
    .join('/')
}

/**
 * A whole `KEY=value` line pasted into the Name field, split into its parts:
 * the name as `entriesOf` would read it (an `export ` dropped), the value as
 * a loader would (quotes and an inline comment removed). Null when the text
 * is not such a line, so ordinary typing of a name is left alone.
 */
export function splitAssignment(text: string): { name: string; value: string } | null {
  const m = KEY_LINE.exec(dropCr(text.trim()))

  if (!m) {
    return null
  }

  return { name: m[2] as string, value: unquote(m[4] as string) }
}

/** A secret hidden for the screen: only its length is told. */
export function mask(value: string): string {
  return `•••••••• (${value.length} chars)`
}

export const BULLET = '•'

/** The field's text while the secret is hidden: one bullet per character. */
export function bullets(secret: string): string {
  return BULLET.repeat(secret.length)
}

/**
 * The secret after an edit made while the field showed `bullets(secret)`:
 * the bullets that are still there stand for the characters they covered,
 * what follows them is typed anew. Typing at the end and Backspace are
 * tracked exactly; an edit in the middle keeps the leading part and takes
 * the rest as typed, which is the best a field that hands back only its
 * text allows.
 */
export function editMasked(secret: string, typed: string): string {
  let kept = 0

  while (kept < typed.length && kept < secret.length && typed[kept] === BULLET) {
    kept++
  }

  return secret.slice(0, kept) + typed.slice(kept).split(BULLET).join('')
}

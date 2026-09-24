import { describe, expect, test } from 'bun:test'

import {
  bullets,
  editMasked,
  entriesOf,
  isExampleName,
  isExpandable,
  isInsideProject,
  isKeyName,
  isLossy,
  isMarker,
  isSecretMention,
  isTargetName,
  mask,
  mergeDotenv,
  projectPath,
  quote,
  removeDotenv,
  splitAssignment,
  unquote,
  valuesOf,
  wantedOf,
} from '../hooks/dotenv'

describe('entriesOf', () => {
  test('reads keys, skips comments and blanks, last wins', () => {
    const text = `# c\nA=1\n\nexport B="two words" # note\nA=3\n# D=hidden\n`
    expect(entriesOf(text)).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two words' },
      { key: 'A', value: '3' },
    ])
  })
  test('a key named after a prototype member reads back as its value', () => {
    expect(valuesOf('toString=abc\n')['toString']).toBe('abc')
    expect(valuesOf('A=1\n')['toString']).toBeUndefined()
  })
  test('a quoted value spanning lines is one entry', () => {
    const text = `A="line1\nline2"\nB=2\n`
    expect(entriesOf(text)).toEqual([
      { key: 'A', value: 'line1\nline2' },
      { key: 'B', value: '2' },
    ])
  })
})

describe('unquote / quote', () => {
  test('round-trips awkward values', () => {
    const values = [
      'plain',
      'a b',
      'x#y',
      'say "hi"',
      'back\\slash',
      '{"a":"b"}',
      '5J...',
      '',
      'a\\nb',
      'C:\\new\\path',
      'pa$$word',
      '${HOME}',
      "it's",
      "it's a \\ mess",
      'two\nlines',
      'all three: \' " ` and a \\',
    ]

    for (const v of values) {
      expect(unquote(quote(v))).toBe(v)
    }
  })
  test('a value a loader would expand or unescape is single-quoted', () => {
    // Nothing expands or unescapes inside single quotes, in dotenv-expand,
    // Bun or docker-compose; inside double quotes all three would.
    expect(quote('pa$$word')).toBe("'pa$$word'")
    expect(quote('a${HOME}b')).toBe("'a${HOME}b'")
    expect(quote('C:\\new\\path')).toBe("'C:\\new\\path'")
    expect(quote('say "hi"')).toBe('\'say "hi"\'')
  })
  test('a value holding a single quote avoids double quotes too', () => {
    expect(quote("it's")).toBe('`it\'s`')
  })
  test('isExpandable spots what Bun would rewrite', () => {
    expect(isExpandable('pa$$word')).toBe(true)
    expect(isExpandable('a${HOME}b')).toBe(true)
    expect(isExpandable('costs 5$')).toBe(false)
    expect(isExpandable('sk-abc123')).toBe(false)
  })
  test('inline comment is dropped only when unquoted', () => {
    expect(unquote('v # c')).toBe('v')
    expect(unquote('"v # c"')).toBe('v # c')
  })
  test('an escaped backslash is not read as an escape', () => {
    expect(unquote('"a\\\\nb"')).toBe('a\\nb')
  })
})

describe('placeholders', () => {
  test('markers are placeholders, samples are not', () => {
    expect(isMarker('')).toBe(true)
    expect(isMarker('${OTHER}')).toBe(true)
    expect(isMarker('<your key>')).toBe(true)
    expect(isMarker('5K...')).toBe(false)
  })
  test('wantedOf lists each key once, in the order the example gives them', () => {
    expect(wantedOf('A=1\nB=${X}\nA=2\n')).toEqual(['A', 'B'])
  })
})

describe('isKeyName', () => {
  // The pane gates a typed name on this before it writes. A name it let
  // through that `entriesOf` did not read back would be written once and then
  // appended a second time on the next save, so the two share one grammar.
  test('takes exactly the names the reader reads back', () => {
    for (const name of ['A', '_x', 'POSTER_KEY', 'a.b', 'a-b', 'A1']) {
      expect([name, isKeyName(name)]).toEqual([name, true])
      expect(entriesOf(`${name}=v\n`)).toEqual([{ key: name, value: 'v' }])
    }
  })
  test('refuses what the reader would not find', () => {
    for (const name of ['', '1A', 'a b', 'a=b', '#a', 'a$b', ' A']) {
      expect([name, isKeyName(name)]).toEqual([name, false])
      expect(entriesOf(`${name}=v\n`).map(entry => entry.key)).not.toContain(name)
    }
  })
})

describe('mergeDotenv', () => {
  test('rewrites in place and appends the rest, keeping other lines', () => {
    const text = `# head\nA=\nB=keep\n`
    const { text: out, replaced, appended } = mergeDotenv(text, { A: 'x y', C: 'z' })
    expect(out).toBe(`# head\nA='x y'\nB=keep\nC=z\n`)
    expect(replaced).toEqual(['A'])
    expect(appended).toEqual(['C'])
  })
  test('an empty file gets just the lines', () => {
    expect(mergeDotenv('', { A: '1' }).text).toBe('A=1\n')
  })
  test('the line keeps its comment', () => {
    expect(mergeDotenv('A=1 # keep me\nB=2\n', { A: 'x' }).text).toBe('A=x # keep me\nB=2\n')
    expect(mergeDotenv('A="1" # keep me\n', { A: 'x y' }).text).toBe("A='x y' # keep me\n")
  })
  test('CRLF line endings survive a rewrite and an append', () => {
    expect(mergeDotenv('# head\r\nA=1\r\nB=2\r\n', { A: 'x', C: '3' }).text).toBe('# head\r\nA=x\r\nB=2\r\nC=3\r\n')
  })
  test('a value spanning lines is replaced whole, leaving no half line', () => {
    expect(mergeDotenv('A="line1\nline2"\nB=2\n', { A: 'x' }).text).toBe('A=x\nB=2\n')
  })
  test('a value spanning lines is left alone when another key is set', () => {
    expect(mergeDotenv('A="line1\nline2"\nB=2\n', { B: '3' }).text).toBe('A="line1\nline2"\nB=3\n')
  })
  test('a key named after a prototype member is a key like any other', () => {
    // `row.key in fills` was true for `toString`, which handed `quote` an
    // inherited function and threw, so no save into such a file went through.
    expect(mergeDotenv('toString=abc\nA=1\n', { A: 'x' }).text).toBe('toString=abc\nA=x\n')
    expect(mergeDotenv('constructor=abc\n', { valueOf: 'v' }).text).toBe('constructor=abc\nvalueOf=v\n')
    expect(mergeDotenv('toString=old\n', { toString: 'new' }).text).toBe('toString=new\n')
  })
})

describe('removeDotenv', () => {
  test('drops the key line and keeps every other line', () => {
    expect(removeDotenv('# head\nA=1 # note\nB=2\n', 'A')).toEqual({ text: '# head\nB=2\n', removed: true })
  })
  test('a missing key leaves the text as it was', () => {
    expect(removeDotenv('A=1\n', 'B')).toEqual({ text: 'A=1\n', removed: false })
  })
  test('every line of a key set twice goes, so no earlier value takes over', () => {
    expect(removeDotenv('A=1\nB=2\nexport A=3\n', 'A').text).toBe('B=2\n')
  })
  test('a value spanning lines goes whole', () => {
    expect(removeDotenv('A="line1\nline2"\nB=2\n', 'A').text).toBe('B=2\n')
  })
  test('CRLF endings and a last line without one survive', () => {
    expect(removeDotenv('A=1\r\nB=2\r\nC=3', 'B').text).toBe('A=1\r\nC=3')
    expect(removeDotenv('A=1\r\nB=2', 'B').text).toBe('A=1')
  })
  test('the only key leaves an empty file', () => {
    expect(removeDotenv('A=1\n', 'A').text).toBe('')
  })
  test('a comment naming the key is not a key line', () => {
    expect(removeDotenv('# A=old\nA=1\n', 'A').text).toBe('# A=old\n')
  })
})

describe('isSecretMention', () => {
  test('catches the file wherever it is named', () => {
    for (const text of [
      '.env',
      'cat .env',
      'cat /a/b/.env.local',
      'cat<.env',
      'while read l; do :; done <.env',
      'cat {.env,foo}',
      'rm -- .env.production',
      'cat .ENV',
      'cat .Env.Local',
    ]) {
      expect(isSecretMention(text)).toBe(true)
    }
  })
  test('lets the examples and ordinary env words through', () => {
    for (const text of [
      'cat .env.example',
      'cp .env.example /tmp/x.example',
      'cat .env.template',
      'grep process.env src/index.ts',
      'echo $NODE_ENV',
      'cat environment.yml',
      'cat my.envrc',
    ]) {
      expect(isSecretMention(text)).toBe(false)
    }
  })
  test('prose in a code span is not a use of the file', () => {
    for (const text of [
      'grep -n \'`.env`\' README.md',
      'the mod lists every `.env` file in the project',
      'sed -i s/x/y/ README.md  # mentions `.env.local` only',
    ]) {
      expect(isSecretMention(text)).toBe(false)
    }
  })
  test('a quoted word is still a use: the text cannot tell it apart', () => {
    for (const text of ['cat ".env"', "cat '.env'", 'sh -c "cat .env"']) {
      expect(isSecretMention(text)).toBe(true)
    }
  })
  test('a half-open span is not a span', () => {
    expect(isSecretMention('cat `.env')).toBe(true)
    expect(isSecretMention('cat .env`')).toBe(true)
  })
  test('the example is not a way in', () => {
    expect(isSecretMention('cp .env .env.example')).toBe(true)
    expect(isSecretMention('cat .env.example .env')).toBe(true)
  })
})

describe('the scanner and the guard agree', () => {
  // Every name the pane would write a secret into has to be one the guard
  // denies; the two used to disagree over case and over a suffix in the
  // middle, which left a file writable by the pane and readable by the model.
  const names = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.Local',
    '.ENV',
    '.env.example',
    '.env.Example',
    '.env.EXAMPLE',
    '.env.template',
    '.env.sample',
    '.env.local.example',
    '.env.example.local',
    '.env.sample.prod',
  ]

  test('a file the pane writes into is a file the model cannot read', () => {
    for (const name of names) {
      if (isTargetName(name)) {
        expect([name, isSecretMention(`Read /project/${name}`)]).toEqual([name, true])
      }
    }
  })
  test('a file the model may read is never one the pane writes into', () => {
    for (const name of names) {
      if (!isSecretMention(`Read /project/${name}`)) {
        expect([name, isExampleName(name)]).toEqual([name, true])
      }
    }
  })
  test('the two names are exclusive and cover the examples', () => {
    expect(isExampleName('.env.Example')).toBe(true)
    expect(isTargetName('.env.Example')).toBe(false)
    expect(isTargetName('.env.example.local')).toBe(true)
    expect(isExampleName('.env.example.local')).toBe(false)
  })
})

describe('isInsideProject', () => {
  test('takes a path inside the project', () => {
    for (const path of ['.env', 'apps/api/.env', 'My App/.env', 'a..b/.env', '.github/.env']) {
      expect([path, isInsideProject(path)]).toEqual([path, true])
    }
  })
  test('refuses what would leave it, on either kind of host', () => {
    for (const path of [
      '',
      ' ',
      ' .env',
      '/etc/passwd',
      '/.env',
      '../.env',
      'a/../.env',
      '..',
      '~/.env',
      '~',
      'C:\\secrets\\.env',
      '..\\..\\.env',
      'apps\\api\\.env',
    ]) {
      expect([path, isInsideProject(path)]).toEqual([path, false])
    }
  })
})

describe('projectPath', () => {
  test('spells a typed path the way the scan does', () => {
    expect(projectPath('./apps/x/.env')).toBe('apps/x/.env')
    expect(projectPath('apps//x/.env')).toBe('apps/x/.env')
    expect(projectPath('./.env')).toBe('.env')
    expect(projectPath('apps/x/')).toBe('apps/x')
    expect(projectPath('.env')).toBe('.env')
  })
})

describe('isLossy', () => {
  test('spots the value no dotenv spelling writes whole', () => {
    expect(isLossy('a\'b`c"d')).toBe(true)
    expect(isLossy('a\'b`c\\d')).toBe(true)
    expect(isLossy('a\'b`c')).toBe(false)
    expect(isLossy('say "hi"')).toBe(false)
    expect(isLossy("it's")).toBe(false)
  })
})

describe('mask', () => {
  test('tells only the length', () => {
    expect(mask('abc')).toBe('•••••••• (3 chars)')
    expect(mask('5Kabcdefgh9z')).toBe('•••••••• (12 chars)')
  })
})

describe('editMasked', () => {
  test('typing at the end appends', () => {
    expect(editMasked('abc', bullets('abc') + 'd')).toBe('abcd')
    expect(editMasked('', 'x')).toBe('x')
  })
  test('Backspace removes from the end', () => {
    expect(editMasked('abcd', bullets('abc'))).toBe('abc')
    expect(editMasked('abcd', '')).toBe('')
  })
  test('a paste over the whole field replaces it', () => {
    expect(editMasked('abc', 'new value')).toBe('new value')
  })
  test('an edit in the middle keeps the part before it', () => {
    expect(editMasked('abcd', '••X••')).toBe('abX')
  })
})

describe('an unterminated quote', () => {
  test('is read bare and does not swallow the keys below it', () => {
    const text = 'A="abc\nB="x"\nC=1\n'
    expect(entriesOf(text)).toEqual([
      { key: 'A', value: '"abc' },
      { key: 'B', value: 'x' },
      { key: 'C', value: '1' },
    ])
    expect(mergeDotenv(text, { A: 'new' }).text).toBe('A=new\nB="x"\nC=1\n')
  })
  test('a real multi-line value may end with a comment', () => {
    expect(entriesOf('A="l1\nl2" # c\nB=2\n')).toEqual([
      { key: 'A', value: 'l1\nl2' },
      { key: 'B', value: '2' },
    ])
  })
})

describe('isSecretMention on Windows aliases', () => {
  test('a trailing dot still names the file', () => {
    expect(isSecretMention('cat .env.')).toBe(true)
    expect(isSecretMention('Read C:\\proj\\.env.')).toBe(true)
    expect(isSecretMention('cat .env.example')).toBe(false)
    expect(isSecretMention('cat .env.example.')).toBe(false)
  })
})

describe('splitAssignment', () => {
  test('splits a pasted line at the first =', () => {
    expect(splitAssignment('DATA_DIR=/srv/app data/a=b')).toEqual({ name: 'DATA_DIR', value: '/srv/app data/a=b' })
    expect(splitAssignment('export KEY="x y"\n')).toEqual({ name: 'KEY', value: 'x y' })
    expect(splitAssignment('KEY=')).toEqual({ name: 'KEY', value: '' })
  })
  test('leaves a plain name alone', () => {
    expect(splitAssignment('KEY')).toBeNull()
    expect(splitAssignment('')).toBeNull()
    expect(splitAssignment('1KEY=v')).toBeNull()
  })
})

import type { Elements, EngineInterface, FsEntry, On, ProcessRunResult, RenderElement } from 'claude-code'

import {
  bullets,
  editMasked,
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
  removeDotenv,
  splitAssignment,
  targetOfExample,
  valuesOf,
  wantedOf,
} from './dotenv'

// Every function that takes the engine takes `host`, a table of closures over
// the `$` its hook was handed, as `claude plugin validate` requires `$` to be
// spelled `$.noun.event(...)` at the call site.

const COMMAND_NAME = 'env'
const PANE_ID = 'env'
const PANE_ROWS = 30

/** Long enough for the redraw an `invalidate` asks for to have happened. */
const FRAME_MS = 32

/** How deep below the working directory env files are looked for. */
const SCAN_DEPTH = 4
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.venv', 'target', 'coverage'])

// `glob` is here for a content search that takes a directory as its `path`
// and picks the files with a pattern: the values file is named there and
// nowhere else. A `pattern` is not read: for a search it is the text looked
// for, not the file, and denying a search for the word would deny the
// project's own source.
/** The fields a tool call names a file or a command in, in the order read. */
const TARGET_FIELDS = ['file_path', 'notebook_path', 'path', 'glob', 'command'] as const

/** The engine as a hook was handed it: each member one call on `$`. */
type Host = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path?: string) => Promise<FsEntry[]>
  run: (argv: readonly string[]) => Promise<ProcessRunResult>
  openPane: () => Promise<void>
  closePane: () => Promise<void>
  focus: (key: string) => Promise<unknown>
  sleep: (ms: number) => Promise<void>
  invalidate: () => void
  toast: (text: string) => void
  log: (text: string) => void
}

/**
 * The engine bound for this hook. Built per dispatch rather than kept in a
 * module, so no hook has to ask whether `session.start` has run yet.
 */
function hostOf($: EngineInterface): Host {
  return {
    exists: path => $.fs.exists(path),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path),
    run: argv => $.process.run(argv, { timeoutMs: 5000 }),
    openPane: () =>
      $.ui.open({ id: PANE_ID, title: '.env', focus: true, closeOnEscape: true, holdToasts: true, rows: PANE_ROWS }),
    closePane: () => $.ui.close({ id: PANE_ID }),
    focus: key => $.ui.focus({ requestId: PANE_ID, key }),
    sleep: ms => $.clock.sleep(ms),
    invalidate: () => $.ui.invalidate('ui.render'),
    toast: text => $.ui.toast(text, { timeoutMs: 8000 }),
    log: text => $.ui.log(text),
  }
}

/** One env file of the project: where values go, and the example that names its keys. */
type Site = {
  /** The values file, relative to the working directory (`apps/api/.env`). */
  target: string
  /** The example beside it, or null when the target stands alone. */
  example: string | null
  /** Whether the target exists yet. */
  isPresent: boolean
  /**
   * The keys the example lists (or the target holds), with the value when
   * set, and whether the target has a line for the key at all (a placeholder
   * counts): the lines Delete removes.
   */
  keys: { key: string; value: string | undefined; isInFile: boolean }[]
}

/** What the pane shows and holds between keystrokes. */
type Model = {
  sites: Site[]
  /**
   * The file a save writes to, relative to the working directory. A path
   * rather than an index into `sites`, so a rescan cannot move the selection
   * to another file.
   */
  target: string
  /** Whether `target` is a path being typed rather than one of `sites`. */
  isTyped: boolean
  name: string
  secret: string
  /**
   * Bumped whenever the hook sets Name or Secret itself. It is part of those
   * fields' keys, so the engine drops what was typed into them and draws the
   * model's text instead; without it a field cleared to the empty string it
   * was last drawn with keeps the secret on screen.
   */
  epoch: number
  note: string
  /** Whether the Secret field shows its text rather than one bullet per character. */
  showSecret: boolean
  /** The listed keys whose value is shown in clear. */
  shown: string[]
  /**
   * The press waiting for a Yes: '' for none, REVEAL_ALL, or the key a
   * Delete was pressed on.
   */
  confirming: string
}

/** `confirming` for Reveal all; never a key name, as a key has no space. */
const REVEAL_ALL = 'reveal all'

/** The cells `[ Reveal all values ]` takes, the widest of its labels and of `Sure? [ Yes ] [ No ]`. */
const REVEAL_COLUMNS = '[ Reveal all values ]'.length

/**
 * The picker's row for a file that is not there yet. A site's target is a
 * project-relative path, so a leading `/` keeps this apart from every one of
 * them; a control character would, too, but the engine refuses one in an
 * option value from 2.1.278 on and draws an empty pane instead.
 */
const NEW_FILE = '/new'

let model: Model = { sites: [], target: '', isTyped: false, name: '', secret: '', epoch: 0, note: '', showSecret: false, shown: [], confirming: '' }

const nameKey = (epoch: number) => `name:${epoch}`

/**
 * Registers `/env`: a pane listing every env file of the project, where the
 * person picks one and types a name and a secret that are written into it
 * without ever entering the transcript; and a guard that keeps the model out
 * of those files.
 *
 * @param on the engine's registrar
 */
export function register(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND_NAME,
        description: "The project's .env files in a pane; enter secrets there, the model never sees them",
      })
    } catch (error) {
      $.ui.log(`/env could not register: ${messageOf(error)}`)
    }

    if (e.isInteractive) {
      void nudge(hostOf($)).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND_NAME }, async $ => {
    const engine = hostOf($)

    await refresh(engine)
    model = { ...model, note: '' }

    try {
      await engine.openPane()
    } catch (error) {
      return { text: `The .env pane could not open: ${messageOf(error)}` }
    }

    const n = model.sites.length

    return { text: `.env pane opened with ${n} file${n === 1 ? '' : 's'}. Values entered there stay out of the transcript.` }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)

    if (result.deny === undefined) {
      model = { ...model, secret: '', epoch: model.epoch + 1, showSecret: false, shown: [], confirming: '' }
    }

    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    // The terminal and the desktop app both have Input and Select; the mobile
    // app has neither, so there the engine draws its default.
    if (e.requestId !== PANE_ID || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }

    // `resolve` returns a promise from 2.1.278 on; `await` also takes the
    // table an older build hands back directly.
    return paneView(hostOf($), await $.ui.resolve(e), e.props.bodyColumns)
  })

  // No tool matcher on purpose. A list has to be right about which tools a
  // build has and what each is called: the reads, the shells, and the writes
  // too, as a write answers with the file as it was and so reads the secrets
  // out as well as overwriting them. A tool left off the list is a way in,
  // and the list cannot cover the MCP tools of a session it never saw. What
  // every one of them has in common is the field it names a file or a
  // command in, so the fields are what this reads.
  on('tool.call', async ($, e, next) => {
    const target = targetsOf(e).find(isSecretMention)

    if (target !== undefined) {
      return {
        deny:
          `claude-env: ${target.length > 80 ? 'that call' : target} touches a .env file. ` +
          'The person manages these values with /env; use the .env.example for the key names instead.',
      }
    }

    return next(e)
  })
}

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Input' | 'Button' | 'Select'>

/** The site the picker is on, or undefined while a path is being typed. */
function selectedSite(): Site | undefined {
  return model.isTyped ? undefined : model.sites.find(s => s.target === model.target)
}

function paneView(engine: Host, ui: Ui, columns: number): RenderElement {
  const { Box, Text, Input, Button, Select } = ui
  const site = selectedSite()
  const unfilled = site ? site.keys.filter(k => k.value === undefined) : []

  const line = (text: string, dim = false) => Text({ dimColor: dim, wrap: 'wrap', children: text })

  const filePicker = Select({
    key: 'file',
    label: 'File   ',
    options: [
      ...model.sites.map(s => ({ value: s.target, label: siteLabel(s) })),
      { value: NEW_FILE, label: 'new file…  (type its path below)' },
    ],
    value: model.isTyped ? NEW_FILE : model.target,
    onSelect: (value: string) => {
      const isTyped = value === NEW_FILE

      model = { ...model, target: isTyped ? '.env' : value, isTyped, name: '', epoch: model.epoch + 1, note: '', shown: [], confirming: '' }
      engine.invalidate()
    },
  })

  const pathField = model.isTyped
    ? Input({
        key: 'path',
        label: 'Path   ',
        placeholder: 'apps/new-app/.env',
        value: model.target,
        submitLabel: 'next',
        onInput: (value: string) => {
          model = { ...model, target: value }
        },
        onSubmit: (value: string) => {
          model = { ...model, target: value }
          void engine.focus(nameKey(model.epoch)).catch(() => undefined)
        },
      })
    : null

  return Box({
    flexDirection: 'column',
    width: columns,
    paddingX: 1,
    children: [
      line('Typed here, a value goes to the chosen file only. The model never sees it.', true),
      Box({ height: 1 }),
      filePicker,
      // The picker is a closed list that shows the pick alone; without this
      // a project with eight env files looks like one with one.
      model.sites.length > 1
        ? line(`        ${model.sites.length} env files found; arrows on File switch between them.`, true)
        : null,
      pathField,
      Input({
        key: nameKey(model.epoch),
        label: 'Name   ',
        placeholder: unfilled[0]?.key ?? 'VARIABLE_NAME',
        value: model.name,
        autoFocus: true,
        submitLabel: 'next',
        onInput: (value: string) => {
          if (!takeAssignment(engine, value)) {
            model = { ...model, name: value }
          }
        },
        onSubmit: (value: string) => {
          if (!takeAssignment(engine, value)) {
            model = { ...model, name: value }
            void engine.focus(`secret:${model.epoch}`).catch(() => undefined)
          }
        },
      }),
      Input({
        key: `secret:${model.epoch}`,
        label: 'Secret ',
        placeholder: 'type or paste, Enter saves',
        // The Input has no hidden mode of its own, so while hidden it is
        // handed one bullet per character and the text lives in the model.
        value: model.showSecret ? model.secret : bullets(model.secret),
        submitLabel: 'save',
        onInput: (value: string) => {
          model = { ...model, secret: secretOf(value) }
        },
        onSubmit: (value: string) => {
          model = { ...model, secret: secretOf(value) }
          void save(engine).catch(error => fail(engine, error))
        },
      }),
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Button({ key: 'save', label: 'Save', onPress: () => void save(engine).catch(error => fail(engine, error)) }),
          Button({
            key: 'show',
            label: model.showSecret ? 'Hide secret' : 'Show secret',
            onPress: () => {
              model = { ...model, showSecret: !model.showSecret, epoch: model.epoch + 1 }
              engine.invalidate()
              void engine
                .sleep(FRAME_MS)
                .then(() => engine.focus(`secret:${model.epoch}`))
                .catch(() => undefined)
            },
          }),
          Button({
            key: 'clip',
            label: 'Secret from clipboard',
            onPress: () => void pasteClipboard(engine).catch(error => fail(engine, error)),
          }),
          Button({
            key: 'rescan',
            label: 'Rescan',
            onPress: () =>
              void refresh(engine)
                .then(() => engine.invalidate())
                .catch(error => fail(engine, error)),
          }),
          Button({ key: 'close', label: 'Close', onPress: () => void engine.closePane().catch(() => undefined) }),
        ],
      }),
      model.note === '' ? null : Box({ height: 1 }),
      model.note === '' ? null : line(model.note),
      Box({ height: 1 }),
      ...keyList(engine, ui, site),
    ],
  })
}

/**
 * A `KEY=value` line pasted into Name lands in both fields: the name in Name,
 * the value in Secret, with the focus moved there so Enter saves it. False
 * when the text is not such a line.
 */
function takeAssignment(engine: Host, text: string): boolean {
  const split = splitAssignment(text)

  if (split === null) {
    return false
  }

  const epoch = model.epoch + 1

  model = { ...model, name: split.name, secret: split.value, epoch, note: `Split at "=": ${split.name} and its value. Enter saves.` }
  engine.invalidate()

  void engine
    .sleep(FRAME_MS)
    .then(() => engine.focus(`secret:${epoch}`))
    .catch(() => undefined)

  return true
}

function siteLabel(site: Site): string {
  const unfilled = site.keys.filter(k => k.value === undefined).length
  const state = !site.isPresent ? 'missing' : unfilled > 0 ? `${unfilled} unfilled` : 'complete'

  return `${site.target}  (${state}${site.example ? '' : ', no example'})`
}

/**
 * The key list: a heading, then one row per key. A value is masked until its
 * row is pressed; Delete and Reveal all each ask for a Yes first, in place of
 * the row or the button they were pressed on.
 */
function keyList(engine: Host, ui: Ui, site: Site | undefined): RenderElement[] {
  const { Box, Text, Button } = ui
  const dim = (text: string) => Text({ dimColor: true, wrap: 'wrap', children: text })

  if (model.isTyped) {
    return [dim(`A new file at ${model.target.trim() || '.env'}: Save creates it with the first variable.`)]
  }

  if (!site) {
    return [dim('No .env or .env.example found below this directory. Pick "new file…" to create one.')]
  }

  if (site.keys.length === 0) {
    return [dim(`${site.target}: no keys yet.`)]
  }

  const filled = site.keys.filter(k => k.value !== undefined).map(k => k.key)
  const isAllShown = filled.length > 0 && filled.every(k => model.shown.includes(k))
  const width = Math.max(...site.keys.map(k => k.key.length))

  const confirm = (question: string, id: string, onYes: () => void) =>
    Box({
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ children: question }),
        Button({ key: `yes:${id}`, label: 'Yes', onPress: onYes }),
        Button({ key: `no:${id}`, label: 'No', onPress: () => ask(engine, '') }),
      ],
    })

  // The button and the question that stands in for it take the same cells,
  // so the list below does not move when one replaces the other.
  const revealAll =
    filled.length === 0
      ? null
      : model.confirming === REVEAL_ALL
        ? confirm('Sure?', 'all', () => {
            model = { ...model, shown: filled, confirming: '' }
            engine.invalidate()
          })
        : Button({
            key: 'all',
            label: isAllShown ? 'Hide all values' : 'Reveal all values',
            onPress: () => {
              if (isAllShown) {
                model = { ...model, shown: [] }
                engine.invalidate()
              } else {
                ask(engine, REVEAL_ALL)
              }
            },
          })

  // The File row above already names the file; only where the key names
  // come from is worth a line, and only when that is another file.
  const heading = site.example === null ? [] : [dim(`keys from ${site.example}`)]

  const rows = site.keys.map(k => {
    if (model.confirming === k.key) {
      const unlisted = site.example === null ? '' : ` It stays listed, unfilled, as ${site.example} names it.`

      return confirm(`  Delete ${k.key} from ${site.target}?`, k.key, () => {
        void remove(engine, k.key, unlisted).catch(error => fail(engine, error))
      })
    }

    const isShown = model.shown.includes(k.key)
    const value =
      k.value === undefined
        ? Text({ dimColor: true, children: '(unfilled)' })
        : Button({
            key: `show:${k.key}`,
            plain: true,
            dimColor: !isShown,
            // A Button's label is one line, so a multi-line value (a PEM key)
            // is drawn on one. A short value is padded to its mask's width,
            // so revealing it never pulls the delete button in.
            label: isShown ? k.value.replace(/\r?\n/g, '⏎').padEnd(mask(k.value).length) : mask(k.value),
            onPress: () => {
              model = { ...model, shown: isShown ? model.shown.filter(s => s !== k.key) : [...model.shown, k.key] }
              engine.invalidate()
            },
          })

    return Box({
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ children: `  ${k.key.padEnd(width)}` }),
        value,
        k.isInFile
          ? Button({ key: `del:${k.key}`, plain: true, dimColor: true, label: 'delete', onPress: () => ask(engine, k.key) })
          : null,
      ],
    })
  })

  return [
    ...(revealAll ? [Box({ width: REVEAL_COLUMNS, children: [revealAll] }), Box({ height: 1 })] : []),
    ...heading,
    ...rows,
  ]
}

/**
 * Puts a press up for confirmation, or cancels it with ''. The focus goes to
 * No, so an Enter pressed out of habit changes nothing; on a cancel it goes
 * to Name, as the button it was on is gone.
 */
function ask(engine: Host, confirming: string): void {
  const id = confirming === REVEAL_ALL ? 'all' : confirming

  model = { ...model, confirming }
  engine.invalidate()

  void engine
    .sleep(FRAME_MS)
    .then(() => engine.focus(confirming === '' ? nameKey(model.epoch) : `no:${id}`))
    .catch(() => undefined)
}

/** What the Secret field's text means: itself when shown, an edit of the bullets when hidden. */
function secretOf(typed: string): string {
  return model.showSecret ? typed : editMasked(model.secret, typed)
}

/**
 * Whether a save is between its read and its write. The pane stays live
 * across those awaits, so a second Save would read the same text and write
 * the first key back out of the file.
 */
let isSaving = false

async function save(engine: Host): Promise<void> {
  if (isSaving) {
    return
  }

  const site = selectedSite()
  const typed = model.name.trim()

  if (!isInsideProject(model.target.trim())) {
    model = { ...model, note: 'Path must be relative to this project, like apps/new-app/.env.' }
    engine.invalidate()

    return
  }

  // Spelled as the scan spells it, so the rescan below finds the file again
  // and the picker stays on it.
  const target = projectPath(model.target.trim())
  const name = typed === '' ? (site?.keys.find(k => k.value === undefined)?.key ?? '') : typed
  const value = model.secret

  // The file has to be one the guard denies, or the secret lands where the
  // model may read it. This also refuses `.` and `dir/`, which normalise to
  // a path without a file name.
  if (!isTargetName(target.slice(target.lastIndexOf('/') + 1))) {
    model = { ...model, note: 'The file must be a .env or .env.<name> file, like apps/api/.env.local.' }
    engine.invalidate()

    return
  }

  if (!isKeyName(name)) {
    model = { ...model, note: 'Name must be a variable name like POSTER_KEY.' }
    engine.invalidate()

    return
  }

  if (value === '') {
    model = { ...model, note: `No secret entered for ${name}.` }
    engine.invalidate()

    return
  }

  isSaving = true

  // What the fields held when the write began. The pane stays live across
  // it, so anything typed meanwhile is the person's newer work and is left
  // alone rather than cleared.
  const wasName = model.name
  const wasSecret = model.secret

  let had: boolean

  try {
    // `exists` before `read` on purpose: a read that fails for any other
    // reason must not read as an empty file, which would write the one key
    // over everything the file holds.
    const current = (await engine.exists(target)) ? await engine.read(target) : ''
    const merged = mergeDotenv(current, { [name]: value })

    had = merged.replaced.includes(name)

    await engine.write(target, merged.text)

    model = { ...model, target }

    await refresh(engine)
  } finally {
    isSaving = false
  }

  const isUntouched = model.name === wasName && model.secret === wasSecret
  const epoch = isUntouched ? model.epoch + 1 : model.epoch
  const dollar = isExpandable(value) ? " Its $ is written literally; Bun's own loader expands $ unless it is \\$." : ''
  const lossy = isLossy(value)
    ? ' It holds a single quote, a backtick and a double quote or backslash at once, which no dotenv spelling writes whole: a loader reads its backslashes back.'
    : ''
  model = {
    ...model,
    name: isUntouched ? '' : model.name,
    secret: isUntouched ? '' : model.secret,
    epoch,
    note: `${had ? 'Replaced' : 'Wrote'} ${name}=${mask(value)} in ${target}.${dollar}${lossy}`,
  }

  engine.invalidate()

  if (!isUntouched) {
    return
  }

  // The fields are new elements now, so the ring the Secret field held is
  // gone; the next variable is typed in Name. The wait is for the redraw
  // that mounts them, as a focus call before it names nothing.
  await engine.sleep(FRAME_MS).catch(() => undefined)
  await engine.focus(nameKey(epoch)).catch(() => undefined)
}

/**
 * Deletes a key's lines from the chosen file, after the Yes. Shares the
 * save's guard, as it reads and writes the same file across the same awaits.
 */
async function remove(engine: Host, key: string, unlisted: string): Promise<void> {
  if (isSaving) {
    return
  }

  const target = model.target
  let removed: boolean

  isSaving = true

  try {
    // `exists` before `read`, as in `save`: a failed read must not pass for
    // an empty file.
    const current = (await engine.exists(target)) ? await engine.read(target) : ''
    const out = removeDotenv(current, key)

    removed = out.removed

    if (removed) {
      await engine.write(target, out.text)
    }

    await refresh(engine)
  } finally {
    isSaving = false
  }

  model = {
    ...model,
    shown: model.shown.filter(k => k !== key),
    confirming: '',
    note: removed ? `Deleted ${key} from ${target}.${unlisted}` : `${key} is no longer in ${target}.`,
  }
  engine.invalidate()

  await engine.sleep(FRAME_MS).catch(() => undefined)
  await engine.focus(nameKey(model.epoch)).catch(() => undefined)
}

async function pasteClipboard(engine: Host): Promise<void> {
  for (const argv of [['pbpaste'], ['wl-paste', '--no-newline'], ['xclip', '-selection', 'clipboard', '-o']]) {
    try {
      const { exitCode, stdout } = await engine.run(argv)

      if (exitCode === 0 && stdout !== '') {
        model = {
          ...model,
          secret: stdout.replace(/\r?\n$/, ''),
          epoch: model.epoch + 1,
          note: 'Clipboard taken as the secret; Save writes it.',
        }
        engine.invalidate()

        return
      }
    } catch {
      // the next reader
    }
  }

  model = { ...model, note: 'Clipboard is empty or unreadable.' }
  engine.invalidate()
}

/**
 * Rescans the project. The selection is a path, so it survives the new list
 * on its own: a target the scan turns up again stays chosen, and one it does
 * not — a file under a dot directory, under a skipped one or deeper than
 * `SCAN_DEPTH`, which is written but never listed — stays chosen as a typed
 * path rather than moving the next save to another file.
 */
async function refresh(engine: Host): Promise<void> {
  const sites = await sitesOf(engine)

  if (sites.some(s => s.target === model.target)) {
    model = { ...model, sites, isTyped: false }

    return
  }

  if (model.isTyped) {
    model = { ...model, sites }

    return
  }

  model = { ...model, sites, target: sites[0]?.target ?? '.env', isTyped: sites.length === 0 }
}

async function nudge(engine: Host): Promise<void> {
  await refresh(engine)

  const unfilled = model.sites.reduce((sum, s) => sum + s.keys.filter(k => k.value === undefined).length, 0)
  const files = model.sites.filter(s => s.keys.some(k => k.value === undefined)).length

  if (unfilled > 0) {
    engine.toast(
      `/env: ${unfilled} key${unfilled === 1 ? '' : 's'} unfilled in ${files} .env file${files === 1 ? '' : 's'}; /env sets them`,
    )
  }
}

/**
 * Every env file below the working directory: each example paired with the
 * values file it names, and each values file that stands alone. The sites are
 * read at once — none depends on another — and stay in the order the sorted
 * scan put them in.
 */
async function sitesOf(engine: Host): Promise<Site[]> {
  const pending: Promise<Site>[] = []

  for (const { dir, names } of await envDirsOf(engine)) {
    const targets = new Map<string, string | null>()

    for (const name of names) {
      const named = targetOfExample(name)

      if (named !== null) {
        targets.set(named, name)
      }
    }

    for (const name of names) {
      if (isTargetName(name) && !targets.has(name)) {
        targets.set(name, null)
      }
    }

    for (const [targetName, exampleName] of [...targets.entries()].sort()) {
      pending.push(siteOf(engine, dir + targetName, exampleName === null ? null : dir + exampleName))
    }
  }

  return Promise.all(pending)
}

async function siteOf(engine: Host, target: string, example: string | null): Promise<Site> {
  // Both files at once, and a read is how the target's presence is told:
  // `read` rejects when the file is missing, so a second round trip for
  // `exists` would only ask the same question again.
  const [text, exampleText] = await Promise.all([
    engine.read(target).catch(() => null),
    example === null ? null : engine.read(example).catch(() => null),
  ])

  const have = valuesOf(text ?? '')
  // The example's keys in its order, then any the values file holds that the
  // example does not name, so nothing the file sets goes unlisted.
  const names = [...new Set([...wantedOf(exampleText ?? ''), ...Object.keys(have)])]
  const keys = names.map(key => {
    const value = have[key]

    return { key, value: value === undefined || isMarker(value) ? undefined : value, isInFile: value !== undefined }
  })

  return { target, example, isPresent: text !== null, keys }
}

/**
 * The directories holding env files, each with the file names it holds. The
 * subdirectories of a directory are walked at once rather than one after the
 * other, so the scan costs its depth and not its breadth; the result is
 * sorted, as they come back in whatever order they finish.
 */
async function envDirsOf(engine: Host): Promise<{ dir: string; names: string[] }[]> {
  const found: { dir: string; names: string[] }[] = []

  async function visit(dir: string, depth: number): Promise<void> {
    let entries: FsEntry[]

    try {
      entries = await engine.list(dir === '' ? undefined : dir)
    } catch {
      return
    }

    const names = entries
      .filter(e => e.kind === 'file' && (isExampleName(e.name) || isTargetName(e.name)))
      .map(e => e.name)

    if (names.length > 0) {
      found.push({ dir, names })
    }

    if (depth === 0) {
      return
    }

    await Promise.all(
      entries
        .filter(e => e.kind === 'dir' && !SKIPPED_DIRS.has(e.name) && !e.name.startsWith('.'))
        .map(e => visit(dir + e.name + '/', depth - 1)),
    )
  }

  await visit('', SCAN_DEPTH)

  return found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

function fail(engine: Host, error: unknown): void {
  model = { ...model, note: `Failed: ${messageOf(error)}` }
  engine.invalidate()
  engine.log(`claude-env: ${messageOf(error)}`)
}

/**
 * What a guarded tool call names, as text to test against: every field a
 * tool of this build spells a path or a command in, read by name rather
 * than per tool so a build with one more tool is covered as it stands.
 */
function targetsOf(e: Record<string, unknown>): string[] {
  return TARGET_FIELDS.map(field => e[field]).filter((value): value is string => typeof value === 'string')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

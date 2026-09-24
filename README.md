# claude-env

A Claude Code mod (a plugin built on function hooks) that adds `/env`: a pane
in the Claude Code terminal listing every `.env` file in the project. Pick a
file, enter a variable name and its value, and it is written there. The value
never enters the transcript, so the model never sees it. The `.env` files
remain the only source of truth on disk; the mod reads them and writes them
nowhere else.

Redaction of tool output used to be the other half of this mod, behind a
`redactOutput` option. It is its own mod now, `claude-redact`, because the
two answer different questions: this one stops the model naming a values file,
that one catches a value when something else reads it out. Install both if
you want both; neither needs the other.

## Usage

`/env` opens the pane:

- **File**: picker over env files below the working directory (four levels
  deep; `node_modules`, `.git`, `dist`, `build`, `.next`, `vendor`, `.venv`,
  `target`, `coverage` and dot folders are skipped). Each row shows the file
  and its state: `complete`, `N unfilled`, or `missing` when only the example
  exists. The last row, **new file…**, takes a path relative to the project
  (e.g. `apps/api/.env`) and creates it on Save. The file name must be `.env`
  or `.env.<name>`; absolute paths, `~`, drive letters, backslashes and `..`
  segments are refused. When the project has no
  env file, this row is preselected.
- **Name** and **Secret**: Enter in Secret, or **Save**, writes `Name=Secret`
  to the chosen file, replacing the key's line in place (comment kept) or
  appending it. Other lines are untouched, line endings included. With Name
  empty, the file's first unfilled key is used. Both fields clear after
  writing and focus returns to Name. A whole `KEY=value` line pasted into
  Name is split at the first `=`: the name stays, the value lands in Secret
  and the focus moves there, so Enter saves it.
- Values are written so a loader reads them back exactly: plain when possible,
  otherwise in the first quote style the value does not contain (single quotes
  first). Two cases cannot be spelled losslessly for every loader, and the pane
  says so: a value containing `$` (Bun expands it in every quote style), and a
  value containing a single quote, a backtick and a double quote or backslash
  at once.
- **Secret from clipboard** fills the Secret field from the clipboard.
- **Rescan** re-reads the project. **Close** or Esc closes the pane.

Below the buttons the pane lists the chosen file's keys, each masked or
"(unfilled)", with a **Reveal** picker to show one or all. When a session
starts with unfilled keys, a toast under the prompt reports how many, in how
many files.

## How files are paired

An example file names the keys of the values file beside it: `.env.example`,
`.env.template` or `.env.sample` belong to `.env`; `.env.local.example` belongs
to `.env.local`. A values file without an example (e.g. `.env.production`) is
listed on its own with keys read from itself. In a monorepo this gives one row
per app.

A placeholder in an example is an empty value, `${OTHER}` or `<text>`; a sample
value also counts as a key, since every key the example lists is wanted.

## What the model can and cannot see

- Pane fields and buttons are handled inside the mod. The only transcript
  line is ".env pane opened with N files".
- The mod denies any tool call that names `.env` or `.env.*` in any
  directory (except example, template and sample files), with a hint to read
  the example instead. The guard inspects the path and command fields of a
  call (`file_path`, `notebook_path`, `path`, `glob`, `command`), so the
  built-in reads, shells and writes are covered, and so is any MCP tool that
  spells its path in one of these fields as a string. Other field names or
  array-valued fields are not inspected. Matching is case-insensitive and
  agrees with the scanner: every name the pane writes to is a name the guard
  denies, which `bun test` checks both ways. One exception: a name inside a
  code span (`` `.env` ``) is prose about the file, so a command that greps
  this project's own documentation is not denied for quoting it. A quoted
  word is not excused -- `cat ".env"` reads the file, and the text alone
  cannot tell that apart from a mention. A denial is answered to the model
  as a message, not logged: the model tries these reads routinely, and a line
  per attempt would bury the runs that matter.
- The guard is a name match, not a sandbox. A shell command can reach the file
  without spelling its name (`cat .e*`, `grep -r KEY .`, `find . | xargs cat`),
  so it stops accidental direct reads, not deliberate or indirect ones.
- **Nothing here rewrites tool output.** A process that loads the file need
  never name it -- `bun test` fails with a connection string in the stack
  trace, `printenv` runs inside a script -- and the guard, being a name match,
  cannot see any of that. The `claude-redact` mod is that half.
- The Secret field shows one bullet per character; **Show secret** reveals
  it. While hidden, typing at the end and Backspace are tracked exactly; an
  edit in the middle keeps the part before it and takes the rest as typed.
  The engine's Input is a one-line field and cuts a long value with `…` on
  screen; it is written whole.
- The key list below the buttons shows only each value's length. The
  **Reveal** picker shows one key's value or all of them; it resets when the
  pane closes or another file is picked.

## Requirements

Claude Code 2.1.274 or later with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the
`env` block of `~/.claude/settings.json` (or the shell). The mod auto-loads
from `~/.claude/skills/claude-env` as `claude-env@skills-dir`. The pane needs
the terminal or the desktop app; on mobile the engine draws its default.

## Development

    claude plugin validate ~/.claude/skills/claude-env   # static check of hooks and $ calls
    bun test                                             # helpers in hooks/dotenv.ts
    tsc -p tsconfig.json                                 # types against .claude/types

`.claude/types/` holds the engine's declaration files for the running build;
`/plugin-types` in a session regenerates them. The guard also blocks this session's own shell commands
and file writes that mention `.env`; put such commands in a script file and
build the name from parts in test fixtures. Because it is a name match, it also
denies commands that only mention the name (`grep -r "\.env" src`,
`git log -- .env`).

# Drone interactive workspace runtime

**Status:** implementation contract
**Date:** 2026-07-13

This document governs the local `drone` command. It adds an interactive,
workspace-aware executor to `@minion-stack/drone` without changing the package's
existing library API or the safety contract of Workforce registry drones.

## Command contract

Running the bare command launches the full-screen TUI with the process's current
working directory as the workspace:

```sh
cd /path/to/project
drone
```

An optional positional prompt starts the same TUI and submits that prompt after
startup. `--cwd <path>` changes the workspace before config discovery and
runtime initialization. Relative paths, file operations, and shell commands are
resolved from that workspace.

The CLI surface is:

```text
drone [options] [prompt]
drone config

-p, --print             run without the full-screen TUI and print the result
    --plain             force plain, non-decorated output
    --json              emit machine-readable output
    --cwd <path>        use another workspace
    --provider <id>     override the configured provider
    --model <id>        override the configured model
    --theme <name>      override the TUI theme
    --motion <mode>     full, reduced, or off
    --mouse <mode>      auto, on, or off
    --screen <mode>     choose alternate or split-footer behavior
    --no-mouse          disable mouse input
    --no-animation      disable animation
    --help              print help and exit
    --version           print the version and exit
```

`drone config` is diagnostic and non-interactive. It prints the resolved
configuration, the user and project config paths considered, and validation or
environment diagnostics. It must not start a model run.

## Two runtimes, two safety contracts

The term *drone* is used in two related but deliberately different contexts:

| Runtime | Entry point | Intended work | Side effects |
|---|---|---|---|
| Interactive workspace executor | local `drone` command | inspect and work in the current project with a human present | reads are available; writes and shell operations are policy- and approval-gated |
| Workforce registry drone | Paperclip `minion_drone` adapter through gateway RPC | fixed classifiers, planners, evaluators, and other typed pipeline stages | `sideEffects: "none"`; only fixed, allowlisted drone ids are executable |

The interactive CLI must not be used to weaken the Workforce contract. A local
workspace configuration cannot add tools, replace prompts or models, or grant
side effects to a registry drone. Conversely, Workforce's side-effect-free
restriction does not prevent the explicitly approved local executor from
working in a developer's workspace.

## Runtime and TUI behavior

The full-screen interface has three durable regions and one contextual region:

- a header/status surface showing the Drone identity, workspace, provider/model,
  and current runtime state;
- a scrollable transcript that renders user text, streamed model output, tool
  activity, errors, and approval requests as distinct entries;
- a focused composer for the next instruction.

When the token at the composer caret begins with `/` or `@`, a completion
palette appears directly above the composer without taking focus from it.
Slash completion is available only for the first prompt token. A bare `@`
shows only direct children of the startup workspace. Once text follows the
marker, matching becomes case-insensitive substring search across the
workspace's recursive metadata index. Directories always carry a trailing `/`.
`@~/query` temporarily searches from the user's home directory, while
`@../query` and repeated parent prefixes temporarily search from the requested
ancestor. Empty scoped queries such as `@~/` and `@../` again show only that
temporary root's direct children.

These prefixes affect completion search only: they never change the runtime
workspace used by file tools, shell cwd, writes, git, status, or approvals.
Parent/home tokens are preserved on insertion but are not implicit access
grants; any later external inspection must use an independently permitted,
approval-gated capability. No canonical absolute home path is displayed.
Recursive metadata discovery is asynchronous, cached per root, and bounded to
10,000 entries and 32 levels so pointing completion at a very large home or
filesystem root cannot freeze the TUI. Heavy generated trees, VCS metadata,
hidden trees, worktrees, and symbolic links are excluded. Paths containing
spaces are inserted in quoted form.
The palette keeps the full filtered result set while rendering a compact
four- or six-row viewport. Its title shows the visible range and total count;
arrow keys, `Ctrl+P`/`Ctrl+N`, `PgUp`/`PgDn`, and the mouse wheel scroll the
selection through every retained result.

Typing `/skills ` opens a second completion level for discovered workspace and
user skills. `/skills <name>` toggles that skill for the current TUI process.
Only active skill instructions enter the host's system-level skill context;
activation persists across `/clear` and `/model`, ends when the TUI exits, and
is capped at six active skills to bound prompt growth. Skills cannot add tools
or weaken runtime approvals. Sources are refreshed after a
completed flight so new workspace paths and skill manifests become available.

The visible flight states are `idle`, `thinking`, `tool`, `approval`, `done`,
and `error`. The workspace tool surface is intentionally small:

- `list_files(path, maxDepth)`;
- `read_file(path)`;
- `search_files(query, path, globs, maxResults)` for fixed-string search;
- `write_file(path, content)`;
- `run_command(command)` with timeout, cancellation, and bounded output;
- `git_status`.

All file paths are realpath-confined to the resolved workspace, including paths
that traverse symbolic links. Shell commands start in the workspace and share
the configured output cap.

`write_file` uses Linux descriptor-relative traversal (`/proc/self/fd`) so
parent creation and the final open remain anchored to the verified workspace.
It refuses symbolic path components and fails closed on non-Linux platforms
until an equivalent descriptor-relative implementation is available there.

The renderer must remain usable as the terminal is resized and must not print a
new full screen for every streamed token or animation frame. Long tool output is
bounded by `runtime.maxOutputChars` and clearly marked when truncated.

The user can interrupt the active run without killing the terminal session,
then submit another instruction. End-of-stream, provider failure, timeout,
tool denial, and user cancellation are visible terminal states; none may leave
the interface appearing to run forever.

Drone's own visual identity may use original ASCII/Unicode art and lightweight
rotor, scan, pulse, or progress animation. Decorative rendering must never hide
the current state, approval target, or error text.

### Mouse and keyboard parity

Mouse support is enabled according to resolved configuration. Scrolling,
focusing the composer, selecting actionable controls, and approving or denying
an operation must also be possible from the keyboard. No security decision may
require a mouse.

The minimum stable keymap is:

| Action | Keyboard |
|---|---|
| Submit the composer | `Enter` |
| Insert a newline | `Alt+Enter` or `Ctrl+J` |
| Navigate an open completion palette | `Up` / `Down`, `Ctrl+P` / `Ctrl+N`, or `PgUp` / `PgDn` |
| Accept a highlighted completion | `Enter` or `Tab` |
| Dismiss a completion palette | `Esc` while idle |
| Scroll the transcript | `PgUp` / `PgDn` |
| Cancel an active run | `Esc` or `Ctrl+C` |
| Deny the displayed approval | `Esc` or the focused **Deny** control |
| Activate a focused control | `Enter` |
| Show help | `?` or `/help` |
| Show resolved configuration | `/config` |
| Browse or toggle skills | `/skills [name]` |
| Clear the transcript | `/clear` |
| Show runtime status | `/status` |
| Exit | `/exit`, or `Ctrl+C` while idle |

The mouse wheel scrolls the transcript and open completion palettes even when
click handling is disabled. Completion rows support hover selection and
click-to-insert when mouse clicks are enabled; all completion actions retain
the composer focus and never execute the inserted command on the same click.
Clicking the composer focuses it;
clicking footer Help, Config, Clear, or Quit performs the corresponding slash
command; approval buttons provide **Allow once** and **Deny**. On-screen hints
are the source of truth for context-sensitive focus and approval keys. Changing
a mouse target must update its keyboard path in the same change.

Click handling and terminal text selection are separate policies. When click
handling is disabled, normal terminal selection must remain available. When
`copyOnSelect` is enabled, copied content is transcript text, never hidden
configuration or secret values.

### Motion, color, and screen policy

- `--no-animation` is an absolute override and stops decorative animation.
- `ui.motion: "reduced"` slows decorative changes and `"off"` disables them;
  `--no-animation` always resolves to `"off"`.
- `NO_COLOR` or `DRONE_NO_COLOR` selects monochrome output when no explicit
  theme overrides it. Plain and non-TTY output also avoid color and
  cursor-control sequences.
- `ui.screen` / `--screen` controls alternate-screen versus split-footer
  behavior. Split-footer mode keeps the conversation in terminal scrollback.
- `ui.art: "off"` does not remove status, progress, errors, or approval details.

## Configuration

Drone reads JSON from these locations:

1. user config: `$XDG_CONFIG_HOME/drone/config.json` when `XDG_CONFIG_HOME` is
   set, otherwise `~/.config/drone/config.json`;
2. project config: `<workspace>/.drone/config.json`.

Resolution precedence is, from lowest to highest:

```text
built-in defaults < user config < project config < DRONE_* environment < CLI flags
```

Runtime safety is the deliberate exception to ordinary project precedence. A
project config may only tighten policy: it can set `allowShell` or `allowWrites`
to `false`, and `requireApproval` to `true`. Attempts to enable a capability or
disable approval from `.drone/config.json` are ignored and reported by
`drone config`. User config, environment variables, and CLI-owned overrides are
trusted user inputs and remain authoritative.

The project path is based on the resolved workspace, so `--cwd` selects both the
runtime directory and its project config. Configuration is merged by field; a
higher-precedence source need not repeat unrelated values.

Supported keys are:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "systemPrompt": "<built-in coding-agent prompt>",
  "timeoutMs": 120000,
  "maxSteps": 24,
  "temperature": 0.2,
  "ui": {
    "theme": "auto",
    "mouse": "auto",
    "mouseClicks": true,
    "copyOnSelect": true,
    "motion": "full",
    "art": "full",
    "screen": "alternate"
  },
  "runtime": {
    "allowShell": true,
    "allowWrites": true,
    "requireApproval": true,
    "maxOutputChars": 50000
  }
}
```

These are the built-in defaults; the `systemPrompt` value is abbreviated above.
`ui.theme` accepts `auto`, `dark`, `light`, or `mono`; `ui.mouse` accepts `auto`,
`on`, or `off`; `ui.motion` accepts `full`, `reduced`, or `off`; `ui.art` accepts
`full`, `compact`, `minimal`, or `off`; and `ui.screen` accepts `alternate` or
`split`. The click/copy switches and runtime guards are booleans.
`runtime.maxOutputChars` is capped at 1,000,000 characters.

Environment overrides map one-to-one:

```text
DRONE_PROVIDER              DRONE_MODEL
DRONE_SYSTEM_PROMPT         DRONE_TIMEOUT_MS
DRONE_MAX_STEPS             DRONE_TEMPERATURE
DRONE_THEME                 DRONE_MOUSE
DRONE_MOUSE_CLICKS          DRONE_COPY_ON_SELECT
DRONE_MOTION                DRONE_ART
DRONE_SCREEN                DRONE_ALLOW_SHELL
DRONE_ALLOW_WRITES          DRONE_REQUIRE_APPROVAL
DRONE_MAX_OUTPUT_CHARS
```

Boolean environment values accept, case-insensitively, `true`/`false`, `1`/`0`,
`yes`/`no`, and `on`/`off`; enum variables accept the values listed above.
Missing config files are silent. Invalid JSON,
unknown keys, and invalid field types or ranges produce diagnostics and are
ignored rather than crashing startup. `drone config` reports these diagnostics
and is the authority for the final resolved values.

API keys do not belong in either JSON config and must not be printed by
`drone config`. Provider authentication resolves `DRONE_API_KEY` first, then the
provider's standard process-environment key, then that key from `<workspace>/.env`.
Loading `.env` for a run does not mutate the parent process environment.

## Security and approvals

The workspace is the context and default execution directory, not an operating
system sandbox. Users should run Drone with the same account and filesystem
access they would grant any local developer tool.

Path confinement defends against model-supplied traversal and symbolic-link
redirection. It does not attempt to sandbox a separate, hostile process running
as the same operating-system user and concurrently relocating already-opened
directory inodes; use an OS sandbox for that threat model.

Runtime policy is enforced before approval:

1. `runtime.allowWrites: false` denies file mutations.
2. `runtime.allowShell: false` denies shell execution.
3. When the applicable capability is allowed and
   `runtime.requireApproval: true`, Drone displays the exact write or shell
   operation and waits for **allow once** or **deny**.
4. Missing, interrupted, or ambiguous approval is denial. Approval applies only
   to the displayed operation; it is not a session-wide grant.

Model text cannot approve its own tool request. Approval input is accepted only
from the local interactive user. Non-interactive modes must not silently invent
approval; an operation that needs approval fails unless that mode has an
explicit, separately documented authorization path.

The UI and diagnostics redact secrets. Shell command text and file targets are
not secrets and must remain visible when the user is deciding whether to allow
them. Child shell environments strip variables whose names identify secrets,
tokens, API keys, passwords, credentials, or authentication material by
default; granting a command does not implicitly grant the model every secret in
the parent shell. Commands run in a non-login Bash process with profile and
non-interactive startup files disabled.

## Plain and JSON fallbacks

`--print` runs one prompt to completion without the full-screen renderer.
`--plain` suppresses art, animation, color, mouse handling, alternate-screen
control, and other cursor manipulation. `--json` writes machine-readable result
data to stdout; human diagnostics go to stderr and failures return a non-zero
exit status.

When stdout is not a TTY, the CLI must not emit full-screen control sequences.
Automation should select `--json`; logs must never be mixed into the JSON stdout
stream. Non-interactive execution retains the same runtime capability and
approval boundaries as the TUI.

## Terminal lifecycle

On normal exit, `Ctrl+C`, termination signals, startup failure, renderer error,
or rejected approval, Drone restores every terminal feature it changed. This
includes raw input mode, cursor visibility, alternate screen, mouse reporting,
bracketed paste, and any temporary signal handlers. Cleanup is idempotent so a
partially initialized renderer is safe to tear down.

The process must not leave the user's shell without echo, with a hidden cursor,
or in mouse-capture mode. Fatal errors are printed after cleanup so they remain
readable.

## Local installation and verification

From this repository:

```sh
cd /home/nikolas/Documents/CODE/MINION/drone
pnpm install --ignore-workspace
pnpm build
pnpm link --global
hash -r
```

Verify the non-model path first:

```sh
command -v drone
drone --version
drone --help
drone config
```

Then launch from a disposable or known workspace and confirm the header reports
that directory:

```sh
cd /path/to/project
drone
```

Exit and verify normal shell echo, cursor, scrolling, selection, and mouse
behavior are restored. Provider-backed prompts additionally require the chosen
provider's normal credentials.

## Non-goals and future work

The first local runtime does not provide:

- ACP client/server compatibility or remote editor attachment;
- durable session persistence, restart recovery, or `drone resume`;
- background daemon behavior or unattended Workforce orchestration;
- a VM/container sandbox or privilege boundary;
- a way to edit or bypass the fixed Workforce registry from local config;
- multi-agent orchestration or a claim of feature parity with another coding
  agent's private runtime.

ACP integration and durable resume are explicit future extensions. They must
preserve this document's workspace, approval, output-mode, and terminal-cleanup
contracts rather than being smuggled into the first release.

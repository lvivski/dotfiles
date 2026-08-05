dotfiles
========

Just run `source ./sync` (or `. ./sync`).

It must be **sourced** so it can reload your shell afterwards, and the leading
`./` is required — a bare `. sync` would source `/bin/sync` instead. Works from
both zsh and bash.

## Homebrew

The synced `~/.Brewfile` captures Homebrew packages, global npm packages, and
VS Code extensions. After installing Homebrew, install everything with:

```sh
brew bundle --global
```

On a new machine, initialize the default Rust toolchain once:

```sh
rustup default stable
```

From this repository, refresh the file after changing installed tools with:

```sh
brew bundle dump --file=.Brewfile --force
```

## Copilot Conveyor — dynamic workflows on the Copilot CLI

`source ./sync` also installs the **Conveyor** Copilot extension, which orchestrates workflows across
many GitHub Copilot CLI subagents in parallel (fan-out/synthesize, adversarial verification,
tournaments, ...) from an async JavaScript workflow harness (`.mjs`), with checkpoint/resume,
budgets, and a live progress view. Say `conveyor: <task>` in a `copilot` session (or `xtreme: <task>`
to use the high-confidence preset), invoke the `run_conveyor` tool directly, and inspect runs with
`/conveyor`.

Runs inherit one transport for their full lifetime. The persistent SDK stdio backend is the default
when available, with isolated CLI processes as the fallback. Override selection with
`CONVEYOR_AGENT_BACKEND=cli` or `CONVEYOR_AGENT_BACKEND=sdk`.

See [`.copilot/skills/conveyor/SKILL.md`](.copilot/skills/conveyor/SKILL.md).

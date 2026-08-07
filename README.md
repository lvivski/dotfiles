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
tournaments, ...) from an async JavaScript workflow harness (`.mjs`). Conveyor resolves source and
launches it on the native Agent Factory runtime, which owns limits, durable steps, resume,
cancellation, progress, and results. Invoke `run_conveyor` for a fresh harness and use the native
Factory tools for later lifecycle operations.

See [`.copilot/skills/conveyor/SKILL.md`](.copilot/skills/conveyor/SKILL.md).

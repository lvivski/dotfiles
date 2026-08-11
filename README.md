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

## Copilot Foundry — control plane and Agent Factories

`source ./sync` also installs the **Foundry** Copilot extension. Foundry coordinates dependency-aware
engineering plans and registers the `plan`, `verify`, `audit`, `deep-research`,
`review-queue`, `security-review`, and `triage` native Agent Factories. Invoke factories with
`run_factory`; the native runtime owns limits, durable steps, resume, cancellation, progress, and
results.

See [`.copilot/skills/foundry/SKILL.md`](.copilot/skills/foundry/SKILL.md).

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

## Copilot skills

The four skills in `.copilot/skills/` use standard Agent Skills frontmatter, with client-specific
settings under namespaced `metadata` keys. Each `SKILL.md` holds its default workflow and essential
safeguards; directly linked local references provide phase protocols or options only when needed.
Bundled script paths are resolved from the skill directory, not a hard-coded installation path.
`source ./sync` installs these skills along with their references and scripts.

The queue fetcher's offline CLI tests use Bash and standard OS utilities, with no additional
runtime or test framework:

```sh
bash .copilot/skills/review-queue/scripts/review-queue-fetch.test.sh
```

## Copilot Foundry — local software factory

`source ./sync` also installs the **Foundry** Copilot extension. Foundry runs one graph of
regenerable directories, from a seed or a gap observed by a repository-defined squad. Independent
writers run in parallel. A deterministic evaluator checks their exact joined Git tree without a
verifier agent. Foundry records the qualified commit but never moves the destination branch.
Sync checksum-mirrors Foundry and its skill: obsolete implementation files are removed and
older contents are replaced even when their sizes and timestamps match. Unrelated extensions
and repository-owned factory data are preserved.
The separate Recon extension registers the standalone `audit`, `deep-research`,
`review-queue`, `security-review`, and `triage` native Dynamic Workflows. Invoke workflows with
`run_dynamic_workflow` and inspect runs with `dynamic_workflows_manage`; the native runtime owns
limits, durable steps, resume, cancellation, progress, and results.

Foundry coordination is opt-in. Use native plan mode and direct tools for routine changes, and
the native `orchestrate` or `pr-stack` flows for ordinary multi-session or stacked-PR work. Choose
Foundry when you explicitly want checked regeneration or ongoing charter-driven discovery;
installing it does not put ordinary coding through a factory protocol. Native permissions remain
authoritative. Superseded protocols have no compatibility mode; existing user data is not migrated
or removed.

See the [contract and example](.copilot/extensions/foundry/README.md) and [Foundry skill](.copilot/skills/foundry/SKILL.md).

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

Test the queue fetcher's CLI offline with Bash. The provider integration suite also needs `jq`
and Node.js; it passes manifests from mock GitHub and Azure CLIs through Recon's review workflow.

```sh
bash .copilot/skills/review-queue/scripts/review-queue-fetch.test.sh
bash .copilot/skills/review-queue/scripts/review-queue-providers.test.sh
```

## Copilot extensions

`source ./sync` checksum-mirrors the Foundry and Recon extensions and their bundled skills under
`~/.copilot/`. It prunes stale files from those mirrors and preserves unrelated extensions and
repository run data.

**[Foundry](.copilot/extensions/foundry/README.md)** regenerates directories from a committed
product brief. Independent writers work in parallel. Each checked milestone gives squads a new
combined tree to inspect; work continues under the original authorization until the final goal
check passes or a concrete blocker needs attention. A seeded one-off is also available.
Foundry records the exact passing commit and leaves the target branch untouched. Use the
[Foundry skill](.copilot/skills/foundry/SKILL.md) on explicit request; routine changes use native
planning and direct tools. Normal tool permissions apply throughout a run.

**[Recon](.copilot/extensions/recon/README.md)** registers five standalone native workflows:
`audit`, `deep-research`, `review-queue`, `security-review`, and `triage`. Their reports belong
to the native workflow run. Use `dynamic_workflows_manage` to inspect arguments or results.

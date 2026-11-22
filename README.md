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

The skills in `.copilot/skills/` use Agent Skills frontmatter. Each `SKILL.md` holds its default workflow and essential
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
repository run data. Both sync directions leave `.git` directories and linked-worktree `.git` files untouched.

**[Foundry](.copilot/extensions/foundry/README.md)** regenerates directories from a committed
product brief. Goal contracts pin writable areas and checks. Tool-less workflow scouts review the
committed evidence; each result can release an independent writer without waiting for other scouts.
Only writers need their own worktrees. Each checked milestone preserves the combined tree,
not the old directory assignments. Work continues under the original authorization until the final goal
check passes or a concrete blocker needs attention. A seeded one-off is also available.
Foundry hands the owner the exact passing commit and leaves the target branch untouched.
Current charter questions reach the owner without blocking independent writers. Retiring a
writer is a separate, [opt-in native Archive](.copilot/skills/foundry/references/handoff.md),
never a consequence of a passing check.

1. [**`/foundry brief <idea>`**](.copilot/skills/foundry/references/brief.md) uses the installed `grilling` skill for the interview. Foundry looks up repo facts first, then asks one product question at a time with a recommendation. You confirm the outcome before it writes. Say “draft it now” for a provisional brief with open decisions marked. Neither path starts a factory.
2. [**`/foundry start catalog`**](.copilot/skills/foundry/references/runs.md#start) runs the reviewed, committed `.foundry/catalog.json` on your explicit request. Use `/foundry plans` for available names or `/foundry` for the [command menu](.copilot/skills/foundry/SKILL.md#commands). You don't need a new plan after each milestone. Normal tool permissions still apply.
3. [**`/foundry measure <run-id>`**](.copilot/skills/foundry/references/metrics.md) shows time to the first verified native writer kickoff and the exact qualified commit. It distinguishes kickoff from a delayed binding receipt and reports only usage the host can attribute.

**[Recon](.copilot/extensions/recon/README.md)** registers five standalone native workflows:
`audit`, `deep-research`, `review-queue`, `security-review`, and `triage`. Their reports belong
to the native workflow run. Use `dynamic_workflows_manage` to inspect arguments or results.

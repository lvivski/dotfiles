---
name: security-review
description: >-
  Use this skill when the user wants a security review, deep security review, or security audit.
compatibility: GitHub Copilot CLI with cwf; Python 3.9+; git optional for diff mode.
metadata:
  copilot.user-invocable: "true"
  copilot.runtime: "cwf"
user-invocable: true
---

# Security review workflow

This workflow uses `cwf` as the orchestrator for a practical security-review loop. It keeps this
repo's implementation intentionally lightweight; production-scale scanners should still own robust
schemas, per-file locking, credential-brokered sandboxing, provider-specific quota handling, and
polished exports.

This skill runs the pragmatic model in `~/.copilot/workflows/security-review.cwf.py`:

1. Deterministically scan selected files with a small built-in matcher catalog.
2. Preserve direct-review behavior: explicit file/diff mode reviews every selected file, even if no
   matcher fires.
3. Batch by directory and priority, then investigate with quarantined read-only agents.
4. Use `wf.structured()` for one combined JSON findings array per batch.
5. Verify findings adversarially and separate verified, rejected, and unverified findings.
6. Optionally merge verified/unverified findings into a JSON state file, then mark whether current
   findings are net-new against that baseline.
7. Optionally revalidate stored findings with git history and current source evidence.
8. Optionally write a PR-comment-shaped markdown file for net-new verified findings.
9. Render a Markdown report with the coverage boundary and candidate counts.

## Default run

Preview first:

```text
run_workflow({
  scriptPath: "~/.copilot/workflows/security-review.cwf.py",
  dryRun: true,
  budget: 10000,
  disableMcp: true,
  args: { "root": ".", "diff": "origin/main", "max_files": 20 }
})
```

Then run with a deliberate budget:

```text
run_workflow({
  scriptPath: "~/.copilot/workflows/security-review.cwf.py",
  budget: 10000,
  disableMcp: true,
  model: "claude-opus-4.8",
  effort: "high",
  context: "long_context",
  args: {
    "root": ".",
    "diff": "origin/main",
    "batch_size": 4,
    "max_files": 40,
    "state": ".security-review/state.json",
    "comment_out": ".security-review/comment.md",
    "revalidate_with_git": true,
    "fail_on_findings": true
  }
})
```

## Arguments

Use exactly one file source:

| Argument | Meaning |
| --- | --- |
| `files` | Explicit list of repo-relative files. |
| `files_from` | Newline-delimited file list. |
| `diff` | `git diff --name-only --diff-filter=AMRC <ref>`. |
| `diff_staged` | Review staged changes. |
| `diff_working` | Review unstaged plus untracked changes. |
| no source | Repo-wide regex-gated scan. Defaults to `max_files: 60`; set `max_files: null` for full coverage. |

Other knobs: `include`, `exclude`, `priority_paths`, `batch_size`, `concurrency`,
`max_file_size`, `max_files`, `state`, `comment_out`, `net_new_only`, `summarize`,
`verbose_rejected`, `fail_on_findings`, `revalidate_with_git`, `revalidate_force`, and
`revalidate_limit`.

When `state` is supplied, `net_new_only` defaults on: repeated runs preserve prior findings and
`fail_on_findings` fails only for verified findings that are new to the state baseline. Without a
state file, every verified finding is treated as new. `comment_out` writes markdown only when there
are net-new verified findings and removes a stale comment file on green runs.

When `revalidate_with_git` is true, the workflow loads the state file after merging current
findings, collects current source snippets plus recent `git log` / `git blame` evidence, and asks a
no-tool verifier to classify each stored finding as `true-positive`, `fixed`, `false-positive`, or
`uncertain`. `fixed` and `false-positive` findings stay in state but are excluded from PR comments
and `fail_on_findings`. Use `revalidate_force` to re-check findings that already have a git
verdict, and `revalidate_limit` to cap the pass.

## Security and scope notes

- Agents that read source run under `wf.quarantine()`; the summary agent uses
  `wf.quarantine(allow_all_tools=False)` because finding text is untrusted-derived.
- Repo-wide mode is regex-gated. A clean report means no verified issue was found within the
  stated boundary, not that the repo is vulnerability-free.
- The optional JSON state file is a lightweight baseline. It is not a substitute for an append-only
  FileRecord store, lock reclaim, sandbox credential broker, or distributed executor.
- Do not use `--restricted` when using git diff or state-writing mode; the harness imports
  capability-bearing stdlib modules for file discovery and atomic state writes.

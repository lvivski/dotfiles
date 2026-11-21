# Operate a factory

## Find a plan

Run `node <skill-base-dir>/scripts/plans.mjs` from the user's checkout for `plans`. It lists short names for top-level `.foundry/*.json` files at `HEAD`, not uncommitted drafts or running factories. Listing a filename is not a readiness check.

For `start` or `resume`, pass the operator's target as one literal argument to that same [read-only helper](../scripts/plans.mjs). For example, `hyper-app` resolves only `.foundry/hyper-app.json`; an explicitly supplied repository-relative `.foundry/...` path is also accepted. It returns the canonical `source`, actual `run` ID and `target` after checking the committed contract, its pinned files on the target, and any pending edits to those files. It does not run evaluators or open a ledger. A filename and a run ID can differ. Don't substitute a run ID, fuzzy match, different branch, or uncommitted brief for the requested source. On error, report it; offer `plans` for a missing name.

## Start

On direct operator direction in the interactive or Autopilot owning session, pass **only** the resolved `source` to `foundry_start({source})`. Let the native confirmation run. Do not repeat the product interview. An installation, schedule, child kickoff or queued message is not authorization. Neither Autopilot nor confirmation grants tool permissions. If managed settings are unresolved or the session uses Manual approvals, relay the blocker; Assisted is sufficient if policy permits. Don't start replacement workers.

Report the **returned run ID** for `status` and `pause`, and the actual state or blocker. One start covers the goal. Checked milestones don't need new plans; scouts revise the work. `limits.workers` caps scouts and writers, not native helpers. Only capped runs offer **Keep** or **Increase**. Existing version-1 fixed contracts still work; `seed` without `goalCheck` is for an explicitly requested one-off.

## Status

Use `foundry_status({run})` with the run ID from the start receipt. This reads state without advancing it and does not require a clean checkout. `checkpoint` is progress; in a goal run `qualified` stays null until both committed checks pass on the same exact commit. The target branch stays unchanged. Report concrete blockers or contract questions, not a completion claim.

On qualification, hand the owner the full `handoff.commit` and checked target. Follow the [handoff guide](handoff.md) before offering Archive for **any** individually named writer. An idle writer or passing component is never sufficient. On status, report available `metrics` latencies in human units. For model usage use [`/foundry measure <run-id>`](metrics.md); missing observations are unknown, not zero.

A current `needs-decision` goes to the owner once. Check `questions[].delivery` before discussing it: `presenting` means the native question may already be open, not permission to ask again. An answer is attached to that review, not applied to the contract. Dismissed, superseded and unconfirmed questions remain in `reviews`; don't replay them. When directed to a writer request, inspect `get_session` for that writer and the **current** request ID. Use `relay_session_input` only for a real, relayable coordinated request; otherwise point to the original session. Never turn an input or permission prompt into a second `ask_user`, answer it speculatively, or treat it as approval.

When showing the operator a run in the desktop app, open the **Foundry dependency map** (`canvasId: "foundry-board"`, `input: {run: "<run-id>"}`). Reuse a panel handle such as `run-<run-id>` for that run. Elsewhere, or for a text-only request, summarize the same status in chat. If the run is inaccessible, report that; don't substitute another run. To demonstrate the canvas without a factory, explicitly open it with `{example: true}` and label it as an example.

## Pause and resume

Only the owner pauses with `foundry_pause({run})`. To resume, resolve the plan and read `foundry_status({run})` first. Only call `foundry_start({source})` on the owner's direct request for an existing paused run whose `contract.path` matches the resolved source. For a missing, active, or completed run, report what you found instead. A changed contract needs a new run ID and separate authorization.

A session-local Manual hold appears in `pending`: other sessions continue; the original issuer rechecks on its next turn. Don't restart for this. For a managed-policy pause, first resolve the setting in `blocker`. For goal exit 2, supply the missing external observation, then pause and explicitly resume the same run. Preserve receipts and worktrees. If a native session route is definitely unavailable, execute the exact `prepared` call once in its issuing session. Never repeat an issued or uncertain start, treat a queued message as completed work, or bypass a permission hold.

An unavailable scout workflow is a discovery blocker, not a request to start a desktop scout. For a bound workflow inspect the original run ID; only an explicitly unbound, interrupted discovery can be retried by pausing and resuming. Older ledger protocols are not migrated: preserve the old clone and use a fresh clone for a new run.

# Operate a factory

## Find a plan

Run `node <skill-base-dir>/scripts/plans.mjs` from the user's checkout for `plans`. It lists short names for top-level `.foundry/*.json` files at `HEAD`, not uncommitted drafts or running factories. Listing a filename is not a readiness check.

For `start` or `resume`, pass the operator's target as one literal argument to that same [read-only helper](../scripts/plans.mjs). For example, `catalog` resolves only `.foundry/catalog.json`; an explicitly supplied repository-relative `.foundry/...` path is also accepted. It returns the canonical `source`, actual `run` ID and `target` after checking the committed contract, its pinned files on the target, and any pending edits to those files. It does not run evaluators or open a ledger. A filename and a run ID can differ. Don't substitute a run ID, fuzzy match, different branch, or uncommitted brief for the requested source. On error, report it; offer `plans` for a missing name.

## Start

On direct operator direction in the interactive or Autopilot owning session, pass **only** the resolved `source` to `foundry_start({source})`. The explicit start or resume request authorizes the named committed brief; do not ask for a second confirmation. An installation, schedule, child kickoff or queued message is not authorization. Neither the request nor Autopilot grants tool permissions. If managed settings are unresolved or the session uses Manual approvals, relay the blocker; Assisted is sufficient if policy permits. Don't start replacement workers.

Report the **returned run ID** for `status` and `pause`, and the actual state or blocker. An ordinary repository session owns the run; no Copilot app Project is involved. One start covers the goal. Checked milestones don't need new plans; scouts revise the work. `limits.workers` caps concurrent scouts and writers, not native helpers. Existing version-1 fixed contracts still work; `seed` without `goalCheck` is for an explicitly requested one-off.

## Status

Use `foundry_status({run})` with the run ID from the start receipt. This reads state without advancing it and does not require a clean checkout. `checkpoint` is progress; in a goal run `qualified` stays null until both committed checks pass on the same exact commit. The target branch stays unchanged. Report concrete blockers or contract questions, not a completion claim.

On qualification, hand the owner the full `handoff.commit` and checked target. Keep writer sessions. Use the [handoff guide](handoff.md) for portable proof or separately requested cleanup. For model usage use [`/foundry measure <run-id>`](metrics.md); missing observations are unknown, not zero.

A missing diagnostic is not an owner decision. Scouts and researchers get the retained goal output for the reviewed commit. If that does not answer a factual question, Foundry uses authorized research when available; otherwise the unknown stays in status, not in an owner dialog. A combined test failure is not a verdict on every component.

A current `needs-decision` identifying a product choice or external action goes to the owner once. `presenting` means the dialog may already be open. A clarification goes to one fresh review of that charter at that revision; it cannot authorize permissions, edits to the brief, or new checks. A dismissed or stale question stays in history. A writer's native request stays in its own session with its own request ID; do not answer or relay it as a charter decision. To conserve a useful answer for future runs, have the operator review a change to the charter or a boundary file with its rationale and source review. Commit and authorize the revised brief separately; chat is not policy.

If the owner lost a dialog on reload, status alone will not reopen it. **Only on the operator's explicit request**, pass that question's `recovery` object unchanged to `foundry_clarify` in the original owner session. The operator enters their answer in the replacement dialog; never supply one for them. This replaces only the named presentation of that review. A late reply to the old dialog cannot overwrite it. If the question or presentation has changed, read status rather than retrying.

If dialog delivery fails, status gives the owner a recovery object for the failed presentation. Use that object only on a new explicit request. A dismissed question has no recovery object.

When showing the operator a run in the desktop app, open the **Foundry dependency map** (`canvasId: "foundry-board"`, `input: {run: "<run-id>"}`). Reuse a panel handle such as `run-<run-id>` for that run. Elsewhere, or for a text-only request, summarize the same status in chat. If the run is inaccessible, report that; don't substitute another run. To demonstrate the canvas without a factory, explicitly open it with `{example: true}` and label it as an example.

## Pause and resume

Changing the brief or product acceptance requirements still requires a separately authorized run. For a fix solely to the way the final goal is observed, use [evaluator repinning](#evaluator-repinning).

If Foundry says its installed reader changed, reload extensions **in the session that reported it**, then read status for the same run. A writer submits only if its original token is still writing with no check pending. Don't resume the run, replace the writer, or retry a pending submission.

Only the owner pauses with `foundry_pause({run})`. On an explicit `/foundry resume <plan>` in the owner session, resolve the committed plan and call `foundry_resume({source})` directly. Do not pause first or substitute `foundry_start`. Resume never creates a run. For an active run it can retry missing external evidence, recover interrupted discovery, or claim a never-issued writer launch reserved by a published writer. Prepared, held, refused, issued and uncertain native calls stay with their issuer. A changed contract needs a new run ID and separate authorization.

A session-local Manual hold appears in `pending`: other sessions continue; the original issuer rechecks on its next turn. Don't restart for this. For a managed-policy pause, first resolve the setting in `blocker`. For goal exit 2, supply the missing external observation, then resume the same run. Preserve receipts and worktrees. If a native session route is definitely unavailable, execute the exact `prepared` call once in its issuing session. Never repeat an issued or uncertain start, treat a queued message as completed work, or bypass a permission hold.

Full native workflow slots are a queue, not a pause: the issuing session retries automatically. An unavailable scout workflow is a discovery blocker, not a request to start a desktop scout. For unbound, interrupted discovery, owner resume can retry the dispatch. A bound paused or recoverably halted workflow can continue only on the original native ID in its issuing session. Owner resume handles owner-issued workflows. For a writer-issued workflow, relay the session and ID from `pending`; on explicit operator request there, use `run_dynamic_workflow({resumeFromRunId: "<original ID>"})`. Do not change limits, retry a cancellation or refusal, or launch a replacement. Older ledger protocols are not migrated: preserve the old clone and use a fresh clone for a new run.

On an explicit request for one fresh review after a scout returned no report, use `foundry_rereview({run, review})` in the original owner session with the exact blocked review ID from status. The owner must have the original workflow's native evidence: that exact direct scout failed for prompt budget before any tool calls. Missing or refused evidence, a changed pin, a superseding review or product revision, or exhausted limits cannot be overridden. Do not loop on a failed request or retry an entire batch.

### Recover an existing writer

1. In the **existing writer session**, call the ordinary App `get_session` on itself, then `foundry_claim({run, grain})`. `awaiting_issuer` means its original startup path and generation, first issuer-sourced kickoff and App creation edge match. It is not bound yet.
2. In the **original issuing session** (see `pending.issuer`), call `foundry_claim({run, grain})` for the same reservation. `bound` requires its unique original external request, matching arguments and UI dismissal, no conflicting native completion or refusal, and the existing linked worktree at the original parentless generation.
3. Only in that writer, after its helpers finish, use the ordinary `foundry_submit` with its original token. Neither claim proves the component passes. If either proof is missing or conflicting, stop; do not recreate the session, paste an identity or prompt as evidence, or edit the ledger.

## Evaluator repinning

Only on a direct operator request in the active run's **owner session**, read status for `goal.pin`. Prepare or identify a separately reviewed evaluator-only commit based on that pin, **off the run's target branch**. Do not commit working-tree changes without authorization. Inspect the complete diff, including additions, deletions, and helpers shared across plan directories. Reject changes to what counts as a pass; path checks cannot establish that the requirements are unchanged.

Call `foundry_repin({run, from, revision, files})` with both full commit IDs and the exact changed paths. The operator reviews the change and clicks the approval button in the owner session; there is no checkbox or text field. Declining or dismissing ends this request: do not retry or ask again without fresh operator direction. No recheck starts; unrelated work can continue. If the run is blocked, report the existing blocker. A stale approval cannot change the pin. Do not answer that dialog for the operator. Reload any participating session predating the reader-version guard before repinning.

The runner applies only the reviewed evaluator changes to a temporary export for **goal checks only**. An issued or uncertain check keeps its original reservation. Once it settles, Foundry checks the checkpoint under the new evaluator, preserving product bytes, writer tokens, prior receipts and the original contract. `goal.pin`, `evaluatorChanges` and `goalChecks` in owner status distinguish the approved revision from checks already issued. A refusal or permission hold is not bypassed. No pause, resume, or writer resubmission is needed.

Do not continue a paused scout from a superseded evaluator pin. Foundry releases its slot when the native stop is confirmed; an unknown outcome is not confirmation.

If the approved pin is waiting on a superseded goal, `blocker` names the original reservation and issuer. `uncertain` is not evidence that the evaluator has stopped. Normally let it finish. If the operator explicitly asks to interrupt it, first match the live runner to the exact checkout, run and reservation, and its direct evaluator child to the exported check. If that identity or safe cleanup of its subprocesses cannot be established, stop. Terminate only the verified obsolete evaluator, **not its Foundry runner**: the runner must record the interruption. Verify cleanup, the old non-passing receipt and one new reservation on the same product with the approved pin. A missing receipt is not a reason to replay the check or edit the ledger.

# Hand the checked product to its owner

In the owning session, read `foundry_status({run})`. For a non-null `handoff`, report the outcome in one sentence, using full object IDs: **“Goal passed at `<commit>` against `<targetRef>` at `<target>`. The branch was not updated.”** For `mode: "one-off"` say **“Seeded product passed”** instead; for `"ongoing"` say **“Product check passed; discovery has no final goal.”** For a goal checkpoint without acceptance, say the goal hasn't qualified. An idle notification or component pass is not a product verdict.

Stop there. Keep the sessions. No archive offer, usage query, export, landing or push follows from a notice or status read. `git diff <target> <commit>` compares what was actually checked even if the branch has since moved.

## Export a goal record on request

In the owner, read `foundry_status({run, detail:"proof"})` afresh. Save **only** its non-null `qualification` object as `qualification.json` at the operator's chosen location. A null record means no export: don't assemble a replacement from status, Git or a writer's claim. A passing `productCheck` alone (including a v1 seeded or ongoing product) is not a goal. A v1 fixed-grain goal and a v2 chartered goal both need separate runner receipts on the same accepted commit; a baseline may qualify with no outputs.

`foundry-qualification/v1` names the committed contract and direction, checked target ref and revision, qualified commit, and the evaluator path, commit and exit code for each verdict. `outputs` describes the pins declared by this accepted join, not every retired assignment. Each includes its captured version, charter, specification, boundary files, accepted task where available (v1 uses the pinned specification), component receipt, reviewed base, parentless generation, and direct/transitive input pins. Paths to conserved files resolve at `contract.commit`; evaluator paths resolve at the receipt's commit. The record omits native IDs, tokens, kickoffs, decisions/answers, usage and raw evaluator output. Review the included behavior text and repository paths before sharing.

For a repinned goal, `foundry-qualification/v2` adds `receipts.goal.evaluatorRevision`. The bundle includes this commit. The product is still `receipt.commit`; only the final goal used the files changed between `contract.commit` and `evaluatorRevision`. Never replay the product check against a repinned harness or the goal against the original harness.

The JSON is an **owner-reported result**, not a signature, permission to execute the evaluators, or a way to resume the ledger. Git verifies object identities, not who ran the checks. Obtain the record through a trusted channel.

### Transfer the Git objects only when requested

An ordinary clone need not have the product or its **parentless** captures and generations. If the operator also wants those bytes, choose a private staging directory outside the checkout and review the disclosure first: the bundle contains the referenced trees **and reachable history**, not just the diff. Use a trusted copy of [qualification.mjs](../scripts/qualification.mjs), Git and Node. `helper`, `manifest` and `bundle` below stand for absolute paths selected by the operator; `bundle` must be a new file.

```sh
# From the complete source checkout, where Foundry retained the pins:
node "$helper" pack "$bundle" < "$manifest"

# Transfer qualification.json and the bundle by the operator's chosen channel.
# From a clean, independent clone of the same repository and object format:
node "$helper" import "$bundle" < "$manifest"
```

If making the clean clone from a local repository, use `git clone --no-local --no-tags --single-branch --branch "$branch" -- "$source" "$dest"` (`branch` is the short target name). This copies branch history rather than hard-linking the entire source object store.

`pack` reads only the content-addressed refs needed by this record, not every run or branch. `import` checks the exact advertised IDs and refs, verifies and unbundles the objects, then creates only `refs/foundry/objects/<oid>` in one transaction. It refuses missing/extra heads, mismatched object IDs or existing destination pins; a failed import may leave unreachable objects, not a partially updated branch. Neither side checks out, updates a target, contacts a remote, pushes or installs Foundry. Use `git diff <target.commit> <commit>` and `git show <receipt.commit>:<receipt.check>` for inspection. Review or landing is a separate decision.

If separately asked to replay **trusted** checks, use a disposable detached checkout at `qualification.commit`, not the moving target branch. For a v2 goal replay, use a separate export of that same product and overlay the exact changed files (including deletions and executable bits) from the recorded evaluator diff. Run the recorded evaluator paths from the appropriate root with the required environment/observations; for `productCheck`, `FOUNDRY_OUTPUTS` is the JSON map of output IDs to directories. The original receipts and a new replay are different evidence.

## Only on a separate cleanup request

Read `foundry_status({run, detail:"cleanup"})` in the owning session. Its private `handoff.writers` are **prospects**, not an archive list. Each is a current, included, component-checked grain with a confirmed `create_session` receipt issued by the owner. A writer can create another writer; the run owner does not thereby own the grandchild. Skip both delegated writers and known delegating parents. Never substitute an old worker, scout, helper, sibling, name match or cascading archive. Ongoing legacy discovery can report a checked revision without offering writers. With no prospects, keep the sessions.

### Inspect one writer, read-only

Use the [preflight](../scripts/archive-check.mjs) **from the canonical root of the owner's local checkout**. It reads JSON on stdin; supply values as data, never interpolate session names/paths into executable shell text. For each prospect, build `{ "handoff": <fresh owner status.handoff>, "native": <facts below> }`. The following are normalized observations, **not** assumed response fields. Use the actual ID returned by native creation. If the host exposes multiple ID forms, require an authoritative match, never translate by name. Don't put a default `false` on a missing field.

| `native` field(s) | Required current evidence |
| --- | --- |
| `caller`, `coordinator`, `id`, `name` | Actual calling session ID, verified direct native coordinator ID, exact writer session ID and current display name. Match the owner and its recorded creation. Use `get_session({project_session_id:id})` and the native coordination tree. A global listing, sidebar nesting, or Foundry membership alone does not prove authority. |
| `workspace`, `path`, `branch` | Confirm a private **local linked worktree** from native workspace metadata; use `"local-worktree"`, its absolute canonical root, and its full `refs/heads/...` or **verified detached** `null`. Missing branch is not detached. Never a remote, shared branch checkout, symlink or guessed path. |
| `activity`, `ongoingWork` | Refresh `get_sessions_status()` and `get_session` for this exact writer. Require `"idle"` **and** verified finished with no ongoing, queued, interrupted or waiting work (including plans, permissions, input, tasks, shells and workflows). Idle can mean waiting. Yesterday's task list or successful submit isn't a fresh task inspection. |
| `openPR`, `agentMerge` | No open associated PR **and** no open PR on the writer branch. Check native PR metadata and current forge state for the exact repository/head, including fork identity if relevant; an unlinked PR still counts. Read `manage_agent_merge({session_id:id})` without change arguments. Require disabled, or a definitive not-applicable result on a verified PR-less session. A lookup failure is not “off.” |
| `automation` | `get_session_automation({session_id:id})` positively shows **no attachment**, even disabled. Archive removes an attached automation. |
| `nestedWork`, `externalWork` | Verify the complete native child/task and workspace context: no nested sessions to cascade, shared checkout, other run or responsibility, external jobs, unsaved drafts, unique artifacts or other persistent work. Use scoped native details and the actual tree/task inventory, not just `handoff.writers`. The local file check below does not prove these negatives. |

All six work/PR/merge/automation flags must be **explicitly false**. If your host doesn't expose authoritative evidence (in particular for descendants, background or external work), **keep the writer**. Don't wake it, disable anything, ask another writer to archive it, or try Archive to find out.

Run `node <skill-base-dir>/scripts/archive-check.mjs offer` with that JSON on stdin. Exit 0 with `offer` means this writer can be *offered*. An error, missing data, or disagreement means keep it; report the reason briefly. The helper executes no app tools, opens no ledger and creates no refs, index or backup. It checks:

- The linked worktree and its private Git state, frozen generation, current target, and retained generation/candidate/product OIDs. A moved HEAD, reset-away history, extra private state, ambiguous registration or changed index is not safe to discard.
- The complete disk file set, raw blob bytes and executable bits against the **capture** (including ignored/untracked files inside **and outside** the grain). The real index must still match the generation. The captured grain must match that subtree in the **qualified product**. A clean `git status`, branch ancestry, or equality to the whole joined checkout is not this proof.

This deliberately narrow check can decline harmless work: staged changes, empty extra directories, special/linked files, missing reflogs, uncommon Git layouts and moved targets. It checks Git-representable content, not the value of ACLs, extended attributes, mount contents or app data. Require separate evidence for material outside that model; if unique or unverifiable, keep. Never clean, commit, stash, delete or “fix” a writer to make the check pass.

### Explicit choice and last check

1. Present each **verified** writer by its display name, exact ID and grain at the checked product SHA. Use `ask_user` with **Keep** (default) and **Archive _name_ (_ID_)** as choices. Selecting the named writer is the opt-in; don't ask the user to type its name or ID. Explain that native Archive stops its CLI and removes the worktree; session history remains. Retain the exact `offer` for that individual. A run start, status request, silence, “all idle”, general cleanup request, notification or a worker message is **not** this choice.
2. Only for an unambiguous, direct operator selection in this owner, read `foundry_status({run, detail:"cleanup"})` and **all** native evidence again. Run `node <skill-base-dir>/scripts/archive-check.mjs recheck` with `{ "handoff": <new projection>, "native": <new facts>, "selected": <the exact offer the operator selected> }`. Never reuse the earlier inputs or fabricate a selection from the new status. This reruns the Git/filesystem proof as well; an earlier successful offer is not a lease.
3. On exit 0 with `{ "tool": "archive_session", "arguments": { "id": "…" } }`, **immediately** call the native `archive_session({id})` in the owner for that ID only. Do not batch, loop over a run, use Delete, or substitute shell cleanup. Respect any native confirmation/refusal. A delay, intervening change, lost result or uncertainty means stop; never automatically retry. Repeat the two passes and opt-in separately for another named writer.

The helper cannot authenticate a copied status, a host observation or a human choice; obtain each from its indicated source. Native Archive takes an ID, not a compare-and-swap token. Neither the helper nor the permission prompt can make cross-tool reads atomic. If quiescence through the action isn't verifiable, do not call it.

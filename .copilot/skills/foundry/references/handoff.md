# Hand the checked product to its owner

In the owning session, read `foundry_status({run})`. For a non-null `handoff`, report the outcome in one sentence, using full object IDs: **“Goal passed at `<commit>` against `<targetRef>` at `<target>`. The branch was not updated.”** For `mode: "one-off"` say **“Seeded product passed”** instead; for `"ongoing"` say **“Product check passed; discovery has no final goal.”** For a goal checkpoint without acceptance, say the goal hasn't qualified. An idle notification or component pass is not a product verdict.

Stop there. Keep the sessions. No archive offer, usage query, export, landing or push follows from a notice or status read. `git diff <target> <commit>` compares what was actually checked even if the branch has since moved.

## Export a goal record on request

In the owner, read `foundry_status({run, detail:"proof"})` afresh. Save **only** its non-null `qualification` object as `qualification.json` at the operator's chosen location. A null record means no export: don't assemble a replacement from status, Git or a writer's claim. A passing `productCheck` alone (including a v1 seeded or ongoing product) is not a goal. A v1 fixed-grain goal and a v2 chartered goal both need separate runner receipts on the same accepted commit; a baseline may qualify with no outputs.

`foundry-qualification/v5` names the contract, target, accepted product, included outputs and their prerequisite pins. Each observation has `inputs`: its own commit, checker path/blob/Git mode, scope, and any immutable source replacements. An overlay takes **every listed path** from its named revision, including an absent file and a file reverted to its original value. A replaced checker comes from its recorded revision, not necessarily from the product or overlay commit. The goal's `productEvaluatorRevision` identifies the product generation; it is not the goal's checker source.

The JSON is an **owner-reported result**, not a signature, permission to execute the evaluators, or a way to resume the ledger. Git verifies object identities, not who ran the checks. Obtain the record through a trusted channel.

After a mixed target adoption, `contract.activation` is the original plan commit and `contract.commit` the accepted contract. Read each writer's charter and specification at its own `outputs[].base`. `outputs[].receipt` is the standalone capture; `receipts.product.components[id]`, when present, is a **different observation** on the joined commit. Neither substitutes for the product or goal. Product `inputs.scope.outputs` lists the owners in execution order, including exclusions; a mixed grant contributes only its primary directory to the compatibility `FOUNDRY_OUTPUTS` environment.

**Earlier runs:** `inputEvidence:"signed"` means the source owner verified the original signed recipe. `"reconstructed"` means an older signed observation plus retained immutable inputs establish the recipe; no historical document was changed or signed again. A fixed directory name alone cannot establish the scope protocol, nor a signed pass an unrecorded prepared build. V5 also cannot represent the privileged environment of a historical foreground lane, including one used only inside a joined check. Owner status withholds the portable record (`qualificationUnavailable` explains why); it neither revokes the product verdict nor grants the old permission again. Previously saved v1–v4 manifests remain readable for object transfer only. Get fresh owner proof rather than deriving an evaluator overlay from a net Git diff or treating the old manifest as exact execution evidence.

### Transfer the Git objects only when requested

Choose what to share. A **v5 replay bundle contains the complete effective file tree for each selected check**, not a directory inferred from its ownership or just a checker diff. A prepared component also discloses the pristine tree actually used for its build. `disclosure.subject` and optional `disclosure.preparation` give the exact tree and parentless carrier commit. `disclosure.overlay` lists every selected overlay path, original blob and mode, or `null` for absence. The original commit IDs in `inputs` are **provenance**, not bundle heads. Ancestor commits, superseded bytes not used by a selected recipe, unrelated overlay-source paths and private scheduling blobs are not replay inputs. Inspect the selected snapshots before sharing; Foundry cannot redact a secret committed in a tree the checker actually saw.

Use the same trusted four files on both sides: [qualification.mjs](../scripts/qualification.mjs), [materialize.mjs](../scripts/materialize.mjs), `recipe.mjs` and `git-files.mjs`, together in one directory. The offline CLI requires Git and Node.js **22.18.0 or later in 22.x, or 24.2.0 or later** (`import.meta.main`). No extension, original checkout, or ledger is required. Choose absolute paths. The bundle must be new. Replay requires a filesystem with verifiable POSIX ownership and modes. Choose a new private staging directory outside **every** Git worktree and Git administrative directory, with canonical (not symlinked) parents, no ambient `package.json` or `node_modules`, and no untrusted writers or ACLs.

```sh
# In the source repository with the verified Git inputs:
node "$helper" pack "$bundle" release < "$manifest"

# Transfer the owner's record and bundle by the chosen channel.
# In a private, even empty, repository of the same Git object format:
node "$helper" import "$bundle" release < "$manifest"
mkdir -m 700 "$stage" || exit 1
destination="$stage/export"
launch_plan="$stage/launch.json"
node "$helper" materialize release "$destination" < "$manifest" > "$launch_plan"
```

`release` is the default for v5 pack/import: joined components in their recorded order, then product and goal. `product` includes its required joined components and product; `goal` and `joined:ID` name individual observations. Standalone captures are disclosed only when explicitly selecting `component:ID` or `all`. Use the **same selection** for pack and import. Materialize that selection or a subset whose carriers were imported. `git init --object-format=sha1` (or `sha256`, matching the source) is sufficient.

Both pack and import audit the complete pack in a new isolated object store. The advertised heads must match; every carrier must have exactly the declared tree, recipe binding and no parent. Every packed object must belong to those snapshots. An extra unadvertised object is rejected **before any recipient object is adopted**. Import creates only `refs/foundry/replay/<carrier>` in a create-only transaction. A late ref conflict can leave validated, unreachable objects, not partially updated refs. Nothing here executes a build or checker, requests permission, or modifies a branch.

### Inspect or independently observe one check

`materialize` writes isolated raw Git files to a new destination and returns `foundry-launch/v2` JSON. Each ordered step has a role, working directory (`cwd`), executable, argument array (`argv`) and explicit environment. Preparation uses a separate pristine export, empty output directory and a digest-verified private copy for each component. A joined group builds independently of standalone observations. The final pre-goal verification exclusively creates its empty private feedback file; even an empty pre-existing file stops replay. Never reuse a plan: generate a fresh v2 plan and destination after interruption or an upgrade. Inspect it first; don't run a plan received from somebody else or use a shell to interpret its arguments.

**Only if separately authorized to run the trusted code:** use the locally generated plan in order, including its verification/copy steps. Keep its trees private and unchanged until finished. Supply only freshly approved host variables, not the whole ambient environment:

```js
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (plan.format !== "foundry-launch/v2") throw Error("Rematerialize with the current trusted scripts");
for (const step of plan.steps) {
  const env = {PATH: process.env.PATH, ...step.env};
  for (const [name, file] of Object.entries(step.envFiles ?? {}))
    env[name] = readFileSync(file, "utf8");
  const r = spawnSync(step.executable, step.argv, {
    cwd: step.cwd, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity
  });
  for (const [stream, bytes] of [[process.stdout, r.stdout], [process.stderr, r.stderr]])
    if (bytes?.length) await new Promise((done, fail) => stream.write(bytes, err => err ? fail(err) : done()));
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(`${step.role}: ${step.kind} ${r.signal ? `was terminated by ${r.signal}` : `exited ${r.status}`}`);
}
```

The child receives no caller stdin, and none of its standard streams is a terminal. The guide does not detach a controlling terminal: run it without one if a check might prompt through `/dev/tty`. Stdout and stderr are forwarded as bytes after each step. This separate observation does not change or renew an original deadline. A private directory is not a sandbox: run only trusted programs, with no concurrent writers to the staging area. Once all replay processes have exited, remove **only the private staging directory you created**, including the plan, exports, prepared bytes and feedback. Do not clean a checkout or remove the recipient repository.

If `inputs.delta` is present, the digest and inline-delivery flag are **not** the private data or a retrieval address. Materialization refuses without independently authorized matching text: append `--delta-file /absolute/path/to/private.json` to the `materialize` command if available. Its raw contents never appear in the launch description. A missing or different build, private input or carrier is not evidence of a pass. A replay is a new local observation, not a ledger attempt or a replacement for the original signature.

**Original history is a separate disclosure.** Only when the operator explicitly asks for original commits and **all reachable history** (e.g. for landing), use `pack --history "$bundle"` and `import --history "$bundle"` with the owner record on stdin. This retains exact original pins at `refs/foundry/objects/<oid>`; it is not a replay import. V1–v4 only support this explicitly selected mode. An earlier v5 record without carrier disclosures needs a fresh owner proof for replay. No missing evidence or failed replay switches modes automatically.

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

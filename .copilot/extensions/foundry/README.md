# Foundry

Foundry coordinates a committed product brief from an ordinary repository session, not the Copilot app's Projects feature. Writers regenerate independent directories in native worktrees. A passing milestone is progress, not the finish line: squads inspect the remaining gap on the combined tree and choose the next work under the same authorization. Foundry records the exact commit that satisfies the goal and leaves the destination branch untouched.

Use [`/foundry brief <idea>`](../../skills/foundry/references/brief.md) to work through the product decisions and confirm the outcome before the brief is written. To run `.foundry/catalog.json`, use [`/foundry start catalog`](../../skills/foundry/references/runs.md#start). The skill resolves the name to the committed path the runtime needs. `/foundry` shows the [commands](../../skills/foundry/SKILL.md#commands); `/foundry plans` lists plan names in this checkout. Confirming a brief does not start workers.

### See what can run in parallel

`/foundry status <run-id>` opens a read-only dependency map in the desktop app. Each arrow goes from a required output to the assignment that uses it. A solid line means the input is checked; a dashed line means it is still outstanding. Select an assignment to see its current prerequisites, direct dependents and check result. An assignment waiting for input isn't a blocked run, and a checked output isn't a qualified product. Open **Product evidence** for the checkpoint and final goal result.

The owner's **Product evidence** also shows elapsed time to the first confirmed writer and to qualification, when known. The map refreshes while visible, using the same session-scoped status read as the command. It never advances or starts a run. Without a run, ask for the **example dependency map** to see a labeled, static file-catalog example.

## Commit the contract

For a goal run, commit what the product must do, not a list of implementation tasks. Give each squad disjoint writable `areas`, a charter describing its responsibilities, shared interface files (`boundary`), and trusted component `checks`. Pin check helpers in `boundary` too. Keep all of these files and both product evaluators outside every writable area.

```json
{
  "version": 2,
  "id": "catalog",
  "direction": "A customer can find a product and see its current price.",
  "target": "refs/heads/main",
  "productCheck": ".foundry/checks/catalog-invariants.mjs",
  "goalCheck": ".foundry/checks/customer-lookup.mjs",
  "squads": [
    {
      "id": "browse",
      "charter": "squads/browse.md",
      "areas": ["src/browse"],
      "boundary": ["interfaces/search.d.ts"],
      "checks": [".foundry/checks/browse-unit.mjs"]
    },
    {
      "id": "offers",
      "charter": "squads/offers.md",
      "areas": ["src/offers"],
      "boundary": ["interfaces/pricing.d.ts"],
      "checks": [".foundry/checks/price-unit.mjs"]
    }
  ]
}
```

Save this as e.g. `.foundry/catalog.json`. The policy is read from the activating checkout's `HEAD`, not from uncommitted edits. `target` is an existing local branch. Foundry checks that the target still contains the pinned policy, specifications, interfaces, charters and evaluators. A changed contract needs an explicitly authorized new run ID.

By default, Foundry starts every ready assignment in parallel. Set `limits.workers` to a positive integer to cap concurrent scouts and writers. Foundry keeps the cap confirmed at activation: when a slot frees up, the next ready assignment can start without an operator turn. Dependent work waits for its checked inputs. Native helpers inside a writer do not use Foundry slots; Copilot manages their concurrency and permissions.

For an unattended run, `limits.assignments` optionally caps **total** work across all checkpoints, reloads and resumes. Each reserved scout (even in a batch), new writer, or bounded repair costs one assignment, including a repair returned directly to the same writer. Refusal does not refund a reservation. Helpers, verification and retrying or recovering the original call do not count. At the limit, existing assignments and checks can finish. An unfunded proposal does not hold up verification of independent outputs; a one-off still needs every seeded output. `foundry_status` shows `assignments.used`, `assignments.limit` and the blocker. Zero allows verification of an already-good baseline; omitting the bound leaves total assignments unlimited. This is not a credit ceiling. `limits.repairs` separately defaults to one repair per writer output (zero is valid), and `limits.deadline` accepts an optional ISO timestamp.

`productCheck` tests invariants that a useful intermediate tree must preserve. `goalCheck` tests the whole brief: in this example, look up a product through the customer-facing interface and check the returned price. Confirm that the evaluator fails on an unfinished product, not just that it passes on a sample. Exit **0** when the goal is met, **1** when a required behavior is missing, or **2** when a required external observation is unavailable. Print what is missing. Other exits and infrastructure failures block the run.

Foundry checks the baseline before staffing anyone. If it meets the goal, the milestone evaluator must pass on the same commit before Foundry accepts it. Otherwise, when the goal evaluator knows which squad owns the gap, it can print exactly one `FOUNDRY_SQUAD=<squad-id>` line to stdout with exit 1. Foundry asks that squad first. A missing, ambiguous or unknown hint starts full discovery; if the named squad has no actionable work or its candidate is blocked, the search widens. The hint does not change any charter.

Ready writers start without a new activation or user turn. As soon as the admitted outputs are checked, Foundry checks the combined product without waiting for unrelated scouts. A report that adds work before the check settles invalidates that candidate, not its component receipts. If no actionable work remains or the outputs reproduce a previously failing tree, status reports the gap and the reasons; the checkpoint is retained, not accepted as the goal.

### Discover and split work

The run starts without assignments. Foundry dispatches ready charters to a `foundry-scout` workflow. Each scout gets a bounded packet of Git evidence from the exact assessed commit, the goal diagnostic and the relevant graph. It has no tools, session worktree or submit token. It returns one structured report; Foundry checks its citations, ownership and dependencies before releasing a writer. One slow charter does not hold up the others. A squad's optional native `agent` selects its **writer**, not its scout.

For example, a browse scout can separate the query editor from the work that actually needs pricing. If an earlier plan still has a never-issued `lookup` assignment, its replacement can look like this (other report fields omitted):

```json
{
  "replace": ["lookup"],
  "grains": [
    { "id": "query", "task": "Preserve the typed query across navigation.", "directory": "src/browse/query", "check": ".foundry/checks/browse-unit.mjs" },
    { "id": "lookup", "task": "Look up the entered query and display the returned price.", "directory": "src/browse/lookup", "check": ".foundry/checks/browse-unit.mjs", "needs": ["query", "price"] }
  ]
}
```

Before adding `needs`, name in `reason` **which checked output the consumer needs to start and why**. A prerequisite ID must already exist or be proposed in the same report. In the example, `query` can edit text using the committed interface; it doesn't need the pricing implementation. Propose `query` and `price` in parallel. Only `lookup`, which connects the checked editor to the checked price lookup, waits for both. If a producer hasn't reported yet, propose the independent work now and defer integration. A fixture-backed editor alone cannot satisfy the customer lookup goal.

- A split is all-or-nothing. The directories must be disjoint, IDs unique, and the resulting graph free of cycles and dangling dependencies, including other squads' consumers. Use `replace` to remove your own never-started assignments. A scout cannot displace an issued writer, bounded repair, refused or uncertain call, or an output awaiting its milestone check.
- Each review accepts one result. Replaying it does nothing, and a superseded review cannot change a newer plan. A later checkpoint or a newly blocked or repeated area assignment supplies new evidence for discovery without another operator turn.
- **A checkpoint preserves the tree, not the division of work.** You can request a checked output by ID, or propose new directories and IDs anywhere inside your charter. For example, after `src/browse` passes, propose `src/browse/query` and `src/browse/results` together. An overlapping checked name is retired automatically; `replace` can also retire a checked name explicitly. Old commits, receipts and files outside the new assignments stay intact. Checked names that depended on the superseded version retire with it. If a current assignment still uses that version, the split is rejected. Unaffected checked outputs remain available by name.
- A refused assignment cannot be retried, but it no longer pins its inputs. A conflict with a moving target is rechecked on participant turns: resolving the edit or releasing its last live input can unblock the run without overriding a refusal.
- If a batch reproduces a tree that already failed the goal, status marks its new outputs `repeated`, not qualified. A scout can split them or use them as checked inputs. A new ID or report does not restart the same assignment on the same base with the same inputs, even after a pause. Change the task, boundaries or actual prerequisites. If a pending prerequisite later resolves to the same input, that never-issued job is marked blocked and can be replaced. None of these cases creates a checkpoint.
- `no-gap` requires a complete packet. Every citation must match a text-bearing path and blob ID in the journaled packet. On partial coverage use supported positive work, or request one in-scope `file` using `needs-evidence`. A focused read is bounded and never gives a scout tools.
- Use `waiting` with `waitFor` and `grains: []` if an area charter cannot proceed until another charter has a checked output. Foundry reopens the consumer once per changed set of producer outputs. It still needs an explicit grain dependency to use those files. Use `needs-decision` with `grains: []` for an unresolved question. The owner’s clarification is input to one fresh review of the same charter and revision, not to an unrelated writer or a different brief. If it still requires a contract change, stop for a newly authorized brief.

**Fixed contracts:** version 1 retains its committed `grains` (`id`, `directory`, `specification`, `boundary`, `check`, optional `needs`) and squad-to-grain ID lists. Existing runs do not acquire broader authority on resume. For an explicitly requested one-off, use version 1 with `seed` and no `goalCheck`: a passing `productCheck` qualifies that batch. Unseeded version-1 discovery without a goal still reviews changes to chartered inputs on participant turns. A host trigger can wake an existing run, not authorize one.

## Four operations

| Tool | Who uses it | Result |
|---|---|---|
| `foundry_start({source})` | Operator's session, on explicit request | Confirm a new or paused run. A seed names the requested grains; otherwise start charter review. |
| `foundry_submit({run,token})` | Bound writer, from its worktree | Capture the whole directory and run its committed evaluator. Ready work is picked up internally. |
| `foundry_status({run})` | Owner or bound participant | Read assignments, blockers and receipts. The owner also sees current questions, timing facts, checkpoint, and qualified handoff. In a goal run, `qualified` stays null until both checks pass. No side effects. |
| `foundry_pause({run})` | Owner | Stop new work. Retain worktrees, assignments, issued calls and results. |

**Tool permissions:** Autopilot controls how the session works, not what it may execute. Before confirming a start or resume, Foundry reads the owner's managed settings and selected tool permission mode. If settings are unresolved, unreadable, or set to Manual, it reports the blocker without running a baseline or starting workers. Use Assisted if your policy allows it; Allow All is not required. Foundry never changes settings or approves a tool call. A ready owner does not guarantee prompt-free tools, hook registration, or permissions in a child.

### Regeneration and checks

- Each writer starts at a retained Git commit with **no parent and no old copy of its grain**. Its specification, interface and required outputs are present. A goal writer's brief names the `Reviewed input revision`: the baseline or checkpoint its squad reviewed. Only if the grain specification explicitly permits it may the writer consult its own prior directory at that SHA. Foundry copies none of it. This generation context is not an OS sandbox against reading repository history.
- **Within one assignment**, the writer starts native `task` agents in parallel for independent pieces: for example, one implements an encoder and another a decoder, while the writer owns the shared exports. Helpers share the worktree and input restrictions, not the submit token. The writer collects the results, reviews and integrates the files, and submits once. Small changes and bounded repairs can stay solo. There is no second scheduler, desktop session, or Foundry approval. Submission reads this session's native task list before capture. A running agent or a failed lookup leaves the same attempt writable; idle agents and unrelated shells don't hold it up. Helper reports are never evaluator receipts.
- For version 2 the charter is the fixed specification; the proposal supplies the assigned behavior. Component evaluators receive `FOUNDRY_GRAIN` and `FOUNDRY_DIRECTORY`, so one committed check can exercise newly discovered units. The milestone evaluator receives `FOUNDRY_OUTPUTS`, a JSON object mapping just this candidate's output IDs to directories, for repair attribution.
- Submission captures the whole assigned directory, including ignored files and executable bits. Missing files are deletions; a missing directory removes the unit. Foundry builds the tree in a temporary Git index, leaving the writer's staging area and neighboring edits untouched. If Git ignores a reserved pathname, submission reports that path instead of silently publishing a partial directory.
- Checks run via the host's native `bash` permissions. The shell needs `node` with `node:sqlite` on `PATH` to launch the runner; the desktop Copilot binary is not a Node interpreter. `.js` and `.mjs` evaluators use that Node; other evaluators must be executable. Raw Git blobs are streamed into a temporary directory, without smudge filters, export substitutions or the writer's uncommitted files. Use externally installed dependencies or temp space outside the product. End with the product unchanged. Symlinks, submodules, special files and case-aliased paths are unsupported. As with other local builds, run only trusted repository code.
- A component failure returns its bounded repair to the responsible writer. A failed product evaluator can print exactly one `FOUNDRY_REPAIR=<grain-id>` line to stdout to identify responsibility. Changing a shared output regenerates consumers pinned to its superseded version, but preserves past qualified commits and their receipts. An unattributed product failure keeps the checked components and reports a blocker. If a later observation adds a missing grain, the next candidate includes those components without staffing them again. A native refusal or infrastructure error is not a failed implementation.
- The product check freezes the **combined** outputs on the current target tip. If new work is admitted or the target moves during evaluation, the old result cannot qualify the new candidate. Nonoverlapping target edits are incorporated and rechecked; incompatible edits to an owned directory block rather than disappear. Inspect the final changes with `git diff <target-tip> <qualified>`. A generated candidate has the evaluated target tip as its parent; if the baseline already passed, `qualified` is the tip itself. Foundry does not land it.
- Every seeded output is required. In discovery, if a grain is blocked, independent outputs can still qualify **if the product evaluator passes**. Its blocked grain and dependents remain visible and are not marked complete.

### Hand off and measure the result

Qualification reserves a notice to the owner in the same ledger transition that records the checked product. Use `handoff.commit` and `handoff.target` to inspect **exactly** what passed: `git diff <checked-target> <qualified>`. The branch is not updated. A notice may still await native delivery; the qualified result remains readable from status. For a portable record use `foundry_status({run, detail:"proof"})` in the owner. The [handoff guide](../../skills/foundry/references/handoff.md#export-a-goal-record-on-request) explains how to transfer the retained objects and replay trusted checks in another clone; a SHA alone is not delivery.

Keep writer sessions after handoff. Only if the operator separately requests cleanup, follow the [owner handoff guide](../../skills/foundry/references/handoff.md) for the named writer, including a fresh check immediately before the action. Unknown, unique, or ongoing work means **keep the session**.

[`/foundry measure <run-id>`](../../skills/foundry/references/metrics.md) reports wall time from activation to the first writer's verified kickoff in native history and to exact product qualification. It distinguishes kickoff from Foundry's confirmation of a writer binding, which can arrive later after recovery. Missing history is unknown. A reservation is not a writer; a checkpoint is not a finished goal. A successful baseline may need no writer. Count only observed writer usage attributable to this run, not lifetime totals or estimates for the owner, helpers or workflows.

### Interruptions

Before issuing new work, including a `prepared` call, Foundry checks the **issuing session's** permissions. If managed settings are resolved and that session has selected **Manual**, only its unissued calls are held. `foundry_status.pending` shows the reason and issuer; other authorized sessions continue. After selecting a permitted mode in the held session, its next turn rechecks the original reservation. No owner restart or replacement worker is needed.

If managed policy is unresolved, restricts the selected mode, or cannot be read, Foundry pauses the run. `foundry_status.blocker` names the session to check. Once the settings are ready, the owner explicitly resumes with the same `foundry_start({source})`. Both kinds of hold preserve receipts and reservations. Neither reroutes a call or retries an uncertain start.

For an exit-2 goal receipt, supply the missing observation and have the owner pause and explicitly resume the run. Confirmation reserves a fresh check of the retained candidate, keeping the previous receipt. A moved target must be incorporated and checked before it can qualify. Ordinary turns do not retry an unavailable observation; a denied or uncertain call is not an exit-2 receipt.

Foundry records reservations before issuing native calls. Only an explicitly unavailable, definitely unissued native session route yields an ordinary `prepared` call. Execute it **once, unchanged, in its issuing session**. A confirmed denial blocks the assignment and releases its slot. Recovery reads backward to the start of the issuing turn: an older permission decision is not evidence for this call. Missing or conflicting receipts stay pending and never cause another creation.

Scouting requires an eligible Dynamic Workflows runtime. Foundry does not substitute desktop scouts if it is unavailable. A bound workflow can return evidence through a pause, but cannot issue work while paused. On reconnect, Foundry reads the original workflow's outcome rather than launching a second one. If a dispatch was interrupted *before* the workflow bound it, the owner may pause and explicitly resume to retry that read-only discovery. This does not retry an uncertain writer creation.

A queued repair is not proof the recipient acted. A native permission or input request remains with its actual session. Pausing stops new work; an already-issued check may finish, and its result is applied on resume. A confirmed nonzero launcher exit before the runner started blocks the check and frees its slot, even after reload. It is not an evaluator failure or a reason to retry. Once the runner starts, only its own receipt can settle the evaluation.

Foundry processes parallel replies independently, including after reload. A slow history lookup does not hold up an unissued assignment or a slot freed by a confirmed refusal. The unresolved start still occupies its own slot and is never sent again. If the issuing session switches to plan mode while waiting, Foundry records the reply but starts no follow-up work there until an interactive or autopilot turn.

If a long check finishes after `submit` returns, a matching shell completion wakes the scheduler. Only the runner's recorded verdict can issue a repair. If that writer is driving the run, Foundry queues a notice in its own session to read the new token; otherwise the usual cross-session repair applies. An unconfirmed notice stays pending rather than being sent again.

Foundry retains versions and generation bases in `refs/foundry/objects/`. Linked worktrees share `foundry/work.sqlite` in the repository's common Git directory. This runtime uses ledger protocol **13**. A reported review retains its packet coverage, delivered path/blob IDs, checked versions the scout saw, and any event that reopened it. Qualification belongs to the checked product. Older ledgers are refused, not migrated or deleted. Leave an old clone intact; use a fresh clone for a new run.

## Development

The dotfiles `sync` operation installs the extension and Foundry skill. Test the repository copy in disposable Git fixtures, not a running factory. The host supplies the SDK; TypeScript and Node declarations are development-only.

```sh
npm ci --prefix .copilot/editor
npm --prefix .copilot/editor run check
node --experimental-vm-modules --test '.copilot/extensions/foundry/**/*.test.mjs' '.copilot/extensions/recon/**/*.test.mjs'
FOUNDRY_FACTORY_MATRIX=1 node --test --test-name-pattern 'factory matrix:' .copilot/extensions/foundry/work/runtime.test.mjs
node --test .copilot/extensions/foundry/test/journey.test.mjs
FOUNDRY_FACTORY_MATRIX=1 node --test .copilot/extensions/foundry/test/wide.test.mjs
node .copilot/extensions/foundry/types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS DEPENDENCY_ROOT .copilot/extensions/recon
```

The optional factory matrix runs named, reproducible scenarios in fresh repositories using real worktrees, SQLite and evaluator processes. It varies refusal, target movement, pause/reopen, dependency order, capacity, repair and lost replies. It also synchronizes two writer processes and exits one before or after its runner writes a receipt. Native worker and permission responses are scripted, not desktop sessions. To reproduce one scenario, keep the environment setting and select its printed name with `--test-name-pattern`. The ordinary suite includes representative scenarios.

`node --test .copilot/extensions/foundry/test/helpers.test.mjs` exercises parallelism **inside** one assignment. Two threads hold separate files partially written in the same writer worktree. The simulated native task list prevents premature capture; after both finish, the bound writer integrates them and the real evaluators check the result. For a live trial, use the writer's actual session workspace and record overlapping native `task` calls as well as the checked commit. Two different writer sessions do not demonstrate this.

The outbox and stock journeys each use four squads and nine directories. After at least four passing checkpoints they introduce a component or combined-product failure. Their scripted workers respond only to delivered assignments or a repair returned by their own submit, not to an owner polling status for work. A late receipt must lead to one more, qualified checkpoint; no receipt must leave the existing checkpoints intact. Other cases pass a milestone with an implementation that still fails the end-user journey: scouts must use that failure to revise existing work and qualify a later checkpoint without a new kickoff.

The wide transit and clearing factories use separate writer processes against one ledger per product. A rendezvous measures 12 or 16 overlapping component checks, including after a checkpoint. One check stays open until an independent district finishes; its own dependent must still be waiting. Clearing also repairs a shared journal after three checkpoints and checks that only its consumers rerun. With the repair receipt withheld, they must stay waiting. The rendezvous measures concurrency, not speedup.

**Native end-to-end testing** is separate. Use a fresh registered clone with a committed brief, interfaces and evaluators, but no implementation or scripted workers. Calibrate the goal in a disposable copy: a working control should pass; breaking one promised behavior should fail. The operator starts the run in its owning desktop conversation. Record workflow scout calls, native writer sessions, and both receipts at the same `qualified` commit. To measure a speedup, compare the old and new versions on separate fresh clones of that same commit with the same model, worker cap and finish condition. Compare the two elapsed times and label usage by its actual coverage. A fixture pass, fewer sessions or overlapping work alone does not establish a speedup.

On a fresh desktop session, check for **register hooks** permission cards in that session before diagnosing a scheduler stall. The app can create the worktree and session before its kickoff is delivered. A successful reload in the parent does not answer the child's cards; don't launch a replacement.

Run the installed-SDK checker after fixtures finish. Work modules have single-word names and one responsibility. Persisted records have independent types in `work/model.d.ts`; validate decoded data at the storage boundary.

`work/plan.mjs` derives ready writers' input pins and which outputs can be checked together. `work/reviews.mjs` decides which charter can review a given version. Neither decision needs a checkout or reserves work. `advance` supplies Git revisions, reserves writers before scouts, and charges a slot only when a reservation succeeds. An already-reserved native call is a different case: a refusal releases its slot but not its total assignment.

### Goal-verdict contract for a blind rebuild

Give an independent implementation this rule, not the scheduler or its tests: return the last accepted goal commit only if the run stopped at that product and target, and its distinct product and goal evaluations both have an unambiguous runner-started, completed receipt for **that commit and the corresponding committed check**, each with exit `0`. Otherwise return no verdict. A passing baseline needs no writer. A passed milestone without final acceptance, receipts from different commits, a successful native shell reply without a runner receipt, and exit `2` are negative controls. One-off and ongoing product passes are not goal verdicts.

Compare coordinators on the same starting Git commit, fixed worker cap, and independent checks. Count false acceptances, stalls, duplicate launches, and extra operator turns before comparing time or spend. Keep the production runner and target-branch protections fixed throughout.

### Installed-SDK checker contract

For an occasional blind rebuild, give a fresh writer only the contract below and `jsconfig.json`; hold back the original `types/` and its test. Run the same test against the original, the rebuild, and a disposable copy that checks only the primary extension. Both working versions must pass, and the primary-only copy must fail specifically because it accepted the bad companion. This is a development exercise, not a phase of a Foundry run.

`types/` is a replaceable development tool. Its entry point is `node types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS [DEPENDENCY_ROOT [ADDITIONAL_EXTENSION]]`. The first three arguments are required; missing arguments must fail with usage. Resolve caller-supplied paths from the working directory. Find the primary extension one directory above `types/`, regardless of where the command is invoked.

Check all `.mjs`, `.js` and `.ts` files recursively in the primary extension (including the checker) and the optional additional extension. Refuse source symlinks rather than following them. Use the primary extension's `jsconfig.json` compiler options, replacing `typeRoots` with the supplied directory and `paths` with the supplied SDK's `index.d.ts` and `extension.d.ts` for `@github/copilot-sdk` and `@github/copilot-sdk/extension`. If given a dependency root, resolve `vscode-jsonrpc/node.js` to its `vscode-jsonrpc/lib/node/main.d.ts`. Run the supplied TypeScript CLI with Node, forward its diagnostics and exit status, and fail if it cannot complete. Leave the input trees unchanged and remove temporary configuration even on failure. No Git history, other extension sources, or installed Copilot service are inputs.

To try a replacement, set `FOUNDRY_TYPES_GRAIN` to its `types/` directory and run `node --test .copilot/extensions/foundry/test/types.test.mjs`. The same check should accept a clean companion extension and diagnose a type error introduced **only** in that companion.

# Foundry

Foundry works toward a committed product brief. Writers regenerate independent directories in parallel. A passing milestone is progress, not the finish line: squads inspect the remaining gap on the combined tree and choose the next work under the same authorization. Foundry records the exact commit that satisfies the goal and leaves the destination branch untouched.

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

By default, Foundry starts every ready assignment in parallel. Set `limits.workers` to a positive integer only if you want to cap simultaneous scouts and writers. Native helpers inside a writer do not use Foundry slots; Copilot manages their concurrency and permissions. Omitting the limit means no worker cap or capacity prompts, even if other limits are set. `limits.repairs` defaults to one checked repair per writer output; zero is valid. `limits.deadline` accepts an optional ISO timestamp.

With a cap, when all slots are assigned **and another assignment is ready now**, the owner's session offers **Keep** or **Increase**. Work continues while you decide. Keep or dismiss the choice to stop capacity questions for this run. Increase sets the cap to the number shown if work is still waiting. Existing runs retain their confirmed limits across reload and resume. With or without a cap, dependent work waits for its checked inputs.

`productCheck` tests invariants that a useful intermediate tree must preserve. `goalCheck` tests the whole brief: in this example, look up a product through the customer-facing interface and check the returned price. Confirm that the evaluator fails on an unfinished product, not just that it passes on a sample. Exit **0** when the goal is met, **1** when a required behavior is missing, or **2** when a required external observation is unavailable. Print what is missing. Other exits and infrastructure failures block the run.

Foundry checks the baseline before staffing anyone. If it meets the goal, the milestone evaluator must pass on the same commit before Foundry accepts it. Otherwise, when the goal evaluator knows which squad owns the gap, it can print exactly one `FOUNDRY_SQUAD=<squad-id>` line to stdout with exit 1. Foundry asks that squad first. A missing, ambiguous or unknown hint starts full discovery; if the named squad has no actionable work or its candidate is blocked, the search widens. The hint does not change any charter.

Ready writers start without a new activation or user turn. As soon as the admitted outputs are checked, Foundry checks the combined product without waiting for unrelated scouts. A report that adds work before the check settles invalidates that candidate, not its component receipts. If no actionable work remains or the outputs reproduce a previously failing tree, status reports the gap and the reasons; the checkpoint is retained, not accepted as the goal.

### Discover and split work

The run starts without assignments. A bound scout reports `outcome: "regenerate"`, cites files on its reviewed revision, and proposes one or more *grains*: complete, independently checkable directories. The owner and scouts can read current assignments and dependencies in `foundry_status.nodes`. Each squad may specify an installed native `agent`.

For example, the browse scout initially proposed a `lookup` directory that waits for `price`. It discovers the query editor needs only the committed interface. With the `nextToken` returned by its last report it can submit this change while the pricing writer is still working (other `observe` arguments omitted):

```json
{
  "replace": ["lookup"],
  "grains": [
    { "id": "query", "task": "Preserve the typed query across navigation.", "directory": "src/browse/query", "check": ".foundry/checks/browse-unit.mjs" },
    { "id": "lookup", "task": "Look up the entered query and display the returned price.", "directory": "src/browse/lookup", "check": ".foundry/checks/browse-unit.mjs", "needs": ["query", "price"] }
  ]
}
```

`needs` means **the writer needs that checked output to start**, not that the finished product will eventually use it. A prerequisite ID must already exist or be proposed in the same report. If its producer hasn't reported yet, propose independent work now and defer integration. In the example, `query` and `price` can run together; only `lookup` waits. A fixture-backed editor alone cannot satisfy the customer lookup goal.

- A split is all-or-nothing. The directories must be disjoint, IDs unique, and the resulting graph free of cycles and dangling dependencies, including other squads' consumers. Use `replace` to remove your own never-started assignments. A scout cannot displace an issued writer, bounded repair, refused or uncertain call, or an output awaiting its milestone check.
- A report and its token are immutable; replaying it does nothing. Only the bound scout may use its next token for a follow-up on the same assessed revision. It need not follow up for work to proceed. A later checkpoint gets fresh reviews.
- **A checkpoint preserves the tree, not the division of work.** You can request a checked output by ID, or propose new directories and IDs anywhere inside your charter. For example, after `src/browse` passes, propose `src/browse/query` and `src/browse/results` together. An overlapping checked name is retired automatically; `replace` can also retire a checked name explicitly. Old commits, receipts and files outside the new assignments stay intact. Checked names that depended on the superseded version retire with it. If a current assignment still uses that version, the split is rejected. Unaffected checked outputs remain available by name.
- A refused assignment cannot be retried, but it no longer pins its inputs. A conflict with a moving target is rechecked on participant turns: resolving the edit or releasing its last live input can unblock the run without overriding a refusal.
- If a batch reproduces a tree that already failed the goal, status marks its new outputs `repeated`, not qualified. A scout can split them or use them as checked inputs. A new token, label or report does not restart the same assignment on the same base with the same inputs, even after a pause. Change the task, boundaries or actual prerequisites; an unchanged plan is rejected without consuming the follow-up token. If a pending prerequisite later resolves to the same input, that never-issued job is marked blocked and can be replaced. None of these cases creates a checkpoint.
- Use `no-gap` or `needs-decision` with `grains: []` for no actionable work or an ambiguous contract. Put the question in `reason` and cite the conflicting committed evidence. A question starts no writer and does not veto independent work. To change the contract, pause and record the operator's decision in the conserved files; it requires a new run ID and explicit authorization.

**Fixed contracts:** version 1 retains its committed `grains` (`id`, `directory`, `specification`, `boundary`, `check`, optional `needs`) and squad-to-grain ID lists. Existing runs do not acquire broader authority on resume. For an explicitly requested one-off, use version 1 with `seed` and no `goalCheck`: a passing `productCheck` qualifies that batch. Unseeded version-1 discovery without a goal still reviews changes to chartered inputs on participant turns. A host trigger can wake an existing run, not authorize one.

## Five operations

| Tool | Who uses it | Result |
|---|---|---|
| `foundry_start({source})` | Operator's session, on explicit request | Confirm a new or paused run. A seed names the requested grains; otherwise start charter review. |
| `foundry_observe({run,token,outcome,reason,evidence,grains,replace?})` | Bound scout | Propose work, split pending or checked directories, report no gap, or raise a contract question. |
| `foundry_submit({run,token})` | Bound writer, from its worktree | Capture the whole directory and run its committed evaluator. Ready work is picked up internally. |
| `foundry_status({run})` | Owner or bound participant | Read assignments, blockers and receipts. The owner sees questions and, in a goal run, the latest `checkpoint`, the `goal` assessment and final `qualified` commit (null until both checks pass). No side effects. |
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

### Interruptions

Before issuing new work, including a `prepared` call, Foundry checks the **issuing session's** permissions. If managed settings are resolved and that session has selected **Manual**, only its unissued calls are held. `foundry_status.pending` shows the reason and issuer; other authorized sessions continue. After selecting a permitted mode in the held session, its next turn rechecks the original reservation. No owner restart or replacement worker is needed.

If managed policy is unresolved, restricts the selected mode, or cannot be read, Foundry pauses the run. `foundry_status.blocker` names the session to check. Once the settings are ready, the owner explicitly resumes with the same `foundry_start({source})`. Both kinds of hold preserve receipts and reservations. Neither reroutes a call or retries an uncertain start.

For an exit-2 goal receipt, supply the missing observation and have the owner pause and explicitly resume the run. Confirmation reserves a fresh check of the retained candidate, keeping the previous receipt. A moved target must be incorporated and checked before it can qualify. Ordinary turns do not retry an unavailable observation; a denied or uncertain call is not an exit-2 receipt.

Foundry records reservations before issuing native calls. Only an explicitly unavailable, definitely unissued native session route yields an ordinary `prepared` call. Execute it **once, unchanged, in its issuing session**. A confirmed denial blocks the assignment and releases its slot. Recovery reads backward to the start of the issuing turn: an older permission decision is not evidence for this call. Missing or conflicting receipts stay pending and never cause another creation.

A queued repair is not proof the recipient acted. A native permission or input request remains with its actual session. Pausing stops new work; an already-issued check may finish, and its result is applied on resume. A confirmed nonzero launcher exit before the runner started blocks the check and frees its slot, even after reload. It is not an evaluator failure or a reason to retry. Once the runner starts, only its own receipt can settle the evaluation.

Foundry processes parallel replies independently, including after reload. A slow history lookup does not hold up an unissued assignment or a slot freed by a confirmed refusal. The unresolved start still occupies its own slot and is never sent again. If the issuing session switches to plan mode while waiting, Foundry records the reply but starts no follow-up work there until an interactive or autopilot turn.

If a long check finishes after `submit` returns, a matching shell completion wakes the scheduler. Only the runner's recorded verdict can issue a repair. If that writer is driving the run, Foundry queues a notice in its own session to read the new token; otherwise the usual cross-session repair applies. An unconfirmed notice stays pending rather than being sent again.

Foundry retains versions and generation bases in `refs/foundry/objects/`. Linked worktrees share `foundry/work.sqlite` in the repository's common Git directory. This runtime uses ledger protocol 10 for both contract formats. It does not open or migrate a protocol-9 run; a new run ID or linked worktree still uses the old database. Leave that clone intact and use a separate clone with a fresh ledger for a new run.

## Development

The dotfiles `sync` operation installs the extension and skill. Test the repository copy in disposable Git fixtures, not a running factory. The host supplies the SDK; TypeScript and Node declarations are development-only.

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

**Native end-to-end testing** is separate. Use the installed personal extension in a fresh registered Git repo with a committed brief, interfaces and evaluators, but no implementation or scripted workers. Calibrate the trial goal in a disposable copy: a working control should pass; breaking one promised behavior at a time (such as accepting an invalid option) should fail. Keep those controls out of the trial repo. The operator starts the run in its owning desktop conversation. Record actual scout and writer sessions, overlapping activity, subsequent deliveries, and the product and goal receipts at the same `qualified` commit. An activation prompt, an issued assignment, a passing fixture suite or a checkpoint alone is not an end-to-end pass.

On a fresh desktop session, check for **register hooks** permission cards in that session before diagnosing a scheduler stall. The app can create the worktree and session before its kickoff is delivered. A successful reload in the parent does not answer the child's cards; don't launch a replacement.

Run the installed-SDK checker after fixtures finish. Work modules have single-word names and one responsibility. Persisted records have independent types in `work/model.d.ts`; validate decoded data at the storage boundary.

For an occasional blind rebuild, give a fresh writer only the contract below and `jsconfig.json`; hold back the original `types/` and its test. Run the same test against the original, the rebuild, and a disposable copy that checks only the primary extension. Both working versions must pass, and the primary-only copy must fail specifically because it accepted the bad companion. This is a development exercise, not a phase of a Foundry run.

### Installed-SDK checker contract

`types/` is a replaceable development tool. Its entry point is `node types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS [DEPENDENCY_ROOT [ADDITIONAL_EXTENSION]]`. The first three arguments are required; missing arguments must fail with usage. Resolve caller-supplied paths from the working directory. Find the primary extension one directory above `types/`, regardless of where the command is invoked.

Check all `.mjs`, `.js` and `.ts` files recursively in the primary extension (including the checker) and the optional additional extension. Refuse source symlinks rather than following them. Use the primary extension's `jsconfig.json` compiler options, replacing `typeRoots` with the supplied directory and `paths` with the supplied SDK's `index.d.ts` and `extension.d.ts` for `@github/copilot-sdk` and `@github/copilot-sdk/extension`. If given a dependency root, resolve `vscode-jsonrpc/node.js` to its `vscode-jsonrpc/lib/node/main.d.ts`. Run the supplied TypeScript CLI with Node, forward its diagnostics and exit status, and fail if it cannot complete. Leave the input trees unchanged and remove temporary configuration even on failure. No Git history, other extension sources, or installed Copilot service are inputs.

To try a replacement, set `FOUNDRY_TYPES_GRAIN` to its `types/` directory and run `node --test .copilot/extensions/foundry/test/types.test.mjs`. The same check should accept a clean companion extension and diagnose a type error introduced **only** in that companion.

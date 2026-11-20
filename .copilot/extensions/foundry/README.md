# Foundry

Foundry regenerates whole directories and produces a **checked Git commit**. A seed selects the work directly; otherwise, scouts identify gaps under their squads' charters. Writers regenerate independent directories in parallel. Foundry runs the committed product evaluator on their combined Git tree and records the exact commit that passed. The destination branch stays put.

## Commit the contract

Keep the direction, each unit's specification and interface, and both levels of evaluator in the repository. A *grain* is one regenerable unit. Its directory belongs to it exclusively. Conserved files must live outside all grain directories.

```json
{
  "version": 1,
  "id": "catalog",
  "direction": "A customer can find a product and see its current price.",
  "target": "refs/heads/main",
  "productCheck": ".foundry/checks/customer-lookup.mjs",
  "grains": [
    {
      "id": "search",
      "directory": "src/search",
      "specification": "spec/search.md",
      "boundary": ["interfaces/search.d.ts"],
      "check": ".foundry/checks/search.mjs"
    },
    {
      "id": "pricing",
      "directory": "src/pricing",
      "specification": "spec/pricing.md",
      "boundary": ["interfaces/pricing.d.ts"],
      "check": ".foundry/checks/pricing.mjs"
    }
  ],
  "seed": ["search", "pricing"]
}
```

Save this as e.g. `.foundry/catalog.json`. The policy is read from the activating checkout's `HEAD`, not from uncommitted edits. `target` is an existing local branch. Foundry checks that the target still contains the pinned policy, specifications, interfaces, charters and evaluators. A changed contract needs an explicitly authorized new run ID.

By default, Foundry runs up to two independent assignments in parallel and allows one checked repair per writer output. `limits.workers` and `limits.repairs` override those defaults; zero repairs is valid. `limits.deadline` accepts an optional ISO timestamp.

Scouts and writers share the cap. When all slots are assigned **and another assignment is ready now**, the owner's session offers **Keep** or **Increase**. Work continues while you decide. Keep or dismiss the choice to stop capacity questions for this run. Increase sets the cap to the number shown if work is still waiting. The decision survives pause/resume without changing the contract. Work waiting for a dependency is not a reason to ask.

For ongoing work, **omit `seed`** and add flat `squads`, e.g.:

```json
"squads": [
  { "id": "browse", "charter": "squads/browse.md", "grains": ["search"] },
  { "id": "offers", "charter": "squads/offers.md", "grains": ["pricing"] }
]
```

A charter owns named grains and may specify an installed native `agent`. A scout cites files at its assigned revision: the charter, policy, or code and contracts of its grains and their declared dependencies. It can request changes only to grains it owns. A new participant turn (including a native child-idle notification) revisits discovery when the chartered inputs change, not just because time has passed. A host trigger can wake an existing run, not authorize one.

An observation has one `outcome`: `regenerate` names the grains to rebuild; `no-gap` and `needs-decision` take `grains: []`. For `needs-decision`, write the contract question in `reason` and cite the conflicting evidence. The report starts no writer and does not veto other work. Owner status lists each squad's latest reported question until a newer observation supersedes it; the original stays in review history. To change the contract, pause the old run, decide whether to use its qualified work, and record the operator's answer and rationale in the spec or shared interface on the target branch. Start the revised contract under a new ID only on explicit direction.

Use `"needs": ["pricing"]` if a writer consumes the pricing output. There is one current writer per grain, even when multiple squads request the same prerequisite. If search and pricing are independent, their squads can report separate gaps and their writers can run in parallel. Once the requested outputs are ready, `productCheck` sees both together.

## Five operations

| Tool | Who uses it | Result |
|---|---|---|
| `foundry_start({source})` | Operator's session, on explicit request | Confirm a new or paused run. A seed names the requested grains; otherwise start charter review. |
| `foundry_observe({run,token,outcome,reason,evidence,grains})` | Bound scout | Request regeneration, report no gap, or raise a contract question. An exact replay does not request work again. |
| `foundry_submit({run,token})` | Bound writer, from its worktree | Capture the whole directory and run its committed evaluator. Ready work is picked up internally. |
| `foundry_status({run})` | Owner or bound participant | Read assignments, input versions and receipts. The owner also sees outstanding questions and the exact qualified output. No side effects. |
| `foundry_pause({run})` | Owner | Stop new work. Retain worktrees, assignments, issued calls and results. |

### Regeneration and checks

- Each writer starts at a retained Git commit with **no parent and no old copy of its grain**. Its specification, interface and required outputs are present. This is a generation context, not an OS sandbox against reading repository history.
- Submission captures regular files and executable modes under the assigned directory, not arbitrary edits or a worker's assertion of success. Missing files are deletions; a missing directory removes the unit. Neighboring source and uncommitted work in the operator's checkout are not copied.
- Checks run via the host's native `bash` permissions. `.js` and `.mjs` evaluators use Node; other evaluators must be executable. Raw Git blobs are streamed into a temporary directory, without smudge filters, export substitutions or the writer's uncommitted files. Use externally installed dependencies or temp space outside the product. End with the product unchanged. Symlinks, submodules, special files and case-aliased paths are unsupported. As with other local builds, run only trusted repository code.
- A component failure returns its bounded repair to the responsible writer. A failed product evaluator can print exactly one `FOUNDRY_REPAIR=<grain-id>` line to stdout to identify responsibility. Changing a shared output regenerates consumers pinned to its superseded version, but preserves past qualified commits and their receipts. An unattributed product failure keeps the checked components and reports a blocker. If a later observation adds a missing grain, the next candidate includes those components without staffing them again. A native refusal or infrastructure error is not a failed implementation.
- The final check freezes the **combined** outputs on the current target tip. If new work is admitted or the target moves during evaluation, the old result cannot qualify the new candidate. Nonoverlapping target edits are incorporated and rechecked; incompatible edits to an owned directory block rather than disappear. `qualified` is the exact commit that passed, with the evaluated target tip as its parent. Inspect its changes with `git diff <qualified>^ <qualified>`; ordinary fast-forward or cherry-pick preserves deletions from that tip. Foundry does not land it.
- Every seeded output is required. In discovery, if a grain is blocked, independent outputs can still qualify **if the product evaluator passes**. Its blocked grain and dependents remain visible and are not marked complete.

### Interruptions

Foundry records reservations before issuing native calls. Only an explicitly unavailable, definitely unissued native session route yields an ordinary `prepared` call. Execute it **once, unchanged, in its issuing session**. A confirmed denial blocks the assignment and releases its slot. Missing or ambiguous receipts stay pending, never cause another creation, and can be reconciled from that session's original tool history. A queued repair is not proof the recipient acted. A native permission or input request remains with its actual session. Pausing stops new work; an already-issued check may finish, and its result is applied on resume. A runner records its own exclusive check receipt; a lost process without a receipt cannot declare success or authorize replay.

Foundry retains versions and generation bases in `refs/foundry/objects/`. Linked worktrees share run state at `foundry/work.sqlite` in the repository's common Git directory. Foundry checks the store's execution protocol before using it and leaves an incompatible store untouched.

## Development

The dotfiles `sync` operation installs the extension and skill. Test the repository copy in disposable Git fixtures, not a running factory. The host supplies the SDK; TypeScript and Node declarations are development-only.

```sh
npm ci --prefix .copilot/editor
npm --prefix .copilot/editor run check
node --experimental-vm-modules --test '.copilot/extensions/foundry/**/*.test.mjs' '.copilot/extensions/recon/**/*.test.mjs'
node .copilot/extensions/foundry/types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS DEPENDENCY_ROOT .copilot/extensions/recon
```

Run the installed-SDK checker after fixtures finish. Work modules have single-word names and one responsibility. Persisted records have independent types in `work/model.d.ts`; validate decoded data at the storage boundary.

For an occasional blind rebuild, give a fresh writer only the contract below and `jsconfig.json`; hold back the original `types/` and its test. Run the same test against the original, the rebuild, and a disposable copy that checks only the primary extension. Both working versions must pass, and the primary-only copy must fail specifically because it accepted the bad companion. This is a development exercise, not a phase of a Foundry run.

### Installed-SDK checker contract

`types/` is a replaceable development tool. Its entry point is `node types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS [DEPENDENCY_ROOT [ADDITIONAL_EXTENSION]]`. The first three arguments are required; missing arguments must fail with usage. Resolve caller-supplied paths from the working directory. Find the primary extension one directory above `types/`, regardless of where the command is invoked.

Check all `.mjs`, `.js` and `.ts` files recursively in the primary extension (including the checker) and the optional additional extension. Refuse source symlinks rather than following them. Use the primary extension's `jsconfig.json` compiler options, replacing `typeRoots` with the supplied directory and `paths` with the supplied SDK's `index.d.ts` and `extension.d.ts` for `@github/copilot-sdk` and `@github/copilot-sdk/extension`. If given a dependency root, resolve `vscode-jsonrpc/node.js` to its `vscode-jsonrpc/lib/node/main.d.ts`. Run the supplied TypeScript CLI with Node, forward its diagnostics and exit status, and fail if it cannot complete. Leave the input trees unchanged and remove temporary configuration even on failure. No Git history, other extension sources, or installed Copilot service are inputs.

To try a replacement, set `FOUNDRY_TYPES_GRAIN` to its `types/` directory and run `node --test .copilot/extensions/foundry/test/types.test.mjs`. The same check should accept a clean companion extension and diagnose a type error introduced **only** in that companion.

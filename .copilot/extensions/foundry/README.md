# Foundry

A lean repository-local factory for explicitly authorized engineering work. Many native workers
and local coordinators execute; a shared record model is not a central executing agent.

## Execution

`foundry_start_goal` records scope, explicit execution mode and optional actual limits, and
deterministically compiles task definitions. `foundry_create_task` adds useful parent-local work.
Task scope is a set of narrowing overrides: omitted fields inherit and restrictions are unioned
automatically. Repeating or omitting an inherited restriction never removes it; actual expansion
of paths, work types, autonomy or delegation is still rejected.
`foundry_prepare_dispatch` prepares complete native `create_session` calls; pre/post hooks record
their actual issuance and returned identity while the child executes. No setup acknowledgment,
attachment, activation, global DAG reapproval or duplicate completion approval exists.

Use `foundry_start_task` for in-session work or deterministic jobs. Tasks need stable check IDs,
check origin and versioned named inputs/outputs, not a fixed organizational chart. Teams and work
types are open-ended. Dependency edges require outputs; delegation is a tree, not serialization.
Independent writers use native worktrees; claims are specific to actual shared mutable surfaces.

`foundry_evolve_task` replaces derived checks or declared inputs using the affected task's version,
not a whole-factory revision. User, contract and standing checks remain unchanged. It retires active
superseded attempts without losing their command effects and reevaluates only unpinned dependents.
Explicit input versions resolve already-published deliveries, even while their producer evolves;
a published version cannot be reused for different output content. Signals remain advisory until
an accountable coordinator applies a concrete in-scope revision or creates appropriate follow-up work.
Real pending input requests remain attached to retired attempts; evolving a producer does not wait
for every consumer's question. Native clearance, not a graph edit, resolves those requests.

Technical outcomes use pinned command evidence. Raw command results are kept as contained private
artifacts; unsupported review opinions do not veto passing checks. A genuine failed obligation
can justify an in-scope repair. Observations and lessons remain scoped and non-governing.
Use `foundry_run_check` to prepare and execute an assigned check through the ordinary native
permission pipeline in one call. With `repair: true`, a genuine checked failure is retained and its
fresh same-worker attempt is reserved atomically under the goal's own limits. Implement the repair next; no activation,
report/retry/start chain or automatic rerun of unchanged failing code is required.
`foundry_report_result` also accepts `repair: true` for an already checked failure.
Replay returns the existing repair or retries its real capacity wait without creating duplicates.
Explicit repair/spend/deadline limits and unsettled commands retain the failure and return an
honest blocked/waiting continuation. `foundry_prepare_check` and explicit retry remain available.
An immediate warm repair does not notify the coordinator or announce momentary capacity.
A capacity-parked repair remains reserved for its original worker across reload; ordinary dispatch
cannot replace it. Its worker resumes with `foundry_start_task` or replays the exact checked report
after a capacity wake. Explicit reassignment, evolution or cancellation clears the reservation.
Only actual repair transitions consume the repair allowance; superseded attempts do not.

Every governing check supplies an executable procedure, including artifact and judgment checks.
An artifact's existence or an unsupported reviewer assertion is not an implicit pass: its assigned
procedure must validate the declared properties or the versioned review/data inputs. Human-required
decisions remain ordinary native input requests, not another Foundry approval service.
Procedures receive their actual attempt/task IDs and versioned input metadata in
`FOUNDRY_ATTEMPT_ID`, `FOUNDRY_TASK_ID` and `FOUNDRY_INPUTS_JSON`; raw results retain those inputs.
Referenced files are not automatically deep-pinned. Declare evaluator files explicitly and validate
data hashes in the procedure, or publish immutable artifact references rather than mutable paths.

### Evaluated file bundles

Checks may opt into `artifactFiles`, a nonempty list of existing repository-relative implementation
files inside the task's paths. Include the complete unit, including any required module/package files.
Declare reproducible evaluator files separately in `oracleFiles`; those files must be relative to the
repository and are copied with their pinned hashes. Use that list for required conserved dependency
or package files outside the mutable unit too; capturing them grants no editing scope. `kind`,
`path` and existing check versions are unchanged for checks without this option.

The assigned procedure runs in a private captured bundle instead of the mutable checkout.
`FOUNDRY_CANDIDATE_DIR` identifies that bundle. Raw evidence retains its file hashes, modes, candidate
version and actual versioned inputs. Changes to the bundle or evaluator during execution fail the
check; failed observations remain usable for normal same-worker repair. Historical observations
remain historical: a later broken artifact does not prevent reporting a newer checked failure.
An unusable published input returns a recorded blocker instead of reserving another consumer-code
repair that cannot restore its producer's delivery.

Use the returned `evidence.candidate.version` when reporting a code/artifact output, with either
`evidence.candidate.reference` for the unit or a declared filename for an entry file. Publication
copies only those evaluated bytes into a stable content-addressed bundle. Rechecking unchanged code
does not invent a different delivery reference. Every artifact-bound governing check for one task
must identify the same final file set/version; old passes from another candidate cannot be combined.
The canonical store enforces this as well as the runtime report path.

Consumers receive the captured delivery's actual reference through `FOUNDRY_INPUTS_JSON`.
Managed file bundles are hash-checked at evaluation and publication boundaries. Integration must
declare and evaluate its own final unit; producer receipts alone do not accept combined code.
This is one opt-in plain-file format, not automatic pinning of undeclared dependencies, external
data, installed packages or deployment state. Existing procedures retain their original execution
directory and behavior. Workers executing this new option need the updated extension.

## Persistence and recovery

Operational authority is `<git-common-dir>/foundry/work.sqlite`, shared by repository worktrees,
using WAL and short synchronous transactions. Ownership follows native identity and task ancestry,
not session-folder equality. Inputs, evaluators and attempt tokens are immutable snapshots.
Current-attempt guards protect publication, readiness, repair and resource settlement.

Old databases and source artifacts remain untouched. There are no migrations, old-format readers,
compatibility modes or parallel authorization ledgers. Repository-owned `.foundry` contracts
describe meaning, not competing operational authority. A source contract has `format:
"foundry-contract"`, `version: 1`, a title, scope and task definitions.

Prepared and issued creation are distinct. Reconcile actual returned native identity rather than
recreating uncertain work. Generated names and native receipts normalize whitespace; recovery of
an issued name still requires an unambiguous match and verified native creator/project identity.
Native permissions remain authoritative; a token or caller JSON cannot
grant scope. Cancelling logical work is independent of conversation lifetime. Known commands and
claims remain tracked until settled; no automatic archival or global terminal attestation.
Known local shells are stopped through ordinary native `stop_bash` in their actual worker session;
coordinators send cooperative notices listing all affected attempts and known commands rather than
trying the worker's shell IDs in their own session. Settled finished attempts are not woken.
Actual command completion,
or a native stopped-shell receipt for that exact shell, releases capacity. A queued stop message
alone does not. A definitely rejected stop retries on a later
owner turn with its original failure retained; definitely unavailable recipients are recorded
without repeated delivery. An ambiguous delivery is not blindly replayed.
Context retains relevant outstanding command identities and superseded attempts until settlement.
An existing worker retains visibility of its actual outstanding shells after coordinator handoff,
and can yield or resume its current execution under the same goal limits without acquiring the replacement coordinator's
delegation authority. Inspecting its original native session
does not overwrite a newer warm attempt or reject already-bound historical identity.

Reassignment retires definitely unissued dispatches before preparing fresh attempts. Issued native
creation keeps its original creator; a new accountable coordinator can reconcile it without
recreating the child or losing the reassignment. Existing workers execute their pinned checks;
coordinators can report admitted results using the canonical execution identity, with the actual
reporting coordinator retained separately. A late stop identifies its old attempt, never a newer one.
`foundry_reassign_team` retains a charter and its delegated leaves while transferring coordinator-owned
units. Unknown replacements require one actual native inspection, not a new approval handshake.
Scoped signals go to accountable coordinators rather than already-finished leaves.
Team charters organize existing scoped ownership; they do not grant a leaf root-level delegation.
New work follows the goal owner or an existing delegating task in the same canonical tree.

`foundry_prepare_command` gives ordinary commands explicit affinity when multiple local units execute.
Without explicit affinity, one ambiguous command conservatively retains all possible units' slots
and claims until actual settlement; cancelling one unit cannot stop unrelated shared work.
Generated shell identities come from native telemetry. Repeated generic follow-up IDs do not identify
a command without its actual shell.

Optional recorded-worker caps are atomic and shared by descendants of each goal. Unrelated goals
do not contend for these per-goal slots; dormant work never blocks an uncontended admission.
Waiting parents resume through the same allocator. Owner-directed wakes are
coalesced per owner/goal, with one in-flight or unconsumed native notification. Sending one
generation cannot consume a newer update. An uncertain native delivery remains tracked rather than
being blindly repeated. Observed AI-credit accounting is not a hard native spend ceiling.
Actual command settlement requests one coalesced notification drain for the affected goal, including
native completion and post-hook stopped-shell receipts. Late cancelled or superseded commands may
release capacity without needing a current execution attempt for notification bookkeeping.
Native observations and sends retain their original store through directory changes/shutdown;
they never settle a claim against a replacement store. Send-completion events do not recursively
trigger retries. This live event bridge is not an independent dead-session watchdog.
Native `assistant.usage` receipts debit the canonical store automatically using the runtime's
source/sequence identity and reported nano-AI units, not token estimates. Request-start affinity
keeps late charges on their actual old attempt; early child receipts wait for verified native
binding. Shared calls debit a known goal once, without inventing an attempt split; cross-goal
ambiguity stays unallocated. Receipt aliases deduplicate native redelivery and manual observations.
Use the returned receipt ID or actual native event ID for any manual observation, not a new label.
Accounting exposes unavailable billing as `reportedCredits: null`, distinguishing it from a
reported zero. Captured records and affinity survive reload, but transient SDK events do not provide
history/restart-gap recovery: `captureComplete` remains false and missing spend is never called zero.
Pure coordinator notifications use native-delivery records in the same work store and need no
executing worker slot. Definitely unavailable recipients are recorded and wake their nearest
accountable ancestor without appointing a new owner or replaying the failed delivery.
Operational context uses scoped current-record queries; full historical snapshots are for inspection.
Coordinator contexts summarize procedures without repeating entire kickoffs and executable bodies.
Request the assigned `taskId` for its complete execution definition.
The store owns ancestry authorization and context visibility; runtime only projects those records.
Deep outstanding commands remain visible to accountable ancestors without expanding ordinary
parent-local context or giving handed-off workers management rights.

All new wake sends use one delivery lifecycle, optionally attributed to an attempt. Original
in-flight message effects remain settleable without replay; they are not new worker execution.
Native receipt IDs and aliases use a derived SQLite lookup maintained for every writer.
Conflicting identities remain explicit errors rather than silently dropping or double-charging a receipt.
Idle turns retain one boundary per native agent group, not one row per turn. The boundary has no
attempt or assignment token; late active receipts and refinements retain their actual identities.
Focused accounting includes the requested goals and correlated ambiguity, not lifetime unrelated
session spend. Uncorrelated charges and missing history remain outside that subtotal, never proof
of complete billing. Goal priority is not a supported setting; per-goal admission is not a scheduler.

## Board and standalone workflows

The `foundry-board` canvas accepts an optional `goalId` and shows goals, ownership, checks, inputs,
outputs and outstanding effects. Refresh reads current canonical records. It introduces no UI
approval workflow.

Standalone `audit`, `deep-research`, `review-queue`, `security-review` and `triage` workflows remain
available under their existing explicit activation rules. Factory execution does not require them.

## Development

Source is dotfiles-managed in `.copilot/extensions/foundry/`; `sync` mirrors it to the user extension
directory. For scoped development, mirror only this extension and its directly updated skills, then
reload extensions. Do not run the entire dotfiles sync to test this component.

```sh
node --experimental-vm-modules --test '.copilot/extensions/foundry/**/*.test.mjs'
node .copilot/extensions/foundry/types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS DEPENDENCY_ROOT
```

The SDK is supplied by the extension host, not a new package dependency. The second command checks
every owned source and test directly against its bundled declarations with strict checking; there
are no offline protocol shims.

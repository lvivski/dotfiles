# Foundry

A lean repository-local factory for explicitly authorized engineering work. Many native workers
and local coordinators execute; a shared record model is not a central executing agent.

## Bounded factories

Ordinary `foundry_start_goal` work stays activation-free. Unattended factories opt in with
`foundry_start_factory`, a repository-owned `.foundry` JSON document with `format:
"foundry-factory"` and `version: 1`, and actual native-owner mode inspection. The user's direct
request to start or restart within the agreed policy scope is authorization; no separate activation
dialog is required. Native permissions remain authoritative. Installation, scheduling, hook messages,
and completion events never authorize a start or restart, and do not activate it automatically.
Only the current Foundry protocol and canonical schema are supported.

Required policy fields are `id`, `mechanism`, `completionTaskId`, and
`goal`. The goal uses the ordinary title/scope/limits/task format, with stable task template IDs.
`goal.scope.mode` governs worker execution, not the main coordinator's conversation mode.
`native` continuation requires Autopilot workers, but its coordinator may be interactive or Autopilot.
An interactive coordinator can ask the user questions; after a natural stop, it resumes on native
messages, user input, or an explicitly scheduled heartbeat, not an automatic stop-hook loop.
Exclusive `stop-hook` continuation requires interactive workers and coordinator, an observed
natural-stop hook, and a positive `blocks` continuation bound. Omitted `blocks` resolves to the
version-1 internal safeguard of 3 forced continuations per session per activation; this is not a
performance recommendation or an override of host limits. Native factories reject `blocks`
because they do not use stop-hook continuation. All factory tasks retain the policy's worker mode. The job limit is
factory-wide; worker, observed-credit, deadline and ordinary repair limits remain per job.
Optional `aggregateRepairs` is a separate per-job debit; `unchangedFailures` bounds repeated
evaluated failures in an activation. No limits are inferred from token estimates.

`maximumJobs` defaults to 1 concurrent whole job, not 1 worker or subtask. Independent leads and
subtasks within that job can execute in parallel. Higher values require actual multi-job `source`
intake; do not select them from a count of teams, leads, or subtasks. Worker slots remain governed
only by existing dependency readiness and any explicit per-job `goal.limits.workers` ceiling.
No worker, spending, deadline, or repair limit is manufactured from these defaults.

Activation returns `settings`; context exposes the same projection in `factories[].settings`.
Each effective value has a `policy` or `default` origin, with explicit per-job limits reported
under `perJobLimits`. `policy` means present in the policy document, not proof that the user chose
the number. No runtime-limit provenance or resource-aware tuning is claimed without an actual
runtime observation. Older records without origin metadata report `unrecorded`, not guessed origins.
Resolution captures values and origins in the canonical policy snapshot without rewriting its
source file. Reload and context reads use those stored values, not current defaults or source edits.
Changing an accepted snapshot still requires a distinct policy identity; it is not an implicit
limit increase. Present effective settings without an extra confirmation or tuning questionnaire.

`foundry_advance` recovers receipts, reconciles observed owner-input answers, delivers/retries owner
notifications through the same recovery path as `foundry_get_context`, consumes the actual owner's
wakes, and classifies its local execution, dispatch, repair, resume, input, and settlement needs.
Execute complete prepared calls in the ordinary native turn, including calls returned alongside capacity blockers.
Resume an existing worker rather than recreating it. A stop hook performs classification only,
not native side effects. Unchanged re-entry and explicit continuation bounds pause work rather
than manufacture failed evaluator evidence. Safely settled local execution yields capacity while
retaining its attempt and claims; user-requested restart resumes it without a code-repair debit.
Revoked, definitely unissued creates are retired before fresh preparation. Issued creates retain
their original identity for reconciliation, never replacement.
Unknown commands, child identity and genuine input requests remain settlement blockers.

The ordinary completion task has its own executable checks and protected required inputs.
Acceptance atomically seals the transitive in-job production closure, including exact versions
and resolved inputs. Required mutable production edges must float; ordinary historical pins
outside that closure remain usable. Producer cancellation or changed accepted inputs invalidate
current delivery. Code outputs require evaluated file-bound evidence. Accepted jobs admit no new
execution, including unused alternatives, until `foundry_reopen_job`; historical publications
remain recorded. `foundry_cancel_job` cancels without claiming delivery. Neither delivery nor a
queued stop proves native execution and write claims have settled.

### Intake and reusable context

An optional `source` has `kind: "github-issue"`, `repository`, and explicitly trusted `actors`.
`foundry_ingest` inspects the actual issue through the native permission path. Both its author and
last editor must satisfy that policy. Each accepted title/body/author/editor snapshot is admitted
once; comment-only timestamp changes do not spawn another job. Source content is data, not a
permission grant. Closed or inaccessible issues and unknown provenance do not become empty jobs.
Activating an intake policy validates its template without creating a synthetic seed job.

For `foundry_poll`, also set `source.maximumEvents` explicitly (1 through GitHub's 100-item page
ceiling). It reads one native page, retains capacity-deferred events, and records the provider's
opaque cursor only under the same active owner/generation. Pages wrap for later source changes;
edits during pagination are not a stable multi-page snapshot. There is no extension-owned timer,
daemon, distributed queue, or automatic owner replacement. `foundry_set_heartbeat` takes an
explicit `everyMinutes`, requests native confirmation, inspects the actual same-session scheduler,
and binds its returned identity. One coordinator's singleton schedule covers the selected factory's
jobs; separately scheduled policies need separate native owners. Another factory or an unrelated automation is a conflict, not
permission to overwrite it. Lost acknowledgments are reconciled from matching native ownership,
prompt and cadence, never blindly resaved. A save returning after pause stays recorded for cleanup.
`foundry_pause_factory` fences admission first, then removes only the matching native heartbeat
using the ordinary-session `clear: true` route and verifies absence. The scheduled prompt only
continues an already-active policy; it never restarts one. Native abort/host-off may postpone that
ordinary-turn cleanup, but persisted fencing prevents new work in the meantime.

The host's same-session setter has no compare-and-swap argument: preflight identity checks and
local canonical issuance serialize Foundry changes, not simultaneous external edits in the app.
Conflicting observed edits stop management. Atomic exclusion of a user edit between inspection
and native mutation is not a supported guarantee. Unsupported extension-originated scheduler
routes remain explicit blockers, even when the ordinary app tools work.

Optional `charters` bind `name`, `taskIds`, declared native `agent`, `context`, and hash-pinned
`knowledgeFiles`. Curate concise evidenced knowledge explicitly in repository-owned files,
then reference their exact hashes in a new accepted policy identity. Existing assignments retain
their captured content; curation never expands another goal's mutation rights.
Factory admission lowers charter/grain membership into typed task assignment snapshots, including
captured context, the declared agent, conserved base and generator history exclusion. Dispatch
reads those snapshots, not policy JSON or task-ID suffixes. Multiple matching charters combine
context and select their one declared agent, even when the first charter declares none.

Optional `grains` declare `id`, `taskIds`, `generators`, an implementation-free `baseBranch`,
hash-pinned `specification`, nonempty `evaluators` and `boundary`, and explicit `context`.
The base resolves to a conserved commit and must contain those exact contract files.
Generator prompts exclude implicit team/lesson history and use declared specification/context.
Checks bind and deduplicate the conserved oracles; publications retain actual candidate versions.
A clean base and scoped prompt are **not an enforced old-source read sandbox**: Git history,
other worktrees and host-global files may still be readable. Audited non-consultation and enforced
unavailability are different claims. Installation, merge, deployment, automatic rollback, generic
metric languages, and native task projection are not acceptance authority provided by this core.

### Qualification boundary

A bounded local probe exercised native activation gating, an ordinary one-minute scheduler wake,
natural-stop continuation with acceptance deliberately unfinished, artifact-bound publication,
settlement and verified ordinary scheduler removal. Its factory was then paused; no production
factory or applied replacement was launched. A separate read-only extension probe confirmed actual
mode inspection and extension-originated scheduler reads. Extension-originated schedule mutations,
native task projection and applied regeneration remain unqualified; ordinary app-tool receipts
are not proof of those routes. Fresh-source provenance does not establish old-source read isolation,
and incomplete native accounting does not establish a hard hidden-model-call ceiling.

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
Propagation stops at a producer that had no published outputs; definition setup does not repeatedly
revise unrelated downstream work that has not consumed a delivery.
Explicit input versions resolve already-published deliveries, even while their producer evolves;
a published version cannot be reused for different output content. Signals remain advisory until
an accountable coordinator applies a concrete in-scope revision or creates appropriate follow-up work.
Real pending input requests remain attached to retired attempts; evolving a producer does not wait
for every consumer's question. Native clearance, not a graph edit, resolves those requests.

Technical outcomes use pinned command evidence. Raw command results are kept as contained private
artifacts. Latest evidence means **canonical admission sequence**, not command completion time;
receipt verification preserves that sequence. Reporting, promotion and publication use the same
latest-check projection. Findings remain diagnostic: a new governing obligation must become an
explicit assigned/protected check, not a second finding-based veto.
A genuine failed obligation can justify an in-scope repair. Observations and lessons remain scoped
and non-governing. Early reports retain history but never promote automatically when binding or
evidence arrives. Report explicitly again with current admitted evidence; an immutable result ID
cannot be reused for a changed observation.
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
The canonical promotion path verifies and materializes these references once; runtime reports
delegate to it. Replay of an already-promoted result normalizes references without rematerializing bytes.
For a complete evaluated unit, pass `publish: "<output name>"` to `foundry_run_check`. This explicitly
uses the existing result/promotion path without a second model turn. Partial acceptance returns the
missing/failed checks and leaves the task running; mixed candidates remain a publication blocker,
not a fabricated failed check. Publication identity follows its evaluated run and latest governing
receipts, so unchanged retries are idempotent and reevaluation cannot conflict with a paused report.
Already-published replay does not execute another command.

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

Retired operational formats are not imported. This revision has an explicit reset boundary:
quiesce old participants and reset obsolete canonical state before upgrading; mixed-version
Foundry writers remain unsupported. Factory work missing its admitted assignment snapshot is
rejected, not reconstructed from old policy. Prepared current native calls retain their original
complete requests. Schema version 2 accepts only fresh or complete current stores; previous
schemas and missing tables are rejected without migration or receipt-index backfilling.
There are no compatibility modes or parallel authorization ledgers. Wake delivery uses only
delivery records; legacy message effects and flat check receipts are unsupported. Check evidence
requires an exclusive finished receipt bound to the issued runner command. New stores omit inert
priority and pending-result columns and impossible all-null indices.
Repository-owned `.foundry` contracts
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
Each new assigned command records one fixed private runner receipt. The runner claims it exclusively
before executing, atomically finalizes it, and rejects duplicate or legacy invocations without a
replacement result. Normal context/check calls recover finished receipts only for their actual owner,
retaining `runner-receipt` provenance and evaluator/input/candidate verification. Native initial wait
is 120 seconds. A recovered check replays its existing result; use `foundry_prepare_check` for an
explicit new evaluation. Started-only receipts and ordinary commands without
actual completion remain unknown. Recovery of retired attempts admits history, not publication or repair.
Self-ended terminal attempts automatically release only their settled claims. Waiting, unknown effects
and externally ended attempts retain ownership. Warm same-worker repair atomically transfers claims
with fresh IDs, so an old release cannot release a successor's resources.
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
Successful reporting/publication queues notification draining without awaiting native message delivery.
A host-disabled session-management route is distinct from an unavailable recipient: the provider stops
retrying that route for its lifetime, retains pending messages, and returns ordinary app-tool wake/stop
arguments in context. Deliver those through the normal tool and acknowledge only the accepted wake
generation with `foundry_mark_wake_sent`. This mitigates the blocked route; it does not change host policy
or grant a privileged transport. Unknown queue acceptance still must not be blindly replayed.
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

Standalone `audit`, `deep-research`, `review-queue`, `security-review` and `triage` workflows live
in the separate `recon` extension under their existing explicit activation rules.
Both extensions load independently; factory execution does not require analysis workflows.

## Development

Source is dotfiles-managed in `.copilot/extensions/foundry/`; `sync` mirrors it and the independent
`recon` extension to their user directories. For scoped development, mirror only the
updated extension directories and their directly updated skills, then
reload extensions. Do not run the entire dotfiles sync to test this component.

```sh
node --experimental-vm-modules --test '.copilot/extensions/foundry/**/*.test.mjs' '.copilot/extensions/recon/**/*.test.mjs'
node .copilot/extensions/foundry/types/check.mjs SDK_DIRECTORY TSC_EXECUTABLE TYPE_ROOTS DEPENDENCY_ROOT .copilot/extensions/recon
```

The SDK is supplied by the extension host, not a new package dependency. The second command checks
every owned source and test directly against its bundled declarations with strict checking; there
are no offline protocol shims.

# Capability factory

Use this lifecycle whenever Foundry coordinates engineering. It does not activate Foundry for an
ordinary question, or authorize paid workflows, additional agents, commits, deployments or merges.
Capability units describe conserved behavior; bounded runtime workers divide execution,
not contract authority. One accountable App owner does not imply one executor. Default to useful
independent implementation, focused-test and skill/documentation work under the
[planning protocol](planning.md#plan-executable-workstreams-not-just-concurrent-authorship),
with concrete artifact/file/resource reasons for serialization, without fixed worker counts or new
child/resource authority.

## Authority and discovery

1. Read `foundry_get_factory` with the actual Git `repositoryPath`. The logical identity in
   `.foundry/repository.json` travels with the repository; the canonical common directory
   identifies its local execution journal. Clones recover knowledge, never native execution
   ownership. Sibling worktrees must agree on the checked-out knowledge head.
   `expectedRevision` on factory tools guards the repository ledger, not the session plan.
2. Use `foundry_define_unit` for coherent behavior, not a file or task. Declare exclusive named
   authority in `boundary.owns`, stable `exposes`/`consumes` interfaces, conserved data and user
   contracts in `preserves`, and existing capability dependencies. Reuse shared foundations.
   Unknown relationships require `relationshipCoverage: "partial"`; absence is not proof of isolation.
   A revised unit definition does not change an already accepted boundary revision.
   To revise, call `foundry_define_unit` with the same ID, the full replacement definition,
   actor and reason; use its returned `unit.revision` in the subsequent contract acceptance.
3. Exploration or an initial implementation may discover intent. Record observations, inferences,
   proposals and knowledge gaps with `foundry_record_knowledge`, source, actor, time and links.
   Draft obligations and evaluation definitions are still non-governing. Use `derived-from` to
   retain discoveries, `contradicts` for conflicting evidence, and `supersedes` for revisions.
   A revision of an existing knowledge ID must link to its preceding revision; no record is edited.
4. Recover a specification as connected obligation/evaluation revisions. Executable evaluations
   pin a `command` procedure with a version-1 Git bundle: immutable `commit`, directory `root`,
   repository-relative `entryPoint`, additional `support` paths, and `invocation: {argv, cwd}`.
   The root is protected recursively; include applicable manifests, locks, helpers and fixtures.
   Omit the procedure digest when recording a new bundle to have the service compute it;
   a supplied digest must match actual Git content and the invocation. References are
   non-executable and cannot report a passing executable check. Also declare covered
   obligation revisions, modality, environment,
   workload and maximum evidence age. Distinguish implementation tests, durable boundary checks,
   operational evidence and human judgment. Boundary and preservation checks require independent
   evidence; human evaluations require an attributed human judgment, not an AI review verdict.
5. Present the proposed contract, reasons, uncertainty and contradictions. Initial acceptance and
   changed product meaning require explicit approval before calling `foundry_accept_contract` with
   the selected unit revision, obligation/evaluation references, actor and reason. Only the conserved
   [technical renewal](#delegated-consumer-expectation-renewal) below has a separately delegated path.
   Every obligation needs an evaluator; accepted contracts require boundary and preservation
   evaluation. Known contradictions/uncertainty need attributed
   `resolutions`. Acceptance adds an immutable revision; it never edits history.
   Accepted dependency contracts, complete connected causal rationale and complete decision lineage
   are pinned. Presentation pagination does not truncate accepted context or canonical history.
   Optional `rationale` references add explanatory context but never governing obligations.

## Explicit UI and visual fidelity

At capability/plan review, explicitly identify whether the work produces UI. Do not infer this from
filenames or keywords. For UI work, record a visual obligation and an independent `command` evaluator
with `evaluation.visual: { capture, states: [{ id, intent, reference: { path, digest } }] }`.
Pin the real renderable references inside its protected Git bundle/support; `path` is relative to that
bundle's immutable commit and `digest` is SHA-256 of the file bytes. `capture` describes the actual
target-platform procedure to preflight, not a permission grant. Choose ordinary and applicable empty/
error states explicitly and explain scope omissions; retain the reference's intended composition,
navigation, pane boundaries, content hierarchy/density, typography and action placement, not an
invented feature catalog or arbitrary similarity threshold.

Then declare a successor unit revision with `visualEvaluation: { id, revision }` pointing to that
evaluator. The explicit pointer makes it a mandatory plan gate even for initial implementation
without an accepted contract/candidate; it does not accept a product contract. A new accepted
contract must include this exact evaluation, and deterministic reconstruction retains it. Historical
units, plans and evaluators remain unchanged; never rewrite them to claim retrospective coverage.
Non-UI/legacy units without this declaration retain their existing behavior. Absence of the field
is compatibility, not evidence that a known UI deliverable has adequate acceptance coverage.

Preflight viewing the actual reference and capturing output on the intended platform before UI
implementation/fan-out. Permission-blocked capture is a visible hold; never bypass OS permission or
quietly substitute controls, source, geometry, palette or compilation evidence. Both producer and
verifier must open/render the pinned reference material, not work solely from a summary.
The existing App verifier makes the independent visual assessment and reports the structured
[visual evidence](verification.md#visual-evidence) through the existing evaluation path. No new
agent or paid workflow is implied. Mandatory human modalities remain separate explicit judgments;
automated/model visual assessment is `independent-claim`, not aesthetic approval by a human.

## Adoption is not reconstruction

An implementation may predate its specification. After recovering and accepting its contract, use
`foundry_prepare_candidate` with `mode: "adoption"`, empty `context.generation`, the existing artifact
in `comparisonOnly`, and independence method `existing-artifact` with its real origin. Record the
existing delivery using its original source time/identity, independently evaluate it, and obtain an
explicit selection decision. Never retroactively describe it as generated from the recovered spec.
Adoption does not create a fresh-generation plan or count as a reconstruction proof.

## Fresh candidates and replacement

1. `foundry_prepare_candidate` pins the current accepted contract before generation. Choose a new
   candidate ID, use `mode: "reconstruction"`, and record separate `context.generation` and
   `comparisonOnly` artifact lists (`kind`, `ref`, `digest`). Declare a fresh-session/process method
   and how context separation will actually be established. Prior implementation cannot be a
   generation input. The returned `generation` package is the future implementation input; it does
   not include comparison-only artifacts. The current implementation is unchanged.
   The ledger format remains `foundry-factory-v2`; new accepted contexts use seal version 3.
   Historical version-2 seals are retained, never silently rewritten. Source refs, run/session paths and
   source artifacts remain in the inspectable ledger rather than leaking through generation
   provenance. Comparison-only refs/digests in generation text are rejected explicitly.
   Sealed generation context retains complete authorized knowledge, evidence and lineage;
   it has no 128 KiB policy cap. Privacy and comparison-only exclusions still apply.
2. Call `foundry_create_factory_plan` with the candidate, repository, explicit file scope,
   `expectedRevision: 0` and `expectedFactoryRevision`. It deterministically assembles scoped
   implementation and read-only verifier tasks. Local source accepts optional closed `decomposition`
   for explicit packages; omission retains the one-producer/one-verifier recipe. Follow
   [decomposition compatibility](planning.md#explicit-decomposition-and-legacy-behavior).
   Registered [composed source tools](dispatch.md#bounded-registered-source-entry-points) use the
   existing lifecycle, but the default production host remains unavailable. Source registration and
   synthetic-host checks establish neither installation nor live support. Preparation launches nothing
   and proves neither reservation nor execution. Follow ordinary
   submit/approve/reserve rules and [recipe-specific startup](dispatch.md#fresh-complete-kickoff-and-legacy-replay):
   fresh complete immutable kickoff/receipt/corroboration/attachment/short activation; stored legacy
   reservations alone replay original setup/corroborate/attach/full-handoff unchanged.
   App generation supplies session/attempt identity, not process identity. A `fresh-process`
   candidate cannot be bound to this path; use a genuinely external process or prepare a new
   `fresh-session` candidate. Never invent process provenance after the fact.
3. Complete implementation attempts with actual delivery, concrete evidence and `learning` entries
   (`observation`, `inference` or `proposal`, `statement`, optional `uncertainty`). Each completed
   attempt also creates a non-governing report observation with exact task/attempt/session identity.
   Explicit-package consumers use `foundry_materialize_inputs` only after exact current attachment
   and successful short activation (legacy: unchanged full handoff), then actually consume the pinned
   snapshots and preserve every delivered commit's ancestry. Fresh final-prompt sealing follows both
   factory context and any explicit input-descriptor enrichment in `operations.mjs`; receipt-only
   startup never authorizes early materialization.
4. The verifier returns all ordinary `checkId` evidence plus selected executable `factoryEvaluations`: evaluation
   `{id,revision}`, pinned `procedureDigest`, `environment`, `workload`, actual `report`, `outcome`,
   and `independenceReason`. Failures are reported as failures, not repaired by changing the oracle.
   Human modalities and judgment procedures are not App-agent checks. Show the pinned rubric to
   the human, obtain their actual verdict/reasons, then use `foundry_record_human_judgment` with
   the exact candidate/contract/context/commit/evaluator identity, actor, source and context.
   Supply the actual `judgmentId`, stable `sourceRef` and `performedAt` separately from the publication
   receipt `id`. Reuse the same source identity and original observation time when recovering publication;
   never generate a fresh judgment ID or substitute publication time for an earlier human assessment.
   Never relabel an agent report as a human judgment. `pendingHuman` and `collect-human-judgment`
   expose missing or stale human support.
   Bound candidate evidence comes only through completed attached attempts, never through an
   external delivery/evaluation tool (explicit human judgment is the separate exception).
   `foundry_assess_package` prepares/checks a delivered package subject using trusted complete current
   contributor and reviewer authority; it does not replace terminal verifier evidence, human judgment or completion approval.
   Publishable receipt invariants are checked before terminal task persistence. A wrong-commit
   report stays retryable, with a bounded non-governing rejection observation where possible.
5. Complete native verification and obtain manual plan completion approval or use a valid
   separately completion-scoped delegation [without reconfirmation](verification.md#delegated-technical-milestone-completion).
   These facts are necessary but are not replacement selection. Compare alternatives against the **same**
   contract/context definitions and pinned evaluator revisions; do not automatically spawn
   more paid agents. A delivered candidate is immutable: corrections produce another candidate
   and bounded plan, rather than relabeling a retry as regeneration.
6. With current evidence and explicit approval, call `foundry_decide_candidate` with `action`,
   `actor`, `reason`, repository revision, and exact `expectedIncumbentId`. Missing, failed,
   expired, context-mismatched or non-independent evidence blocks acceptance. The decision records
   the selected replacement and prior incumbent; it does not deploy, migrate data, merge Git, or
   delete branches. Carry out any operational cutover only under its own explicit approved work.

Initial-plan and technical-completion grants remain distinct and owner-local. Neither accepts a
product contract, supplies a human judgment, selects a replacement or grants external/resource
permission. Immutable package inputs must be actually consumed after exact current attachment and
recipe-specific activation/handoff; their manifest alone is not generation or integration evidence.
Where package consumption or supplemental correction requires unavailable invocation, materialization or
[correction binding](dispatch.md#supplemental-original-owner-corrections), retain the delivery hold.
Do not retrofit package requirements onto historical omitted-decomposition plans.

For an external bounded experiment, `foundry_record_delivery` and `foundry_record_evaluation`
retain the actual commit/artifact and generation/evaluation session or process identities.
`fresh-session` delivery needs `source.sessionId`; `fresh-process` needs `source.runId`.
An origin already used to produce another candidate is not fresh merely because its timestamp
changed. Exact same-candidate delivery replay is idempotent. Shared dependency contracts must be
accepted, and replacement requires current supported foundation candidates; changed or unsupported
foundations block dependent readiness.
An already reported evaluation origin cannot become a fresh execution of the same pinned
candidate/evaluator/context merely by changing its receipt ID or timestamp. One evaluator run
may legitimately assess distinct subjects in a batch. All of these remain claims, not authenticated
process or human identities.
Human assessment identity is matched by its stable source reference or its actor/judgment ID.
Changing only one of those identities does not create another assessment. A genuinely new human
assessment needs its own claimed source identity and actual observation time.
Evidence names the candidate, contract/context digests, exact commit and evaluator revision/digest,
source/time, environment/workload, independence method/reason and actual report.
Process/session/human provenance remains `claimed` or `independent-claim`, not a sandbox or
attestation service. Mechanical evaluator `identity` is service-owned; never supply it yourself.
Candidate commits must contain the unchanged protected evaluator material. An unavailable
commit, evaluator or verifier worktree is explicit missing/unsupported evidence, not success.
Never use an external record to fabricate ownership of a native workflow.

## Learning, renewal and retention

### Delegated consumer-expectation renewal

Initial contract acceptance and new product meaning still require their existing authority.
A separate explicit owner-local `technical` grant may replace only an obsolete consumer expectation
that contradicts a frozen pre-existing executable agreement. Follow
[technical delegation](planning.md#delegated-bounded-technical-decisions); never widen old plan or
completion grants, infer equivalence from prose, or label an agent decision a human click.

The supported transformation is deliberately narrow: in canonical closed JSON scenario material,
change only `expected.outcome` from `denied` to `cancelled` for the pinned cancelled late-denial
request with previously granted access. The accepted obligation independently pins the agreement
SHA-256 in its pre-change `source.digest`; do not manufacture that pin after the failure. The
`foundry-cancellation-agreement-v1` document identifies `obligation`, `scenarioId`, `casesPath`,
`referencePath`, `assertion: "expected.outcome"`, `from: "denied"` and `to: "cancelled"`.
Agreement and case material use the closed field shapes and canonical JSON bytes
(`JSON.stringify(value, null, 2) + "\n"`), not arbitrary source syntax or formatting edits.
The complete Git evaluator bundle, executable reference, scenario inputs, granted-access/data/focus
assertions, noncancelled-denial controls and every unrelated case must otherwise remain unchanged,
including file inventory, modes and invocation. Extra edits, missing control execution and
inconsistent mappings are explicit holds, not permission to broaden the transformation.

Record the immediate next revision of the same evaluator ID using its exact changed Git bundle and
`supersedes` link to the previous revision. Retain the evaluator's statement and uncertainty.
All evaluation definitions remain conserved: obligation revisions, coverage,
independence, preservation, human modality, UI applicability/native-reference comparisons,
environment/workload and freshness. Keep unit/boundary/dependency revisions, accepted obligations,
rationale, resolutions and renewal-signal links unchanged; only the selected evaluation reference
advances. A renamed check or equal coverage count proves nothing.
Call existing `foundry_accept_contract` with the normal conserved publication fields and
`technical: { id, planId, expectedPlanRevision, delegationId, previous, next, failures }`;
`previous` and `next` are exact evaluator references. The ordinary `expectedRevision` guards the
factory ledger; `expectedPlanRevision` separately guards the named owner plan. Omit `actor`; native
agent attribution is derived by the application. Keep a stable technical decision `id` and concrete
original failure/run/signal references in `failures`.

Execution uses a trusted constructor-supplied reference executor, not a caller report or claimed
equivalence boolean. Structural conservation and actual immutable reference/control executions are
both required: the old expectation exits `1`, the new exits `0`, and both traces include every case
in the same order with identical actual results, retaining source/environment identity. A green result,
prose or matching case counts alone cannot establish equivalence. The source default has no production
executor: missing support or an actual permission denial holds the decision. Confined executable
fixtures establish source behavior only, not installation, native resource permission or full
factory acceptance.

Authorization is the canonical owner-local SQLite commit of the validated decision/outbox, with
current native owner, grant/revocation and exact revision checks, not the later factory mutation.
That same plan SQLite transaction records the exact plan/decision/digest publication marker; no
separate authority store is introduced. Pending publication requires this marker, which survives
restart and later revocation but is never recreated by exported/imported receipt history.
Existing synchronization applies that exact receipt at its pinned factory revision, publishes portable
knowledge and acknowledges the published head. Before the commit,
revocation prevents authorization; after it, revocation blocks new decisions but cannot rewrite
the committed historical decision. Recover through `foundry_sync_factory`, not a new grant,
new decision ID or automatic replay at another revision. Conflicting/tampered postconditions remain
held; matching recovery creates no duplicate contract. Already-published matching history remains
inspectable without granting imported history authority to publish.

An eligible decision creates a new contract/context revision, never edits the accepted old one.
Continue through a fresh candidate and bounded plan under the new contract, retaining the old
candidate, failures and decision lineage. Independent evaluation, mandatory human judgments and
explicit replacement acceptance remain necessary. This path supplies none of those results and
authorizes no installation, deployment, push, PR, merge or native resource access.

### Signals and assurance renewal

Record incidents, failed evaluations, changed assumptions or stale/context-mismatched evidence with
`foundry_record_signal`. It identifies affected obligations/units and known downstream dependents.
Incomplete relationship information exposes uncertain impact; do not promise perfect localization.
Explicit obligation/evaluator references retain their local scope inside the affected unit.
Propagation to dependent units is conservative where finer relationship information is absent.
Inspection also derives renewal needs from failed/stale/context-mismatched evaluation support.
Re-evaluate the affected pinned obligations first. Broader regeneration is not the default fix.
If the contract must change, explicitly accept a new revision before preparing fresh candidates.
Pass the triggering `renewalSignalIds` to `foundry_accept_contract`, alongside revised unit/knowledge
references and the decision reason. This acknowledges why the contract changed; it does not claim
the incident is fixed. `foundry_prepare_candidate` inherits those IDs, or accepts an explicit subset
acknowledged by that contract. Inspection connects signal, decision and candidate, and shows
awaiting/partial/current support with still-pending dependent units.

For unchanged code, use `foundry_create_evaluation_plan` with the existing candidate and selected
pinned evaluator references. This creates a separately owned verifier-only draft with an immutable
external target commit: no dummy implementation step, generation rebinding or mutable delivery.
Approve, reserve, create and attach its read-only App child normally, then complete native verification
and manual or separately delegated plan completion. New assurance is appended; original delivery,
generation completion and selection remain historical facts. A failed generation plan offers two distinct paths: new code needs
a fresh candidate, while unchanged code can get this read-only assurance repair. Do not use ordinary
generation retry to overwrite a delivered candidate.
Later evidence changes current support, never historical acceptance or completed plan outcomes.
An old report imported after an incident cannot clear the need for a fresh evaluation.
Valid delayed receipts are retained as historical evidence, not rejected merely because a newer
observation arrived first. Current support follows actual observation time across distinct origins,
not publication order; conflicting observations at the newest time fail closed. Read-only plan
completion concerns its own pinned observations, so a historical passing report can complete its
plan without overriding a newer failure or satisfying a later renewal signal.

Use `foundry_retire_artifact` only with an attributed reason and retained summary. It logically
compacts superseded candidate/knowledge views but retains the full ledger and lineage for export.
It refuses current/required artifacts and candidates with outstanding evaluation bindings, including
retries after earlier completion. Terminal completion or abandonment releases those holds; replaying
an older completion does not release a newer retry. It never deletes files, data or branches. After retirement,
`foundry_compact_factory` moves retained event rows into bounded lossless archive segments, with
actor/reason and measured storage bytes. Automatic rollover also keeps active-record headroom.
Content integrity is checked on decode; this is not authenticated attestation. No knowledge is
deleted. SQLite file size may not shrink (pages can be reused). The former 8,192-event lifetime
ceiling is gone. Schema-5 canonical/staged rows also remove the former 128 KiB per-event CHECK
transactionally without rewriting old data. Archive segments and transfer pages are lossless
framing, not content/publication ceilings; oversized first events remain complete and advance.
Use `foundry_get_factory` filters (`kinds`, `query`, `relatedTo`) and its opaque `cursor`
to retrieve older relevant knowledge. Keep filters and limit unchanged when following a cursor.
Selection is deterministic and explains privacy/view exclusions; follow complete paging rather
than treating a visible page as the ledger. Accepted sealed contexts do not
grow merely because new observations arrive.

Portable knowledge is published through `.foundry/repository.json` and immutable content-addressed
objects. Raw reports remain local; portable observations retain explicit source/statement
commitments and causal links. Capturing a report does not publish its contents or make it a
requirement. Historical candidate decisions travel as complete privacy-scoped records, not live candidates
or current assurance. Imported private-context v2 contracts marked `historyOnly` require a new
explicit portable acceptance before reconstruction.

For an existing local ledger, use `foundry_migrate_factory` with its exact revision, actor and
reason. Migration retains the original journal and seal lineage. It never commits files or
transfers native ownership. A conflicting checked-out head holds new work rather than merging
authority automatically. `factory_publication_pending` means the local mutation is durable;
inspect/reopen to recover its publication instead of repeating it.

Use explicit current-format `foundry_export_factory` / `foundry_import_factory` for an empty store
of the same canonical repository. No legacy migration or automatic identity retargeting exists.
Single JSON transfers have no 32 MiB policy cap. For larger histories use `foundry_export_factory_page`,
pin its `revision`/`throughDigest`, and advance with `nextRevision`. `foundry_import_factory_page`
stages that exact sequence under an `importId`; it becomes authoritative only after complete validation.
Partial transfers survive restart and take precedence over automatic cache reconstruction.
Explicit `foundry_abandon_factory_import` retains their received
data rather than deleting it. Current v2 SQLite documents upgrade non-destructively to physical schema 5;
cached older writers fail closed and must restart. Historical v2 JSON, seals and ownership remain
historical; new acceptance uses version-3 portable commitments.
Already-recorded v2 receipts and selection decisions remain readable under their original publication
rules. Current assurance coalesces duplicate origins at their earliest claimed observation time;
historical duplicate publication cannot manufacture fresh support. New publication and prospective
selection enforce the current rules, not the historical acceptance exception.

Conceptual compaction is different from storage maintenance. Existing planning critics and the
independent reconstruction review consider substantively useful simplification proposals: remove unnecessary
internal concepts or duplicate authority while naming the external meaning, obligations and evaluators
that must be conserved, tradeoffs, and any human judgment required. Proposals and bounded-review gaps
are retained as linked non-governing knowledge. No byte-count metric, extra agent runtime or automatic
contract change is involved; accept changed obligations or judgment explicitly before implementation.

When scoped audit/research/review/security/triage work is already associated with a capability,
retain observations/proposals and coverage gaps. `foundry_capture_analysis` imports the exact
completed **current-session** native report as non-governing knowledge with digest/provenance.
Only capture whole reports whose scope matches the unit; for multi-repository queues or oversized
reports, use explicitly scoped `foundry_record_knowledge` entries with original source references.
Standalone analysis remains standalone; do not impose a reconstruction checklist or start heavy
research merely because knowledge could be useful.

## Inspect and recover

The board shows accepted versus non-governing knowledge, reasons/provenance, candidate comparison,
current assurance and renewal. `foundry_get_factory` offers bounded repository-wide or unit/candidate
views without requiring a session plan. `foundry_get_status.factory.synchronization` exposes pending
receipts. If completion returns `factory_sync_pending`, the task result is already durable: repair
the reported storage issue and call `foundry_sync_factory`. Do not repeat the external task.
Pending synchronization is derived from the exact complete receipt enumeration, including every
learning entry. Cancellation publishes terminal abandonment before learning and never requires
invalid assurance to become authoritative.

The design draws on specification/evaluation/context/provenance
([Phoenix](https://aicoding.leaflet.pub/3mjfruwwuck2d)), governed connected knowledge
([knowledge](https://aicoding.leaflet.pub/3mtgs36dnq22o)), discovery before specification
([first implementations](https://aicoding.leaflet.pub/3mwlzitykzc27)), and evidence that ages
([operating context](https://aicoding.leaflet.pub/3mjx4erlboc2l)). It is not a universal ontology or
a claim that arbitrary substantial production systems can already be regenerated.

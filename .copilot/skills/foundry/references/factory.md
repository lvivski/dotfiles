# Capability factory

Use this lifecycle whenever Foundry coordinates engineering. It does not activate Foundry for an
ordinary question, or authorize paid workflows, additional agents, commits, deployments or merges.

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
5. Present the proposed contract, reasons, uncertainty and contradictions. Only after explicit
   approval call `foundry_accept_contract` with the selected unit revision, obligation/evaluation
   references, actor and reason. Every obligation needs an evaluator; accepted contracts require
   boundary and preservation evaluation. Known contradictions/uncertainty need attributed
   `resolutions`. Acceptance adds an immutable revision; it never edits history.
   Accepted dependency contracts are pinned, as is bounded causal rationale (at most 128 connected
   revisions) and decision lineage (16 recent decisions with an explicit earlier-history count).
   Optional `rationale` references add explanatory context but never governing obligations.

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
   Sealed generation context is bounded to 128 KiB.
2. Call `foundry_create_factory_plan` with the candidate, repository, explicit file scope,
   `expectedRevision: 0` and `expectedFactoryRevision`. It deterministically assembles bounded
   implementation and read-only verifier tasks. It launches nothing. Follow ordinary
   submit/approve/reserve/create/attach rules.
   App generation supplies session/attempt identity, not process identity. A `fresh-process`
   candidate cannot be bound to this path; use a genuinely external process or prepare a new
   `fresh-session` candidate. Never invent process provenance after the fact.
3. Complete implementation attempts with actual delivery, concrete evidence and `learning` entries
   (`observation`, `inference` or `proposal`, `statement`, optional `uncertainty`). Each completed
   attempt also creates a non-governing report observation with exact task/attempt/session identity.
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
   Publishable receipt invariants are checked before terminal task persistence. A wrong-commit
   report stays retryable, with a bounded non-governing rejection observation where possible.
5. Complete native verification and obtain explicit plan completion approval. These facts are
   necessary but are not replacement selection. Compare alternatives against the **same**
   contract/context definitions and pinned evaluator revisions; do not automatically spawn
   more paid agents. A delivered candidate is immutable: corrections produce another candidate
   and bounded plan, rather than relabeling a retry as regeneration.
6. With current evidence and explicit approval, call `foundry_decide_candidate` with `action`,
   `actor`, `reason`, repository revision, and exact `expectedIncumbentId`. Missing, failed,
   expired, context-mismatched or non-independent evidence blocks acceptance. The decision records
   the selected replacement and prior incumbent; it does not deploy, migrate data, merge Git, or
   delete branches. Carry out any operational cutover only under its own explicit approved work.

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
and explicit plan completion. New assurance is appended; original delivery, generation completion and
selection remain historical facts. A failed generation plan offers two distinct paths: new code needs
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
ceiling is gone explicitly: bounds now apply per event (128 KiB), archive segment (8,192 events /
32 MiB), and transfer page (256 events / 4 MiB), not to lifetime receipt publication.
Use `foundry_get_factory` filters (`kinds`, `query`, `relatedTo`) and its opaque `cursor`
to retrieve older relevant knowledge. Keep filters and limit unchanged when following a cursor.
Selection is bounded, deterministic and explains omissions; accepted sealed contexts do not
grow merely because new observations arrive.

Portable knowledge is published through `.foundry/repository.json` and immutable content-addressed
objects. Raw reports remain local; portable observations retain explicit source/statement
commitments and causal links. Capturing a report does not publish its contents or make it a
requirement. Historical candidate decisions travel as bounded summaries, not live candidates
or current assurance. Imported private-context v2 contracts marked `historyOnly` require a new
explicit portable acceptance before reconstruction.

For an existing local ledger, use `foundry_migrate_factory` with its exact revision, actor and
reason. Migration retains the original journal and seal lineage. It never commits files or
transfers native ownership. A conflicting checked-out head holds new work rather than merging
authority automatically. `factory_publication_pending` means the local mutation is durable;
inspect/reopen to recover its publication instead of repeating it.

Use explicit current-format `foundry_export_factory` / `foundry_import_factory` for an empty store
of the same canonical repository. No legacy migration or automatic identity retargeting exists.
Single JSON transfers are bounded to 32 MiB. For larger histories use `foundry_export_factory_page`,
pin its `revision`/`throughDigest`, and advance with `nextRevision`. `foundry_import_factory_page`
stages that exact sequence under an `importId`; it becomes authoritative only after complete validation.
Partial transfers survive restart and take precedence over automatic cache reconstruction.
Explicit `foundry_abandon_factory_import` retains their received
data rather than deleting it. Current v2 SQLite documents upgrade non-destructively to physical schema 4;
cached older writers fail closed and must restart. Historical v2 JSON, seals and ownership remain
historical; new acceptance uses version-3 portable commitments.
Already-recorded v2 receipts and selection decisions remain readable under their original publication
rules. Current assurance coalesces duplicate origins at their earliest claimed observation time;
historical duplicate publication cannot manufacture fresh support. New publication and prospective
selection enforce the current rules, not the historical acceptance exception.

Conceptual compaction is different from storage maintenance. Existing planning critics and the
independent reconstruction review consider at most three simplification proposals: remove unnecessary
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

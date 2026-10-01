# Foundry

Foundry is the Copilot extension control plane for native Dynamic Workflows and dependency-aware
engineering plans across App-native project sessions.

## When to use Foundry

Foundry coordination is already opt-in. Routine changes can use native plan mode and direct tools;
ordinary multi-session work and dependent PRs can use the native `orchestrate` and `pr-stack` flows.
Those flows do not require a Foundry plan.

Use Foundry when explicitly requesting a durable dependency-aware plan with approval gates,
reserved task attempts, delivery/evidence contracts, and cross-session recovery. Native workflow
journals and session tools provide the execution primitives, not an equivalent to those policies.
An explicit Foundry request still follows the complete coordinator protocol, including importing
its planning workflow result; native plan mode is not a substitute for that result.

## Dynamic workflows

| Workflow | Purpose |
| --- | --- |
| `plan` | Create, critique, synthesize, and verify a dependency-aware plan |
| `verify` | Produce the final fail-closed evidence verdict |
| `audit` | Audit files for a specified concern |
| `deep-research` | Research independent angles and verify cited claims |
| `review-queue` | Triage correctness and maintainability risks in supplied diffs |
| `security-review` | Run a multi-perspective static security review |
| `triage` | Classify and prioritize tickets |

Invoke these workflows with `run_dynamic_workflow` and inspect the returned `runId` with
`dynamic_workflows_manage` (`inspect-run`). The five general workflows use the native workflow
lifecycle directly and never mutate Foundry plan state.

Definitions live in `workflows/` and register through `defineWorkflow` and `joinSession({ workflows })`.
The control-plane adapter uses `session.workflow` for run inspection and cancellation. Registered
names, reservation markers, and persisted Foundry plan fields are unchanged.

Every workflow declares an SDK argument schema so malformed model invocations fail before approval or
credit spend. Workload bounds also reserve capacity for the SDK's automatic structured-output retry.

The review queue pipelines each PR through review and verification independently. A PR must still
finish every chunk review before it can enter verification, and only complete, clean evidence that
passes the configured policy can be recommended for approval. The final queue report waits for all
PRs; pipelining does not reduce reviewer count or expand the supplied-evidence scope.

Review covers correctness and maintainability. The report includes observed line changes and
actionable concerns rather than quality scores; counts alone do not block approval. Material
concerns and incomplete evidence require human review. The workflow remains diff-only, without
additional checkouts, analyzers, or reviewers. Start with the
[review-queue skill](../../skills/review-queue/SKILL.md); load its local references only when adjusting
queue options or interpreting the detailed review criteria and metric limits.

## Plan model

A plan contains one or more implementation tasks and exactly one final verifier task. Every
implementation path converges into the verifier's single implementation dependency. The final
implementation task must deliver a commit or PR; the read-only verifier reports canonical evidence
for every acceptance criterion plus `final-integration` and `workspace-integrity`.

Foundry owns:

- optimistic plan revisions and explicit approval gates;
- reserve-before-create task attempts and immediate App-session attachment;
- delivery requirements for branches, commits, and pull requests;
- causal session inventories for retry and cancellation safety;
- canonical evidence, correction waves, and final workflow verification;
- atomic storage, cross-process locks, stale-lock recovery, and deterministic recovery projections;
- session-local guardrails and the interactive `foundry-board` canvas;
- a bounded, revisioned activity timeline rendered from the authoritative plan document.

Workflow agents perform analysis only. App-native project sessions own repository mutation.

## Tool surface

| Area | Tools |
| --- | --- |
| Planning | `foundry_prepare_plan`, `foundry_create_plan`, `foundry_submit_plan`, `foundry_approve_plan` |
| Inspection | `foundry_get_plan`, `foundry_get_status`, `foundry_list_plans` |
| Recovery | `foundry_quarantine_plan` |
| Tasks | `foundry_next_tasks`, `foundry_reserve_task`, `foundry_attach_task`, `foundry_complete_task`, `foundry_retry_task` |
| Verification | `foundry_prepare_verification`, `foundry_complete_verification` |
| Cancellation | `foundry_cancel`, `foundry_cancel_verification_run`, `foundry_finalize_cancellation` |
| Hooks | `foundry_activate_plan`, `foundry_deactivate_plan` |

The coordinator protocol lives in
[`../../skills/foundry/SKILL.md`](../../skills/foundry/SKILL.md).

Activation and plan storage are local to the current Copilot session. The shell classifiers are
conservative friction, not a sandbox or a complete shell parser; indirect execution remains subject
to the host permission boundary. Deactivation removes an unreadable activation marker and reports
that repair instead of leaving the session stuck behind a corrupt marker.

Coordinator context is supplied on activation and session start. Ordinary successful Foundry tool
calls do not add repetitive reminders; activation, deactivation, unreadable-state, and failure
guidance remain available. This does not change permission checks or revision enforcement.

The board can request cancellation, but the coordinator must still stop owned App sessions, cancel
the authoritative verification workflow run, and finalize with a fresh causal inventory.

Plan artifacts have one strict current shape. Activity entries contain only the event, timestamp,
and resulting revision. Unsupported fields and stale artifact shapes are rejected rather than
migrated. `foundry_list_plans` reports
their validation details; after explicit approval, `foundry_quarantine_plan` preserves an unreadable
artifact under a hidden filename and returns the requester and reason so the plan ID can be reused.

## Validation

```sh
node --test .copilot/extensions/foundry/*.test.mjs
```

With TypeScript and Node.js type declarations available, check the offline SDK contracts and
compile-only regression cases with:

```sh
tsc --project .copilot/extensions/foundry/jsconfig.json
```

The local SDK declarations cover the surfaces Foundry consumes. Tool results use namespaced
telemetry, and workflow inspection preserves typed failure and pause metadata. A paused attempt
is settled in the SDK, but is still not terminal evidence for Foundry cancellation.

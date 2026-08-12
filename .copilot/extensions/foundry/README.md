# Foundry

Foundry is the Copilot extension control plane for native Agent Factories and dependency-aware
engineering plans across App-native project sessions.

## Factories

| Factory | Purpose |
| --- | --- |
| `plan` | Create, critique, synthesize, and verify a dependency-aware plan |
| `verify` | Produce the final fail-closed evidence verdict |
| `audit` | Audit files for a specified concern |
| `deep-research` | Research independent angles and verify cited claims |
| `review-queue` | Triage supplied pull-request diffs |
| `security-review` | Run a multi-perspective static security review |
| `triage` | Classify and prioritize tickets |

The five general factories use the native Factory lifecycle directly and never mutate Foundry plan
state.

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
- canonical evidence, correction waves, and final Factory verification;
- atomic storage, cross-process locks, stale-lock recovery, and deterministic recovery projections;
- session-local guardrails and the interactive `foundry-board` canvas;
- a bounded, revisioned activity timeline rendered from the authoritative plan document.

Factory agents perform analysis only. App-native project sessions own repository mutation.

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

The board can request cancellation, but the coordinator must still stop owned App sessions, cancel
the authoritative verification Factory run, and finalize with a fresh causal inventory.

Plan artifacts have one strict current shape. Activity entries contain only the event, timestamp,
and resulting revision. Unsupported fields and stale artifact shapes are rejected rather than
migrated. `foundry_list_plans` reports
their validation details; after explicit approval, `foundry_quarantine_plan` preserves an unreadable
artifact under a hidden filename and returns the requester and reason so the plan ID can be reused.

## Validation

```sh
node --test .copilot/extensions/foundry/*.test.mjs
```

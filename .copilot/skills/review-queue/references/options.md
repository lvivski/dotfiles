# Queue options

Use these controls only when the default fetch and run need adjustment.

## Fetch scope and freshness

Pass fetch options to `scripts/review-queue-fetch.sh`, resolved from this skill's base directory.
Use `--help` for the complete CLI, dependency requirements, and exit codes; it works without
authentication or installed fetch dependencies.

| Need | Option |
| --- | --- |
| Change the result limit per account/team or Azure lookup | `--limit N` (default: 100) |
| Bound Azure transitive group discovery per organization | `--max-groups N` (default: 200; positive) |
| Include older PRs | `--max-age-days N` (default: 30), or `--all-ages` |
| Restrict platforms | `--github-only` or `--azure-only` |
| Select an Azure organization/project | `--ado-org ORG --ado-project PROJECT` |
| Include additional Azure scopes | Repeat `--ado-scope ORG PROJECT` |

GitHub queries all locally authenticated `github.com` accounts without changing the active account.
Azure DevOps requires `az login`; explicit scopes override or supplement the configured/default
organization and project. Fetch limits apply to individual lookups, not the deduplicated total.
Use a positive integer for `--limit` and a non-negative integer for `--max-age-days`; zero days
disables the age filter. The two platform-only flags are mutually exclusive. `--no-diff` produces
metadata-only evidence that cannot support an approval recommendation.

GitHub freshness uses the PR's `updated_at`. Azure fetches the latest iteration **before** age
filtering and uses its `updatedDate`, or its `createdDate` when `updatedDate` is absent. This is
code/retarget iteration activity, not the last comment, review, or general metadata update.
The row's `freshness` records the timestamp, original timestamp, source field, iteration ID,
and meaning. `updatedAt` is populated only from the iteration's `updatedDate`; an iteration
creation is exposed as freshness, never relabeled as an update. The table labels this column
**Freshness** and qualifies Azure dates as iteration-updated or iteration-created. An old PR with
a recent iteration is retained. Missing, invalid, or sentinel timestamps remain explicitly
unknown and are retained with a fetch failure, even under an age filter. Creation time from the
PR object and dates absent from its shallow commit references are never substitutes.

## Fetch evidence contract

The fetcher returns `{prs, fetch}` rather than a bare PR array. Pass that object directly as
workflow arguments. `fetch` contains `version: 1`, `complete`, and a `failures` array whose entries
identify platform, account, scope, stage, and message. Exit 4 preserves incomplete output for
triage; it must not be interpreted as a complete empty queue. A failed requested provider or a
lookup reaching its limit makes queue completeness unknown.

Each PR retains the display fields plus `assignments` and `evidence`. Every assignment has
`account`, `reviewer`, and `kind` (`user` or `team`, including Azure security groups).
Azure assignments also retain the actual `reviewerId`, Graph descriptor, a proven
`membershipPath`, `required`/vote/decline/reapproval state, and the query identity/source field.
Evidence version 1 records:

- `source`: platform, host, repository, PR number, account, full base/head revision IDs, and
  the Azure iteration number when applicable.
- `completeness`: explicit `files`, `diff`, and `assignments` booleans.
- `failures`: the source's fetch failures, including incomplete content or assignment discovery.

GitHub deduplicates direct/team search matches **within each account before fetching PR data**.
The same PR accessed by two accounts remains two independently authorized records; their
evidence is never borrowed or merged. Teams and file lists are paginated. CODEOWNERS uses the
captured base commit; only a confirmed 404 means absence. Base/head revisions are rechecked
after diff retrieval to detect concurrent updates.

Azure iteration changes follow `nextSkip` and `nextTop` until exhaustion, with `$compareTo=0`
for the complete PR comparison. File content is fetched at the iteration's exact common/source
commits. A failed or nonadvancing page retains earlier files but never claims a full diff.
Repeated scopes and PRs returned for several identities are deduplicated before iteration/content
fetching, retaining every actual assignment source.

Azure resolves the current CLI account with `az devops user show`, then traverses
[Graph memberships](https://learn.microsoft.com/en-us/rest/api/azure/devops/graph/memberships/list?view=azure-devops-rest-7.1)
upward. The API supports only `depth=1`, so the fetcher visits each user/group descriptor once
and follows parent groups transitively, with cycle detection and the explicit group bound.
Requests use `7.1-preview` without the optional revision suffix: the Azure CLI
[`invoke` version parser](https://github.com/Azure/azure-devops-cli-extension/blob/master/azure-devops/azext_devops/dev/team/invoke.py)
cannot parse `7.1-preview.1`. Unknown continuation signals, including the CLI's
`continuation_token` response-header projection, leave discovery incomplete rather than implying
exhaustion. Known membership edges are still retained.
[Graph storage keys](https://learn.microsoft.com/en-us/rest/api/azure/devops/graph/storage-keys/get?view=azure-devops-rest-7.1)
map group descriptors to reviewer UUIDs; Entra origin IDs and display names are not substitutes.
It queries active PRs for the user and each resolved group UUID, and records an assignment only
when that UUID is present in the returned PR's **top-level** reviewers. `votedFor` describes
contributed group votes, not membership or an outstanding assignment, and is never used for
discovery. Vote state is retained rather than interpreted as membership.

The account needs read access to its Azure DevOps user identity and Graph membership/storage-key
endpoints (`vso.graph`). Unavailable identity, membership visibility, reviewer-ID resolution,
lookup limits, or group bounds make assignments incomplete. Known identities, membership paths,
and matches survive other discovery failures; the fetcher never substitutes fabricated direct
assignments or reports the incomplete queue as empty success.

`coverage` remains a display label only. Missing or invalid provenance cannot produce `Approve`;
there is no migration of old unversioned fetch data. Refetch rather than relabeling it.

## Workflow arguments

Pass these optional fields alongside `prs` in `run_dynamic_workflow`'s `args`.

| Field | Effect |
| --- | --- |
| `approve_only_low_risk_manual: true` | Recommend approval only for clean, independently verified, manually assigned PRs |
| `diff_chunk_chars` | Set the character count per diff chunk |
| `max_total_chunks` | Bound the total supplied diff chunks admitted by the workflow |
| `freshness` | Label the input queue's freshness in the report |
| `pauseBeforeWork: true` | Journal and show the prepared PR/chunk scope, then pause once before reviewers start |

There is no default chunk cap or declared runtime ceiling. `max_total_chunks` applies only when
explicitly supplied. Each chunk uses one reviewer and one independent verifier. Structured-output
correction turns reuse those agents, though their time and credits still count toward any approved
runtime limits. Omitted worker, concurrency, time and credit limits are unbounded.
Checkpoints default to off. Resuming a current-contract run reuses its prepared scope and completed
agents; it does not refetch the queue or grant approval to any PR. The versioned-evidence contract
uses `review-queue:prepared-queue:v3` and `review-queue:before-review:v2`; old runs are not migrated.

GitHub CODEOWNERS is evaluated per changed file. Azure DevOps uses required-policy/manual attribution.
Leading `/` anchors a CODEOWNERS rule at the repository root; a trailing `/` selects a directory
and descendants, not a file with the same name. A slashless directory rule can match at any depth,
while `docs/*` matches direct children only. Last matching owners (including an empty owner list)
still win. Azure required-policy attribution uses the matched reviewer's recorded requirement,
not coincidentally equal display names. Missing/incomplete assignment attribution is labeled
**Unknown**, not invented as manual (a known required assignment still establishes required policy).
Assignment reasons are rederived from the prepared data,
so replay does not preserve an obsolete matching decision.
Assignment policy never bypasses evidence or verification requirements. Chunk controls do not override
user-approved runtime limits; pass `limits` only when the user specifies them, and never change
an approved limit without their authorization.

## Recovery

Inspect the original `runId` before deciding whether work failed. Resume a resumable paused or failed run with
`run_dynamic_workflow({ resumeFromRunId: "<run-id>" })` to reuse completed work. A reached limit needs explicit
user authorization before it is raised; do not refetch or start another run to evade it.
If the workflow is unavailable, report the missing Recon prerequisite instead of running a
replacement review pool.

## Provider contracts

- [Azure reviewer votes and identities](https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/identityrefwithvote)
- [Azure PR query semantics and shallow commit references](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests-by-project?view=azure-devops-rest-7.1)
- [Azure iteration timestamps](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1)
- [GitHub CODEOWNERS pattern examples](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-syntax)

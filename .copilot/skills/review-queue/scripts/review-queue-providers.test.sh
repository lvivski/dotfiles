#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
script="$script_dir/review-queue-fetch.sh"
temp_dir="$(mktemp -d)"
mkdir "$temp_dir/bin"
trap 'rm -f -- "$temp_dir/bin/"*; rmdir "$temp_dir/bin"; rm -f -- "$temp_dir/"*; rmdir "$temp_dir"' EXIT
ln -s "$(command -v jq)" "$temp_dir/bin/jq"

# Both providers are replaced, and env -i excludes real credentials and CLI config.
cat >"$temp_dir/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "${GH_TOKEN:-discovery}" "$*" >>"$MOCK_LOG"
case "$*" in
  "auth status "*)
    state=success
    [ "$MOCK_SCENARIO" != accounts-fail ] || state=error
    jq -nc --arg state "$state" '{hosts:{"github.com":[{login:"alpha",state:"success"},{login:"beta",state:$state}]}}' ;;
  "auth token "*)
    while [ "$1" != --user ]; do shift; done
    printf 'token-%s\n' "$2" ;;
  "api user -q .login") printf '%s\n' "${GH_TOKEN#token-}" ;;
  *"user/teams"*)
    [ "$MOCK_SCENARIO" != teams-fail ] || exit 1
    printf '[[{"organization":{"login":"owner"},"slug":"core"}],[{"organization":{"login":"owner"},"slug":"ops"}]]\n' ;;
  "search prs "*)
    [ "$MOCK_SCENARIO" != search-fail ] || exit 1
    printf '[{"repository":{"nameWithOwner":"owner/repo"},"number":1}]\n' ;;
  *"contents/"*)
    if [ "$MOCK_SCENARIO" = codeowners-fail ]; then echo 'Forbidden (HTTP 403)' >&2; exit 1; fi
    if [ "$MOCK_SCENARIO" = codeowners-absent ]; then echo 'Not Found (HTTP 404)' >&2; exit 1; fi
    printf '* @owner/core\n' | jq -Rs '{content:(.|@base64)}' ;;
  *"/files?"*)
    if [ "$MOCK_SCENARIO" = files-fail ]; then printf '[]\n'; else
      printf '[[{"filename":"src/a.js","additions":1,"deletions":0}]]\n'
    fi ;;
  *"Accept: application/vnd.github.diff"*)
    [ "$MOCK_SCENARIO" != diff-fail ] || exit 1
    if [ "$MOCK_SCENARIO" = binary ]; then echo 'Binary files a/image and b/image differ'; else
      printf 'diff --git a/src/a.js b/src/a.js\n--- /dev/null\n+++ b/src/a.js\n@@ -0,0 +1 @@\n+const answer = 42;\n'
    fi ;;
  "api repos/owner/repo/pulls/1")
    [ "$MOCK_SCENARIO" != metadata-fail ] || exit 1
    head=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    if [ "$MOCK_SCENARIO" = revision ] && [ -f "$MOCK_DIR/seen-${GH_TOKEN#token-}" ]; then
      head=cccccccccccccccccccccccccccccccccccccccc
    fi
    : >"$MOCK_DIR/seen-${GH_TOKEN#token-}"
    jq -nc --arg head "$head" '{title:"Change",html_url:"https://github.com/owner/repo/pull/1",
      user:{login:"author"},draft:false,updated_at:"2026-11-08T00:00:00Z",changed_files:1,additions:1,deletions:0,
      base:{ref:"main",sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},head:{sha:$head},
      requested_reviewers:[{login:"alpha"},{login:"beta"}],requested_teams:[{slug:"core"},{slug:"ops"}]}' ;;
  *) echo "Unexpected gh call: $*" >&2; exit 99 ;;
esac
MOCK

cat >"$temp_dir/bin/az" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'azure|%s\n' "$*" >>"$MOCK_LOG"
user_id=11111111-1111-1111-1111-111111111111
group_id=22222222-2222-2222-2222-222222222222
parent_id=33333333-3333-3333-3333-333333333333
case "$*" in
  "repos --help") exit 0 ;;
  "account show "*) echo reviewer@example.test; exit 0 ;;
  "devops user show "*)
    [ "$MOCK_SCENARIO" != identity-fail ] || exit 1
    principal=reviewer@example.test
    [ "$MOCK_SCENARIO" != identity-mismatch ] || principal=other@example.test
    jq -nc --arg id "$user_id" --arg principal "$principal" \
      '{id:$id,user:{subjectKind:"user",descriptor:"aad.user",principalName:$principal,mailAddress:$principal}}'
    exit 0 ;;
  "repos pr list "*)
    [ "$MOCK_SCENARIO" != search-fail ] || exit 1
    reviewer_id="" previous=""
    for arg in "$@"; do
      [ "$previous" != --reviewer ] || reviewer_id="$arg"
      previous="$arg"
    done
    case "$reviewer_id" in
      "$user_id")
	case "$MOCK_SCENARIO" in team-only|nested) echo '[]'; exit 0 ;; esac ;;
      "$group_id")
	[ "$MOCK_SCENARIO" != group-query-fail ] || exit 1
	if [ "$MOCK_SCENARIO" = nested ]; then echo '[]'; exit 0; fi ;;
      "$parent_id") ;;
      *) echo "Reviewer lookup did not use an actual identity UUID: $reviewer_id" >&2; exit 99 ;;
    esac
    jq -nc --arg id "$reviewer_id" --arg user "$user_id" --arg group "$group_id" --arg scenario "$MOCK_SCENARIO" '
      {id:$id,uniqueName:(if $id==$user then "reviewer@example.test" else "[project]\\Review group" end),
       isRequired:true,vote:0,hasDeclined:false} as $reviewer |
      [{pullRequestId:1,title:"Change",
	repository:{id:"repo-id",name:"repo",project:{name:"project"},url:"https://dev.azure.com/org/project/_apis/git/repositories/repo-id"},
	reviewers:[(if $scenario == "assignment-mismatch" then $reviewer + {id:$group}
	  elif $scenario == "assignment-malformed" then $reviewer + {id:null}
	  elif $scenario == "voted-for" then $reviewer + {votedFor:[{id:$group,uniqueName:"Unproven vote group",vote:10}]}
	  else $reviewer end)],
	creationDate:"2000-01-01T00:00:00Z",lastMergeSourceCommit:{commitId:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
	targetRefName:"refs/heads/main",sourceRefName:"refs/heads/change"}]'
    exit 0 ;;
esac
resource="" skip=0 top="" path="" revision="" subject="" api_version=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --resource) resource="$2"; shift ;;
    --api-version) api_version="$2"; shift ;;
    '$skip='*) skip="${1#*=}" ;;
    '$top='*) top="${1#*=}" ;;
    path=*) path="${1#*=}" ;;
    versionDescriptor.version=*) revision="${1#*=}" ;;
    subjectDescriptor=*) subject="${1#*=}" ;;
  esac
  shift
done
case "$api_version" in
  7.1|7.1-preview) ;;
  *) echo "Unsupported invoke version (preview revision suffixes are not parsed): $api_version" >&2; exit 99 ;;
esac
case "$resource" in
  memberships)
    [ "$MOCK_SCENARIO" != graph-fail ] || exit 1
    groups='[]'
    case "$MOCK_SCENARIO" in
      team-only|nested|mixed|group-id-fail|group-limit|group-query-fail|nested-graph-fail|graph-count-fail|graph-continuation|graph-body-continuation)
	if [ "$subject" = aad.user ]; then groups='["vssgp.one"]'; fi ;;
    esac
    if [ "$MOCK_SCENARIO" = group-limit ] && [ "$subject" = aad.user ]; then groups='["vssgp.one","vssgp.two"]'; fi
    if [ "$MOCK_SCENARIO" = nested ]; then
      case "$subject" in vssgp.one) groups='["vssgp.two"]' ;; vssgp.two) groups='["vssgp.one"]' ;; esac
    fi
    if [ "$MOCK_SCENARIO" = nested-graph-fail ] && [ "$subject" = vssgp.one ]; then exit 1; fi
    jq -nc --arg subject "$subject" --arg scenario "$MOCK_SCENARIO" --argjson groups "$groups" '
      {count:($groups|length),value:[$groups[] | {memberDescriptor:$subject,containerDescriptor:.}]} |
      if $scenario=="graph-count-fail" then .count=99
      elif $scenario=="graph-continuation" then .continuation_token="more"
      elif $scenario=="graph-body-continuation" then .continuationToken="more"
      else . end' ;;
  storagekeys)
    [ "$MOCK_SCENARIO" != group-id-fail ] || exit 1
    case "$subject" in
      vssgp.one) id="$group_id" ;;
      vssgp.two) id="$parent_id" ;;
      *) echo "Unknown descriptor $subject" >&2; exit 99 ;;
    esac
    jq -nc --arg id "$id" '{value:$id}' ;;
  pullRequestIterations)
    [ "$MOCK_SCENARIO" != iterations-fail ] || exit 1
    jq -nc --arg scenario "$MOCK_SCENARIO" '
      {id:2,sourceRefCommit:{commitId:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
       commonRefCommit:{commitId:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
       updatedDate:"2026-11-08T10:00:00.1234567Z",createdDate:"2026-11-07T10:00:00Z"} |
      if $scenario=="missing-common" then .targetRefCommit=.commonRefCommit | del(.commonRefCommit)
      elif $scenario=="unknown-freshness" then del(.updatedDate,.createdDate)
      elif $scenario=="bad-freshness" then .updatedDate="not a date"
      elif $scenario=="sentinel-freshness" then .updatedDate="0001-01-01T00:00:00Z"
      elif $scenario=="iteration-created" then del(.updatedDate)
      elif $scenario=="timezone-freshness" then .updatedDate="2026-10-08T23:30:00-02:00"
      elif $scenario=="before-cutoff" then .updatedDate="2026-10-08T23:59:59Z"
      elif $scenario=="at-cutoff" then .updatedDate="2026-10-09T00:00:00Z"
      else . end | {value:[.]} |
      if $scenario=="iterations-continuation" then .continuation_token="more" else . end' ;;
  pullRequestIterationChanges)
    if [ "$skip" = 0 ]; then
      [ "$top" = 2000 ] || exit 99
      echo '{"changeEntries":[{"changeId":1,"item":{"path":"/a.txt"},"changeType":"add"}],"nextSkip":1,"nextTop":1}'
    else
      [ "$skip" = 1 ] && [ "$top" = 1 ] || exit 99
      [ "$MOCK_SCENARIO" != page-fail ] || exit 1
      next=0
      [ "$MOCK_SCENARIO" != repeated-page ] || next=1
      jq -nc --argjson next "$next" '{changeEntries:[{changeId:2,item:{path:"/b.txt"},changeType:"edit"}],nextSkip:$next,nextTop:$next}'
    fi ;;
  items)
    if [ "$MOCK_SCENARIO" = content-fail ] && [ "$path" = /b.txt ]; then exit 1; fi
    if [ "$MOCK_SCENARIO" = binary ] && [ "$path" = /b.txt ]; then
      echo '{"contentMetadata":{"isBinary":true},"content":"opaque"}'
    elif [ "$revision" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]; then
      echo '{"contentMetadata":{"isBinary":false},"content":"old\n"}'
    elif [ "$revision" = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ]; then
      echo '{"contentMetadata":{"isBinary":false},"content":"new\n"}'
    else
      echo "Unexpected content revision: $revision" >&2; exit 99
    fi ;;
  *) echo "Unexpected Azure resource: $resource" >&2; exit 99 ;;
esac
MOCK
cat >"$temp_dir/bin/date" <<'MOCK'
#!/usr/bin/env bash
printf '2026-10-09T00:00:00Z\n'
MOCK
chmod +x "$temp_dir/bin/gh" "$temp_dir/bin/az" "$temp_dir/bin/date"

fail() {
  printf 'not ok - %s\n' "$*" >&2
  cat "$temp_dir/stdout" "$temp_dir/stderr" >&2
  exit 1
}
run() {
  local expected="$1" scenario="$2" status
  shift 2
  : >"$temp_dir/log"
  rm -f -- "$temp_dir/seen-alpha" "$temp_dir/seen-beta"
  if env -i PATH="$temp_dir/bin:/usr/bin:/bin" MOCK_LOG="$temp_dir/log" MOCK_DIR="$temp_dir" MOCK_SCENARIO="$scenario" \
    "$BASH" "$script" --all-ages "$@" >"$temp_dir/stdout" 2>"$temp_dir/stderr"; then status=0; else status=$?; fi
  [ "$status" -eq "$expected" ] || fail "$scenario expected exit $expected, got $status"
  if [ "$expected" = 0 ]; then [ ! -s "$temp_dir/stderr" ] || fail "$scenario unexpected stderr"; fi
}
json() { jq -e "$1" "$temp_dir/stdout" >/dev/null || fail "JSON assertion: $1"; }
count() {
  local actual
  actual="$(awk -v pattern="$1" '$0 ~ pattern {n++} END {print n+0}' "$temp_dir/log")"
  [ "$actual" -eq "$2" ] || fail "Expected $2 calls matching $1, got $actual"
}
triage() {
  node --input-type=module - "$script_dir/../../../extensions/foundry/workflows/review.mjs" "$temp_dir/stdout" "$1" "${2:-false}" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { run } = await import(pathToFileURL(process.argv[2]).href);
const args = JSON.parse(readFileSync(process.argv[3], "utf8"));
args.approve_only_low_risk_manual = process.argv[5] === "true";
let verifiers = 0;
const report = await run({
  args, phase() {}, log() {},
  step: (_key, produce) => produce(),
  parallel: (thunks) => Promise.all(thunks.map((thunk) => thunk())),
  pipeline: (items, ...stages) => Promise.all(items.map(async (item, index) => {
    const original = item;
    for (const stage of stages) item = await stage(item, original, index);
    return item;
  })),
  agent: async (_prompt, { schema }) => {
    if (schema.properties.risk) return { risk: "low", issues: [], missingTests: [], maintainability: [], uncertainty: [], summary: "Clean" };
    verifiers++;
    return { passed: true, reasons: "Independently checked" };
  },
});
const expected = Number(process.argv[4]);
assert.equal(report.match(/^\| Approve \|/gm)?.length ?? 0, expected, report);
assert.equal(verifiers, expected);
assert.equal(report.match(/^\| (?:Approve|Needs review) \|/gm)?.length ?? 0, args.prs.length);
NODE
}

printf '1..17\n'
run 0 complete --github-only
json '.fetch.complete and (.fetch.failures|length==0) and (.prs|length==2)'
json '[.prs[].evidence.source.account] == ["alpha","beta"]'
json 'all(.prs[]; (.assignments|length==3) and .evidence.completeness.files and .evidence.completeness.diff and .evidence.completeness.assignments)'
json 'all(.prs[]; .codeowners_ref == .evidence.source.baseRevision and (.my_teams|length==2))'
count 'api repos/owner/repo/pulls/1$' 4
count 'application/vnd.github.diff' 2
count 'ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 2
printf 'ok 1 - per-account dedup retains every direct and team assignment with pinned revisions\n'

run 0 codeowners-absent --github-only
json '.fetch.complete and all(.prs[]; .codeowners == "" and .evidence.completeness.assignments)'
run 4 codeowners-fail --github-only
json '(.fetch.complete|not) and all(.prs[]; (.evidence.completeness.assignments|not))'
json 'any(.fetch.failures[]; .stage == "codeowners")'
printf 'ok 2 - confirmed CODEOWNERS absence differs from authorization failure\n'

run 4 teams-fail --github-only
json '(.fetch.complete|not) and all(.prs[]; (.evidence.completeness.assignments|not))'
run 4 search-fail --github-only
json '(.fetch.complete|not) and (.prs|length==0) and any(.fetch.failures[]; .stage == "search")'
run 4 metadata-fail --github-only
json '(.fetch.complete|not) and (.prs|length==0) and any(.fetch.failures[]; .stage == "metadata")'
run 4 accounts-fail --github-only
json '(.fetch.complete|not) and (.prs|length==1) and any(.fetch.failures[]; .stage == "accounts" and .account == "beta")'
printf 'ok 3 - discovery and metadata errors never resemble a complete empty queue\n'

for scenario in files-fail diff-fail binary revision; do
  run 4 "$scenario" --github-only
  json '(.fetch.complete|not) and all(.prs[]; .coverage != "full diff")'
done
printf 'ok 4 - missing files, failed/binary diffs, and concurrent revisions remain incomplete\n'

run 4 complete --github-only --limit 1
json '(.fetch.complete|not) and any(.fetch.failures[]; .stage == "search" and (.message|contains("limit")))'
run 0 complete --github-only --no-diff
json '.fetch.complete and all(.prs[]; (.evidence.completeness.diff|not) and .diff == "")'
count 'application/vnd.github.diff' 0
printf 'ok 5 - limited lookups and intentional metadata-only fetches have explicit coverage\n'

run 0 complete --azure-only --ado-scope org project --ado-scope org project
json '.fetch.complete and (.prs|length==1) and .prs[0].files == ["a.txt","b.txt"]'
json '.prs[0].evidence.source.iteration == 2 and .prs[0].evidence.completeness.files and .prs[0].evidence.completeness.diff'
json '(.prs[0].diff|contains("+new")) and (.prs[0].diff|contains("-old"))'
count 'resource pullRequestIterationChanges' 2
count '[$]skip=1 [$]compareTo=0' 1
count 'repos pr list' 1
printf 'ok 6 - Azure follows nextSkip/nextTop and deduplicates scopes before content fetches\n'

run 4 page-fail --azure-only --ado-scope org project
json '(.fetch.complete|not) and .prs[0].files == ["a.txt"] and (.prs[0].evidence.completeness.files|not)'
json '.prs[0].coverage == "partial diff" and (.prs[0].diff|contains("+new"))'
run 4 repeated-page --azure-only --ado-scope org project
json '(.fetch.complete|not) and (.prs[0].evidence.completeness.files|not)'
count 'resource pullRequestIterationChanges' 2
printf 'ok 7 - failed and nonadvancing Azure pages retain partial evidence without claiming full diff\n'

for scenario in content-fail binary iterations-fail missing-common; do
  run 4 "$scenario" --azure-only --ado-scope org project
  json '(.fetch.complete|not) and (.prs[0].evidence.completeness.diff|not) and .prs[0].coverage != "full diff"'
done
printf 'ok 8 - Azure content and iteration failures are explicit, not embedded text heuristics\n'

run 4 search-fail --azure-only --ado-scope org project
json '(.fetch.complete|not) and (.prs|length==0)'
run 0 complete --azure-only --ado-scope org project --no-diff
json '.fetch.complete and .prs[0].evidence.completeness.files and (.prs[0].evidence.completeness.diff|not)'
count 'resource items' 0
run 0 complete --azure-only --ado-project project
json '.fetch.complete and .prs[0].repo == "org/project/repo"'
count 'org project' 0
count 'project project' 1
printf 'ok 9 - Azure empty failures and metadata-only requests remain distinguishable\n'

run 0 complete --ado-scope org project
json '.fetch.complete and (.prs|length==3) and ([.prs[].platform]|unique|length==2)'
triage 3
printf 'ok 10 - combined providers preserve account-scoped evidence independently\n'

run 4 page-fail --azure-only --ado-scope org project
triage 0
printf 'ok 11 - actual fetch manifests drive recipe completeness and independent-verifier admission\n'

run 0 team-only --azure-only --ado-scope org project
json '.fetch.complete and (.prs|length==1) and (.prs[0].assignments|length==1)'
json '.prs[0].assignments[0] | .kind=="team" and .reviewerId=="22222222-2222-2222-2222-222222222222" and .required and .membershipPath==["aad.user","vssgp.one"]'
json '.prs[0].assignments[0] | .source.field=="pullRequest.reviewers" and .source.queryReviewerId==.reviewerId'
triage 0 true
run 0 nested --azure-only --ado-scope org project
json '.fetch.complete and .prs[0].assignments[0].membershipPath==["aad.user","vssgp.one","vssgp.two"]'
json '.prs[0].assignments[0].reviewerId=="33333333-3333-3333-3333-333333333333" and .prs[0].assignments[0].kind=="team"'
count 'resource memberships' 3
count 'repos pr list' 3
count 'resource pullRequestIterations' 1
printf 'ok 12 - direct and transitive team-only assignments use Graph paths and actual reviewer IDs\n'

run 0 mixed --azure-only --ado-scope org project --ado-scope org project
json '.fetch.complete and (.prs|length==1) and ([.prs[0].assignments[].kind]|sort)==["team","user"]'
count 'devops user show' 1
count 'resource pullRequestIterations' 1
count 'resource pullRequestIterationChanges' 2
run 0 voted-for --azure-only --ado-scope org project
json '.fetch.complete and (.prs[0].assignments|length==1) and .prs[0].assignments[0].kind=="user" and .prs[0].my_teams==[]'
for scenario in assignment-mismatch assignment-malformed; do
  run 4 "$scenario" --azure-only --ado-scope org project
  json '(.fetch.complete|not) and .prs[0].assignments==[] and (.prs[0].evidence.completeness.assignments|not)'
done
printf 'ok 13 - assignment dedup preserves actual sources without inferring membership from votes\n'

for scenario in graph-fail nested-graph-fail graph-count-fail graph-continuation graph-body-continuation group-id-fail group-query-fail; do
  run 4 "$scenario" --azure-only --ado-scope org project
  json '(.fetch.complete|not) and (.prs|length==1) and (.prs[0].evidence.completeness.assignments|not)'
  triage 0
done
for scenario in identity-fail identity-mismatch; do
  run 4 "$scenario" --azure-only --ado-scope org project
  json '(.fetch.complete|not) and .prs==[] and any(.fetch.failures[]; .stage=="identity")'
  count 'repos pr list' 0
done
run 4 group-limit --azure-only --ado-scope org project --max-groups 1
json '(.fetch.complete|not) and (.prs[0].evidence.completeness.assignments|not) and any(.fetch.failures[]; .message|contains("bound 1"))'
count 'resource memberships' 2
printf 'ok 14 - graph, identity, authorization, query, and traversal limits remain explicitly incomplete\n'

run 0 complete --azure-only --ado-scope org project --max-age-days 30
json '.fetch.complete and (.prs|length==1) and .prs[0].updatedAt=="2026-11-08T10:00:00Z"'
json '.prs[0].freshness | .source=="iteration.updatedDate" and .iteration==2 and (.meaning|contains("not comment"))'
count 'resource pullRequestIterations' 1
run 0 iteration-created --azure-only --ado-scope org project --max-age-days 30
json '.prs[0].updatedAt=="" and .prs[0].freshness.timestamp=="2026-11-07T10:00:00Z" and .prs[0].freshness.source=="iteration.createdDate"'
printf 'ok 15 - old PRs with fresh iterations survive filtering with explicit timestamp provenance\n'

for scenario in unknown-freshness bad-freshness sentinel-freshness iterations-continuation; do
  run 4 "$scenario" --azure-only --ado-scope org project --max-age-days 30
  json '(.fetch.complete|not) and (.prs|length==1) and .prs[0].updatedAt=="" and .prs[0].freshness.timestamp==null'
  json 'any(.prs[0].evidence.failures[]; .stage=="freshness")'
  triage 0
done
printf 'ok 16 - unavailable freshness is retained, flagged, and never replaced with PR creation time\n'

run 0 before-cutoff --azure-only --ado-scope org project --max-age-days 30
json '.fetch.complete and .prs==[]'
count 'resource pullRequestIterationChanges' 0
count 'resource items' 0
run 0 at-cutoff --azure-only --ado-scope org project --max-age-days 30
json '.fetch.complete and (.prs|length==1)'
run 0 timezone-freshness --azure-only --ado-scope org project --max-age-days 30
json '.fetch.complete and (.prs|length==1) and .prs[0].updatedAt=="2026-10-09T01:30:00Z"'
printf 'ok 17 - age filtering uses normalized iteration instants and inclusive cutoff boundaries\n'

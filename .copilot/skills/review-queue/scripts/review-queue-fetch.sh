#!/usr/bin/env bash
# Gather assigned GitHub + Azure DevOps PRs and print normalized JSON.
set -euo pipefail

LIMIT=100
MAX_AZURE_GROUPS=200
MAX_AGE_DAYS=30
WANT_DIFF=1
DO_GH=1
DO_AZ=1
ADO_ORG="${AZURE_DEVOPS_ORG:-}"
ADO_PROJECT="${AZURE_DEVOPS_PROJECT:-}"
ADO_EXTRA_ORGS=()
ADO_EXTRA_PROJECTS=()

warn() { echo "review-queue-fetch: $*" >&2; }
need() { [ "$1" -ge "$2" ] || { warn "$3. Use --help for usage."; exit 2; }; }
jr() { printf "%s" "$1" | jq -r "$2"; }

usage() {
  printf '%s\n' 'Usage: review-queue-fetch.sh [OPTIONS]
Gather assigned GitHub and Azure DevOps PRs as {prs, fetch} JSON on stdout.
Warnings go to stderr. Fetching is read-only and never approves PRs.

Options:
  --limit N		Positive result limit per lookup (default: 100).
  --max-groups N	Positive Azure group-discovery bound per org (default: 200).
  --max-age-days N	Non-negative freshness filter in days (default: 30; 0: all).
  --all-ages		Disable the age filter.
  --github-only		Fetch GitHub only; cannot combine with --azure-only.
  --azure-only		Fetch Azure DevOps only.
  --ado-org ORG		Azure organization name or URL.
  --ado-project PROJECT Azure project; "*" lists all accessible projects.
  --ado-scope ORG PROJ	Add an Azure scope; repeat for multiple scopes.
  --no-diff		Fetch metadata only; insufficient for approval triage.
  -h, --help		Show this help without dependencies or authentication.

Dependencies:
  Bash and jq are required to fetch. GitHub needs gh with authenticated accounts.
  Azure needs az, its Azure DevOps extension, and az login.
  All authenticated github.com accounts are queried without switching accounts.

Azure defaults:
  AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT select the default scope.
  AZURE_DEVOPS_EXTRA_SCOPES (or AZURE_DEVOPS_SCOPES) accepts ORG|PROJECT;ORG|PROJECT.
  Otherwise the configured Azure CLI scope is used.

Freshness:
  GitHub uses PR updated_at. Azure uses the latest iteration updatedDate/createdDate,
  not PR creationDate or comment/review activity. Unknown Azure freshness is retained
  and reported as incomplete rather than filtered out.

Examples:
  review-queue-fetch.sh --github-only --limit 25
  review-queue-fetch.sh --azure-only --ado-scope example platform --all-ages

Exit codes:
  0: complete fetch or help. 2: invalid arguments. 3: jq is missing.
  4: incomplete fetch; stdout retains partial PRs and structured failures.'
}

valid_integer() {
  case "$1" in ""|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge "$2" ] 2>/dev/null
}

ado_norm_org() {
  local org="$1"
  [ -z "$org" ] && { printf "\n"; return; }
  case "$org" in http://*|https://*) ;; *) org="https://dev.azure.com/$org/" ;; esac
  printf "%s\n" "${org%/}/"
}

ado_org_name() {
  local org="${1%/}"
  case "$org" in
    https://dev.azure.com/*) org="${org#https://dev.azure.com/}"; org="${org%%/*}" ;;
    http://dev.azure.com/*) org="${org#http://dev.azure.com/}"; org="${org%%/*}" ;;
    https://*.visualstudio.com*) org="${org#https://}"; org="${org%%.visualstudio.com*}" ;;
    http://*.visualstudio.com*) org="${org#http://}"; org="${org%%.visualstudio.com*}" ;;
    http://*|https://*) org="${org#https://}"; org="${org#http://}"; org="${org%%/*}" ;;
  esac
  printf "%s\n" "$org"
}

add_ado_scope() {
  ADO_EXTRA_ORGS+=("$(ado_norm_org "$1")")
  ADO_EXTRA_PROJECTS+=("$2")
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --limit) need $# 2 "--limit needs a value"; LIMIT="$2"; shift 2 ;;
    --max-groups) need $# 2 "--max-groups needs a value"; MAX_AZURE_GROUPS="$2"; shift 2 ;;
    --max-age-days) need $# 2 "--max-age-days needs a value"; MAX_AGE_DAYS="$2"; shift 2 ;;
    --all-ages) MAX_AGE_DAYS=0; shift ;;
    --no-diff) WANT_DIFF=0; shift ;;
    --github-only) DO_AZ=0; shift ;;
    --azure-only) DO_GH=0; shift ;;
    --ado-org) need $# 2 "--ado-org needs a value"; ADO_ORG="$2"; shift 2 ;;
    --ado-project) need $# 2 "--ado-project needs a value"; ADO_PROJECT="$2"; shift 2 ;;
    --ado-scope) need $# 3 "--ado-scope needs ORG and PROJECT"; add_ado_scope "$2" "$3"; shift 3 ;;
    *) warn "unknown arg $1. Use --help for usage."; exit 2 ;;
  esac
done

valid_integer "$LIMIT" 1 || { warn "--limit must be a positive integer; received '$LIMIT'."; exit 2; }
valid_integer "$MAX_AZURE_GROUPS" 1 || { warn "--max-groups must be a positive integer; received '$MAX_AZURE_GROUPS'."; exit 2; }
valid_integer "$MAX_AGE_DAYS" 0 || { warn "--max-age-days must be a non-negative integer; received '$MAX_AGE_DAYS'."; exit 2; }
[ "$DO_GH" -eq 1 ] || [ "$DO_AZ" -eq 1 ] || { warn "--github-only and --azure-only are mutually exclusive."; exit 2; }

command -v jq >/dev/null 2>&1 || { warn "jq is required"; exit 3; }

if [ "$MAX_AGE_DAYS" -gt 0 ]; then
  SINCE="$(date -u -v-"$MAX_AGE_DAYS"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "$MAX_AGE_DAYS days ago" +%Y-%m-%dT%H:%M:%SZ)"
else
  SINCE=""
fi

if [ -n "${AZURE_DEVOPS_EXTRA_SCOPES:-${AZURE_DEVOPS_SCOPES:-}}" ]; then
  old_ifs="$IFS"; IFS=';'
  for scope in ${AZURE_DEVOPS_EXTRA_SCOPES:-${AZURE_DEVOPS_SCOPES:-}}; do
    [ "$scope" != "${scope#*|}" ] && add_ado_scope "${scope%%|*}" "${scope#*|}"
  done
  IFS="$old_ifs"
fi

TMP="$(mktemp -d)"
OUT="$TMP/prs.jsonl"
ERRORS="$TMP/failures.jsonl"
trap 'rm -f -- "$TMP"/*; rmdir -- "$TMP"' EXIT
: >"$OUT"
: >"$ERRORS"

failure() {
  warn "$1/$2 $3: $4: $5"
  jq -nc --arg platform "$1" --arg account "$2" --arg scope "$3" --arg stage "$4" --arg message "$5" \
    '{platform:$platform,account:$account,scope:$scope,stage:$stage,message:$message}' >>"$ERRORS"
}

gh_as() {
  local user="$1" token active
  shift
  if token="$(gh auth token --hostname github.com --user "$user" 2>/dev/null)"; then
    GH_TOKEN="$token" GH_HOST=github.com gh "$@"
    return
  fi
  active="$(gh api --hostname github.com user -q .login)" || return 1
  [ "$user" = "$active" ] && GH_HOST=github.com gh "$@"
}

gh_accounts() {
  local user
  if ! gh auth status --hostname github.com --json hosts >"$TMP/accounts.json" 2>"$TMP/provider.err"; then
    failure github "" "" accounts "Account discovery failed or an account needs authentication"
  fi
  while IFS= read -r user; do
    failure github "$user" "" accounts "Account requires authentication"
  done < <(jq -r '.hosts["github.com"][]? | select(.state != "success") | .login' "$TMP/accounts.json")
  if ! jq -er '.hosts["github.com"][]? | select(.state == "success") | .login' "$TMP/accounts.json" | sort -u >"$TMP/accounts"; then
    failure github "" "" accounts "No authenticated github.com account was discovered"
  fi
}

gh_codeowners() {
  local user="$1" repo="$2" ref="$3" path
  : >"$TMP/codeowners"
  for path in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do
    if gh_as "$user" api --method GET "repos/$repo/contents/$path" -f "ref=$ref" >"$TMP/content.json" 2>"$TMP/provider.err"; then
      jq -er '.content | select(type == "string")' "$TMP/content.json" | base64 -d >"$TMP/codeowners"
      return
    elif ! grep -q '(HTTP 404)' "$TMP/provider.err"; then
      return 1
    fi
  done
}

gh_emit() {
  local user="$1" repo="$2" num="$3" teams="$4" assignments="$5" assignments_complete="$6"
  local base diff_complete=false files_complete=true
  if ! gh_as "$user" api "repos/$repo/pulls/$num" >"$TMP/meta.json" 2>"$TMP/provider.err" \
    || ! jq -e '.base.sha and .head.sha and (.changed_files | type == "number")' "$TMP/meta.json" >/dev/null; then
    failure github "$user" "$repo#$num" metadata "PR metadata unavailable"
    return
  fi
  base="$(jq -r '.base.sha' "$TMP/meta.json")"
  if ! gh_codeowners "$user" "$repo" "$base"; then
    failure github "$user" "$repo#$num" codeowners "CODEOWNERS lookup failed (not a confirmed absence)"
    assignments_complete=false
  fi
  if ! gh_as "$user" api --paginate --slurp "repos/$repo/pulls/$num/files?per_page=100" >"$TMP/pages.json" 2>"$TMP/provider.err" \
    || ! jq -e '[.[][] | if (.filename | type == "string" and length > 0) then . else error("Malformed file record") end]' "$TMP/pages.json" >"$TMP/files.json"; then
    printf '[]' >"$TMP/files.json"
    files_complete=false
  fi
  if [ "$files_complete" = false ] || ! jq -e --slurpfile meta "$TMP/meta.json" 'length == $meta[0].changed_files' "$TMP/files.json" >/dev/null; then
    failure github "$user" "$repo#$num" files "Changed-file listing failed or was truncated"
    files_complete=false
  fi
  : >"$TMP/diff"
  if [ "$WANT_DIFF" -eq 1 ]; then
    if gh_as "$user" api "repos/$repo/pulls/$num" -H 'Accept: application/vnd.github.diff' >"$TMP/diff" 2>"$TMP/provider.err" \
      && ! grep -Eq '^(Binary files |GIT binary patch)' "$TMP/diff"; then
      diff_complete=true
    else
      failure github "$user" "$repo#$num" diff "Diff unavailable or contains opaque binary changes"
    fi
  fi
  if ! gh_as "$user" api "repos/$repo/pulls/$num" >"$TMP/after.json" 2>"$TMP/provider.err" \
    || ! jq -e --slurpfile before "$TMP/meta.json" \
      '[.base.sha,.head.sha,.changed_files] == ($before[0] | [.base.sha,.head.sha,.changed_files])' "$TMP/after.json" >/dev/null; then
    failure github "$user" "$repo#$num" revision "PR revisions changed during fetch or could not be rechecked"
    files_complete=false; diff_complete=false
  fi
  jq -nc --arg repo "$repo" --argjson num "$num" --arg me "$user" --argjson teams "$teams" \
    --argjson assignments "$assignments" --argjson assignments_complete "$assignments_complete" \
    --argjson files_complete "$files_complete" --argjson diff_complete "$diff_complete" \
    --rawfile co "$TMP/codeowners" --rawfile diff "$TMP/diff" --slurpfile meta "$TMP/meta.json" \
    --slurpfile files "$TMP/files.json" --slurpfile failures "$ERRORS" '
    $meta[0] as $m |
    {platform:"github", repo:$repo, number:$num, title:$m.title, url:$m.html_url,
     author:($m.user.login // ""), draft:$m.draft, updatedAt:($m.updated_at // ""),
     additions:$m.additions, deletions:$m.deletions, files:[$files[0][] | .filename],
     reviewers:[($m.requested_reviewers[]? | {name:.login,required:false})],
     teams:[($m.requested_teams[]? | (($repo | split("/")[0]) + "/" + .slug))],
     me:$me, my_teams:$teams, assignments:$assignments, codeowners:$co, codeowners_ref:$m.base.sha, base_ref:$m.base.ref, diff:$diff,
     coverage:(if $diff_complete and $files_complete then "full diff" elif ($diff|length)>0 then "partial diff" else "no diff" end),
     evidence:{version:1,source:{platform:"github",host:"github.com",repository:$repo,number:$num,account:$me,
       baseRevision:$m.base.sha,headRevision:$m.head.sha},
       completeness:{files:$files_complete,diff:$diff_complete,assignments:$assignments_complete},
       failures:[$failures[] | select(.account == $me and (.scope == "" or .scope == ($repo + "#" + ($num|tostring))))]},
     clone_url:("https://github.com/" + $repo + ".git"), pr_ref:("pull/" + ($num|tostring) + "/head")}'
}

fetch_github() {
  command -v gh >/dev/null 2>&1 || { failure github "" "" dependency "gh unavailable"; return; }
  local user me teams repo num reviewer query assignments assignments_complete
  gh_accounts
  while IFS= read -r user; do
    [ -n "$user" ] || continue
    if ! me="$(gh_as "$user" api user -q .login 2>"$TMP/provider.err")" || [ "$me" != "$user" ]; then
      failure github "$user" "" identity "Authenticated account could not be confirmed"
      continue
    fi
    assignments_complete=true
    if ! gh_as "$user" api --paginate --slurp user/teams >"$TMP/teams.json" 2>"$TMP/provider.err" \
      || ! teams="$(jq -ec '[.[][] | if (.organization.login | type == "string" and length > 0) and (.slug | type == "string" and length > 0)
	then (.organization.login + "/" + .slug) else error("Malformed team membership") end] | unique' "$TMP/teams.json")"; then
      failure github "$user" "" teams "Team membership lookup failed"
      teams='[]'; assignments_complete=false
    fi
    : >"$TMP/matches.jsonl"
    for reviewer in "$me" $(printf "%s" "$teams" | jq -r '.[]'); do
      query=(--review-requested="$reviewer" --state=open)
      [ -n "$SINCE" ] && query+=(--updated ">=$SINCE")
      if ! gh_as "$user" search prs "${query[@]}" --limit "$LIMIT" --json repository,number >"$TMP/search.json" 2>"$TMP/provider.err" \
	|| ! jq -e 'type == "array"' "$TMP/search.json" >/dev/null; then
	failure github "$user" "" search "Review-request search failed for $reviewer"
	assignments_complete=false
	continue
      fi
      if [ "$(jq length "$TMP/search.json")" -ge "$LIMIT" ]; then
	failure github "$user" "" search "Result limit reached for $reviewer; queue coverage is unknown"
	assignments_complete=false
      fi
      jq -c --arg account "$me" --arg reviewer "$reviewer" \
	'.[] | {repo:.repository.nameWithOwner,number,assignment:{account:$account,reviewer:$reviewer,kind:(if $reviewer == $account then "user" else "team" end)}}' \
	"$TMP/search.json" >>"$TMP/matches.jsonl"
    done
    jq -s -r 'group_by([(.repo|ascii_downcase),.number])[] | [.[0].repo,.[0].number,([.[].assignment]|unique|tojson)] | @tsv' \
      "$TMP/matches.jsonl" >"$TMP/matches"
    while IFS=$'\t' read -r repo num assignments; do
      gh_emit "$user" "$repo" "$num" "$teams" "$assignments" "$assignments_complete" >>"$OUT"
    done <"$TMP/matches"
  done <"$TMP/accounts"
}

az_git() {
  local org="$1" resource="$2"
  shift 2
  local cmd=(az devops invoke --area git --resource "$resource" --api-version 7.1 -o json)
  [ -n "$org" ] && cmd+=(--org "$org")
  "${cmd[@]}" "$@"
}

az_user() {
  az account show --query user.name -o tsv
}

az_graph() {
  local org="$1" resource="$2" descriptor="$3" version=7.1
  shift 3
  # invoke cannot parse the optional preview revision suffix.
  [ "$resource" != memberships ] || version=7.1-preview
  local cmd=(az devops invoke --area graph --resource "$resource" --api-version "$version"
    --route-parameters "subjectDescriptor=$descriptor" -o json)
  [ -z "$org" ] || cmd+=(--org "$org")
  "${cmd[@]}" "$@" 2>"$TMP/provider.err"
}

az_identities() {
  local org="$1" me="$2" descriptor parent user_id id index=0 kind limited=false
  local descriptors=() paths=()
  local cmd=(az devops user show --user "$me" -o json)
  local uuid='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  [ -z "$org" ] || cmd+=(--org "$org")
  AZ_ASSIGNMENTS_COMPLETE=true
  : >"$TMP/identities.jsonl"
  if ! "${cmd[@]}" >"$TMP/user.json" 2>"$TMP/provider.err" \
    || ! jq -e --arg me "$me" --arg uuid "$uuid" '
      (.id | type == "string" and test($uuid)) and .user.subjectKind == "user" and
      (.user.descriptor | type == "string" and length > 0 and (test("[\\r\\n\\t]")|not)) and
      ([.user.principalName,.user.mailAddress] | any(.[]; type == "string" and (ascii_downcase == ($me|ascii_downcase))))' "$TMP/user.json" >/dev/null; then
    failure azure "$me" "$org" identity "Azure DevOps user identity/descriptor could not be established"
    AZ_ASSIGNMENTS_COMPLETE=false
    return
  fi
  user_id="$(jq -r '.id | ascii_downcase' "$TMP/user.json")"
  descriptor="$(jq -r '.user.descriptor' "$TMP/user.json")"
  descriptors+=("$descriptor")
  paths+=("$(jq -nc --arg descriptor "$descriptor" '[$descriptor]')")
  while [ "$index" -lt "${#descriptors[@]}" ]; do
    descriptor="${descriptors[$index]}"
    kind=team; id=""
    if [ "$index" -eq 0 ]; then
      kind=user; id="$user_id"
    elif az_graph "$org" storagekeys "$descriptor" >"$TMP/storage-key.json" \
      && id="$(jq -er --arg uuid "$uuid" '.value | select(type == "string" and test($uuid)) | ascii_downcase' "$TMP/storage-key.json")"; then
      :
    else
      failure azure "$me" "$org" groups "Reviewer ID unavailable for Graph subject $descriptor"
      AZ_ASSIGNMENTS_COMPLETE=false
    fi
    if [ -n "$id" ]; then
      jq -nc --arg id "$id" --arg descriptor "$descriptor" --arg kind "$kind" --argjson path "${paths[$index]}" \
	'{reviewerId:$id,descriptor:$descriptor,kind:$kind,membershipPath:$path}' >>"$TMP/identities.jsonl"
    fi
    if ! az_graph "$org" memberships "$descriptor" --query-parameters direction=up depth=1 >"$TMP/memberships.json" \
      || ! jq -e --arg descriptor "$descriptor" '
	(.value | type == "array") and
	all(.value[]; .memberDescriptor == $descriptor and
	  (.containerDescriptor | type == "string" and length > 0 and (test("[\\r\\n\\t]")|not)))' "$TMP/memberships.json" >/dev/null; then
      failure azure "$me" "$org" memberships "Direct memberships unavailable or incomplete for $descriptor"
      AZ_ASSIGNMENTS_COMPLETE=false
      index=$((index + 1))
      continue
    fi
    if ! jq -e '.count == (.value|length) and
      ([.continuationToken,.continuation_token,.nextLink] | all(.[]; . == null or . == ""))' "$TMP/memberships.json" >/dev/null; then
      failure azure "$me" "$org" memberships "Membership response is incomplete for $descriptor; known edges retained"
      AZ_ASSIGNMENTS_COMPLETE=false
    fi
    while IFS= read -r parent; do
      if printf '%s\n' "${descriptors[@]}" | grep -Fxq -- "$parent"; then continue; fi
      if [ "${#descriptors[@]}" -gt "$MAX_AZURE_GROUPS" ]; then
	if [ "$limited" = false ]; then
	  failure azure "$me" "$org" groups "Group-discovery bound $MAX_AZURE_GROUPS reached; transitive membership is incomplete"
	  limited=true
	fi
	AZ_ASSIGNMENTS_COMPLETE=false
	break
      fi
      descriptors+=("$parent")
      paths+=("$(printf '%s' "${paths[$index]}" | jq -c --arg parent "$parent" '. + [$parent]')")
    done < <(jq -r '[.value[].containerDescriptor] | unique[]' "$TMP/memberships.json")
    index=$((index + 1))
  done
}

ado_scopes() {
  local i=0
  [ -n "$ADO_ORG$ADO_PROJECT" ] || [ "${#ADO_EXTRA_ORGS[@]}" -gt 0 ] || printf "%s|%s\n" "" ""
  [ -n "$ADO_ORG$ADO_PROJECT" ] && printf "%s|%s\n" "$(ado_norm_org "$ADO_ORG")" "$ADO_PROJECT"
  while [ "$i" -lt "${#ADO_EXTRA_ORGS[@]}" ]; do
    printf "%s|%s\n" "${ADO_EXTRA_ORGS[$i]}" "${ADO_EXTRA_PROJECTS[$i]}"
    i=$((i + 1))
  done
}

ado_projects() {
  local org="$1" project="$2"
  if [ "$project" != "*" ]; then printf "%s\n" "$project"; return; fi
  [ -n "$org" ] || { warn "project '*' requires --ado-org or AZURE_DEVOPS_ORG"; return 1; }
  az devops project list --org "$org" --top 1000 -o json >"$TMP/projects.json" 2>"$TMP/provider.err" || return 1
  jq -e '(.value | type == "array" and length < 1000) and
    ([.continuationToken,.continuation_token,.nextLink] | all(.[]; . == null or . == ""))' "$TMP/projects.json" >/dev/null || return 1
  jq -r '.value[].name' "$TMP/projects.json"
}

ado_prs() {
  local org="$1" project="$2" reviewer_id="$3"
  local cmd=(az repos pr list --status active --top "$LIMIT" --reviewer "$reviewer_id" --include-links)
  [ -n "$org" ] && cmd+=(--org "$org")
  [ -n "$project" ] && cmd+=(--project "$project")
  "${cmd[@]}" -o json 2>"$TMP/provider.err"
}

az_iteration() {
  local pr="$1" org="$2" me="$3" repo project pr_id scope
  IFS=$'\t' read -r repo project pr_id <<EOF
$(printf "%s" "$pr" | jq -r '[.repository.id // .repository.name // "", .repository.project.name // .repository.project.id // "", .pullRequestId // ""] | @tsv')
EOF
  scope="$repo#$pr_id"
  if ! az_git "$org" pullRequestIterations --route-parameters "project=$project" "repositoryId=$repo" "pullRequestId=$pr_id" >"$TMP/iterations.json" 2>"$TMP/provider.err" \
    || ! jq -e 'if type == "array" then . else
      select([.continuationToken,.continuation_token,.nextLink] | all(.[]; . == null or . == "")) | .value end |
      select(type == "array" and length > 0) |
      select(all(.[]; (.id | type == "number" and . > 0 and . == floor))) |
      select((map(.id)|unique|length) == length) | max_by(.id)' "$TMP/iterations.json" >"$TMP/iteration.json"; then
    failure azure "$me" "$scope" iterations "Iteration metadata and freshness unavailable"
    printf '{}' >"$TMP/iteration.json"
  fi
  jq '
    def utc:
      try (
	capture("^(?<date>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.[0-9]+)?(?<zone>Z|[+-][0-9]{2}:[0-9]{2})$") as $p |
	($p.date + "Z" | fromdateiso8601) as $base |
	select($base >= 0 and ($base|todateiso8601) == ($p.date + "Z")) |
	(if $p.zone == "Z" then 0 else
	  ($p.zone[1:3]|tonumber) as $h | ($p.zone[4:6]|tonumber) as $m |
	  select($h < 24 and $m < 60) |
	  (($h * 60 + $m) * 60 * (if $p.zone[0:1] == "-" then -1 else 1 end))
	end) as $offset | ($base - $offset | todateiso8601)
      ) catch null;
    . as $iteration |
    (if .updatedDate != null then "updatedDate" else "createdDate" end) as $field |
    (.[$field] // null) as $raw |
    . + {freshness:{
      timestamp: ([$raw | utc][0] // null), rawTimestamp:$raw,
      source:("iteration." + $field), iteration:($iteration.id // null),
      meaning:"Latest PR iteration activity (code/retarget); not comment, review, or general PR metadata activity"
    }}' "$TMP/iteration.json" >"$TMP/iteration-next.json"
  mv "$TMP/iteration-next.json" "$TMP/iteration.json"
  if ! jq -e '.freshness.timestamp != null' "$TMP/iteration.json" >/dev/null; then
    failure azure "$me" "$scope" freshness "Latest iteration timestamp unavailable; retained without age filtering"
  fi
}

az_changes() {
  local pr="$1" org="$2" me="$3" repo project pr_id iter src base skip=0 top=2000 next_skip next_top complete=true
  IFS=$'\t' read -r repo project pr_id <<EOF
$(printf "%s" "$pr" | jq -r '[.repository.id // .repository.name // "", .repository.project.name // .repository.project.id // "", .pullRequestId // ""] | @tsv')
EOF
  [ -n "$repo" ] && [ -n "$project" ] && [ -n "$pr_id" ] || return 1
  IFS=$'\t' read -r iter src base <<EOF
$(jq -r '[.id // "", .sourceRefCommit.commitId // "", .commonRefCommit.commitId // ""] | @tsv' "$TMP/iteration.json")
EOF
  [ -n "$iter" ] && [ -n "$src" ] && [ -n "$base" ] || return 1
  : >"$TMP/changes.jsonl"
  while :; do
    if ! az_git "$org" pullRequestIterationChanges \
      --route-parameters "project=$project" "repositoryId=$repo" "pullRequestId=$pr_id" "iterationId=$iter" \
      --query-parameters "\$top=$top" "\$skip=$skip" '$compareTo=0' >"$TMP/page.json" 2>"$TMP/provider.err" \
      || ! jq -e '.changeEntries | type == "array"' "$TMP/page.json" >/dev/null; then
      failure azure "$me" "$repo#$pr_id" changes "Iteration changes failed at skip=$skip; earlier pages retained"
      complete=false
      break
    fi
    jq -c '.changeEntries[]' "$TMP/page.json" >>"$TMP/changes.jsonl"
    IFS=$'\t' read -r next_skip next_top <<EOF
$(jq -r '[.nextSkip // 0, .nextTop // 0] | @tsv' "$TMP/page.json")
EOF
    if [ "$next_skip" = 0 ] && [ "$next_top" = 0 ]; then break; fi
    if ! valid_integer "$next_skip" 1 || ! valid_integer "$next_top" 1 \
      || [ "$next_skip" -le "$skip" ] || [ "$next_top" -gt 2000 ]; then
      failure azure "$me" "$repo#$pr_id" changes "Invalid or nonadvancing iteration continuation"
      complete=false
      break
    fi
    skip="$next_skip"; top="$next_top"
  done
  jq -s --arg source "$src" --arg base "$base" --argjson iteration "$iter" --argjson complete "$complete" \
    '{changeEntries:.,sourceCommit:$source,baseCommit:$base,iteration:$iteration,complete:$complete}' "$TMP/changes.jsonl"
}

az_content() {
  local pr="$1" org="$2" path="$3" commit="$4" out="$5" repo project
  IFS=$'\t' read -r repo project <<EOF
$(printf "%s" "$pr" | jq -r '[.repository.id // .repository.name // "", .repository.project.name // .repository.project.id // ""] | @tsv')
EOF
  [ -n "$repo" ] && [ -n "$project" ] && [ -n "$path" ] && [ -n "$commit" ] || return 1
  az_git "$org" items --route-parameters "project=$project" "repositoryId=$repo" \
    --query-parameters "path=$path" "versionDescriptor.version=$commit" "versionDescriptor.versionType=commit" \
      "includeContent=true" "includeContentMetadata=true" 2>/dev/null \
    | jq -je 'select(.contentMetadata.isBinary == false) | .content | select(type == "string")' >"$out"
}

az_diff() {
  local pr="$1" org="$2" me="$3" src base path old type status scope
  DIFF_COMPLETE=false
  : >"$TMP/diff"
  [ "$WANT_DIFF" -eq 1 ] || return 0
  scope="$(jr "$pr" '(.repository.id // .repository.name) + "#" + (.pullRequestId|tostring)')"
  IFS=$'\t' read -r src base <<EOF
$(jq -r '[.sourceCommit // "", .baseCommit // ""] | @tsv' "$TMP/changes.json")
EOF
  [ -n "$src" ] && [ -n "$base" ] || return 0
  DIFF_COMPLETE=true
  while IFS=$'\t' read -r path old type; do
    printf 'diff --git a/%s b/%s\n' "${old#/}" "${path#/}" >>"$TMP/diff"
    if [ "$old" != "$path" ]; then
      printf 'rename from %s\nrename to %s\n' "${old#/}" "${path#/}" >>"$TMP/diff"
    fi
    case "$type" in
      add|edit|delete|rename|"rename, edit") ;;
      *)
	failure azure "$me" "$scope" content "Unsupported change type $type: $path"
	DIFF_COMPLETE=false
	continue ;;
    esac
    : >"$TMP/old"; : >"$TMP/new"
    if [ "$type" != add ] && ! az_content "$pr" "$org" "$old" "$base" "$TMP/old"; then
      failure azure "$me" "$scope" content "Base content unavailable or binary: $old"
      DIFF_COMPLETE=false
      continue
    fi
    if [ "$type" != delete ] && ! az_content "$pr" "$org" "$path" "$src" "$TMP/new"; then
      failure azure "$me" "$scope" content "Source content unavailable or binary: $path"
      DIFF_COMPLETE=false
      continue
    fi
    if diff -u --label "a/${old#/}" --label "b/${path#/}" "$TMP/old" "$TMP/new" >>"$TMP/diff"; then
      status=0
    else
      status=$?
    fi
    if [ "$status" -gt 1 ]; then
      failure azure "$me" "$scope" diff "Diff generation failed: $path"
      DIFF_COMPLETE=false
    fi
  done < <(jq -r '.changeEntries[] | select((.item.gitObjectType // "blob") != "tree") |
    [(.item.path // .originalPath // ""), (.originalPath // .item.path // ""), (.changeType // "edit")] | @tsv' "$TMP/changes.json")
}

az_emit() {
  local pr="$1" org="$2" project="$3" me="$4" assignment_info="$5" repo_url org_name
  az_iteration "$pr" "$org" "$me"
  if [ -n "$SINCE" ] && jq -e --arg since "$SINCE" '.freshness.timestamp != null and .freshness.timestamp < $since' "$TMP/iteration.json" >/dev/null; then
    return
  fi
  if ! az_changes "$pr" "$org" "$me" >"$TMP/changes.json"; then
    failure azure "$me" "$(jr "$pr" '(.repository.id // .repository.name) + "#" + (.pullRequestId|tostring)')" iterations "Iteration revisions unavailable"
    printf '{"changeEntries":[],"sourceCommit":"","baseCommit":"","iteration":null,"complete":false}' >"$TMP/changes.json"
  fi
  az_diff "$pr" "$org" "$me"
  repo_url="$(jr "$pr" '.repository.url // .url // ""')"
  org_name="$(ado_org_name "${org:-$repo_url}")"
  jq -nc --argjson m "$pr" --slurpfile changes "$TMP/changes.json" --slurpfile failures "$ERRORS" --slurpfile iteration "$TMP/iteration.json" \
    --argjson assignment_info "$assignment_info" --arg scope "$org" \
    --arg me "$me" --arg org "$org_name" --arg project "$project" --rawfile diff "$TMP/diff" --argjson diff_complete "$DIFF_COMPLETE" '
    $changes[0] as $c |
    def project_name: $m.repository.project.name // $m.repository.project.id // $project;
    def web_repo: "https://dev.azure.com/" + $org + "/" + (project_name|@uri) + "/_git/" + (($m.repository.name // "")|@uri);
    ($org + "/" + project_name + "/" + ($m.repository.name // "")) as $repo |
    ($assignment_info.assignments | map(.source.organization = ("https://dev.azure.com/" + $org + "/")) | unique) as $assignments |
    [$assignments[] | select(.kind == "team") | .reviewer] as $teams |
    [$failures[] | select(.platform == "azure" and .account == $me and
      (.scope == $scope or .scope == ($scope + "/" + $project) or .scope == (($m.repository.id // $m.repository.name) + "#" + ($m.pullRequestId|tostring))))] as $errors |
    {platform:"azure", repo:$repo,
     number:$m.pullRequestId, title:$m.title, url:(web_repo + "/pullrequest/" + ($m.pullRequestId|tostring)),
     author:($m.createdBy.uniqueName // ""), draft:($m.isDraft // false),
     updatedAt:(if $iteration[0].freshness.source == "iteration.updatedDate" then ($iteration[0].freshness.timestamp // "") else "" end),
     freshness:$iteration[0].freshness,
     files:[$c.changeEntries[] | select((.item.gitObjectType // "blob") != "tree") | (.item.path // .originalPath // "") | sub("^/";"")],
     reviewers:[($m.reviewers[]? | {id:.id,name:(.uniqueName // .displayName // ""), required:(.isRequired // false)})],
     teams:$teams, me:$me, my_teams:$teams,
     assignments:$assignments,
     codeowners:"", base_ref:($m.targetRefName // ""), diff:$diff,
     coverage:(if $diff_complete and $c.complete then "full diff" elif ($diff|length)>0 then "partial diff" else "no diff" end),
     evidence:{version:1,source:{platform:"azure",host:"dev.azure.com",repository:$repo,number:$m.pullRequestId,account:$me,
       baseRevision:$c.baseCommit,headRevision:$c.sourceCommit,iteration:$c.iteration},
       completeness:{files:$c.complete,diff:$diff_complete,
	 assignments:($assignment_info.discoveryComplete and ($assignments|length)>0 and
	   (any($errors[]; .stage == "identity" or .stage == "groups" or .stage == "memberships" or .stage == "search" or .stage == "assignments")|not))},
       failures:$errors},
     clone_url:web_repo, pr_ref:$m.sourceRefName}'
}

fetch_azure() {
  command -v az >/dev/null 2>&1 && az repos --help >/dev/null 2>&1 || { failure azure "" "" dependency "az or its Azure DevOps extension unavailable"; return; }
  local me org scope_project project pr entry identity reviewer_id last_org="not-yet-loaded"
  if ! me="$(az_user 2>"$TMP/provider.err")" || [ -z "$me" ]; then
    failure azure "" "" identity "Authenticated Azure account could not be confirmed"
    return
  fi
  : >"$TMP/azure-prs.jsonl"
  ado_scopes | sort -u >"$TMP/scopes"
  while IFS='|' read -r org scope_project; do
    if [ "$last_org" != "$org" ]; then
      az_identities "$org" "$me"
      last_org="$org"
    fi
    if ! ado_projects "$org" "$scope_project" >"$TMP/projects"; then
      failure azure "$me" "$org" projects "Project discovery failed, was incomplete, or reached its result limit"
      continue
    fi
    while IFS= read -r project; do
      [ -n "$project" ] || [ -z "$scope_project" ] || continue
      while IFS= read -r identity; do
	reviewer_id="$(jr "$identity" '.reviewerId')"
	if ! ado_prs "$org" "$project" "$reviewer_id" >"$TMP/pr-list.json" \
	|| ! jq -e 'type == "array"' "$TMP/pr-list.json" >/dev/null; then
	  failure azure "$me" "$org/$project" search "Review-request search failed for identity $reviewer_id"
	  continue
	fi
	if [ "$(jq length "$TMP/pr-list.json")" -ge "$LIMIT" ]; then
	  failure azure "$me" "$org/$project" search "Result limit reached for identity $reviewer_id; queue coverage is unknown"
	fi
	jq -c --arg org "$org" --arg project "$project" --arg me "$me" --argjson identity "$identity" \
	  --argjson complete "$AZ_ASSIGNMENTS_COMPLETE" '
	  .[] | . as $pr |
	  {org:$org,project:$project,pr:$pr,discoveryComplete:$complete,assignments:[
	    .reviewers[]? | select((.id|type) == "string" and (.id|ascii_downcase) == $identity.reviewerId and
	      (.isRequired == null or (.isRequired|type) == "boolean")) |
	    {account:$me,reviewer:([.uniqueName,.displayName,.id] | map(select(type=="string" and length>0)) | .[0]),kind:$identity.kind,
	     reviewerId:$identity.reviewerId,descriptor:$identity.descriptor,membershipPath:$identity.membershipPath,
	     required:(.isRequired // false),vote:(.vote // null),hasDeclined:(.hasDeclined // null),isReapprove:(.isReapprove // null),
	     source:{organization:$org,queryReviewerId:$identity.reviewerId,field:"pullRequest.reviewers"}}
	  ]}' "$TMP/pr-list.json" >"$TMP/azure-matches.jsonl"
	if jq -se 'any(.[]; (.assignments|length)==0)' "$TMP/azure-matches.jsonl" >/dev/null; then
	  failure azure "$me" "$org/$project" assignments "A search result did not contain the queried reviewer ID $reviewer_id"
	fi
	cat "$TMP/azure-matches.jsonl" >>"$TMP/azure-prs.jsonl"
      done <"$TMP/identities.jsonl"
    done <"$TMP/projects"
  done <"$TMP/scopes"
  jq -sc 'group_by([.pr.repository.url,.pr.repository.id,.pr.pullRequestId])[] |
    .[0] + {discoveryComplete:all(.[]; .discoveryComplete),assignments:([.[].assignments[]] | unique)}' "$TMP/azure-prs.jsonl" >"$TMP/azure-prs"
  while IFS= read -r entry; do
    org="$(jr "$entry" '.org')"; project="$(jr "$entry" '.project')"; pr="$(jr "$entry" '.pr')"
    az_emit "$pr" "$org" "$project" "$me" "$entry" >>"$OUT"
  done <"$TMP/azure-prs"
}

[ "$DO_GH" -eq 1 ] && fetch_github
[ "$DO_AZ" -eq 1 ] && fetch_azure

jq -s --slurpfile failures "$ERRORS" \
  '{prs:.,fetch:{version:1,complete:($failures|length == 0),failures:$failures}}' "$OUT"
[ ! -s "$ERRORS" ] || exit 4

#!/usr/bin/env bash
# Gather assigned GitHub + Azure DevOps PRs and print normalized JSON.
set -euo pipefail

LIMIT=100
MAX_AGE_DAYS=30
WANT_DIFF=1
DO_GH=1
DO_AZ=1
ADO_ORG="${AZURE_DEVOPS_ORG:-}"
ADO_PROJECT="${AZURE_DEVOPS_PROJECT:-}"
ADO_EXTRA_ORGS=()
ADO_EXTRA_PROJECTS=()

warn() { echo "review-queue-fetch: $*" >&2; }
need() { [ "$1" -ge "$2" ] || { warn "$3"; exit 2; }; }
jr() { printf "%s" "$1" | jq -r "$2"; }

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
    --limit) need $# 2 "--limit needs a value"; LIMIT="$2"; shift 2 ;;
    --max-diff) need $# 2 "--max-diff is no longer supported; diffs are never truncated"; warn "--max-diff ignored; diffs are never truncated"; shift 2 ;;
    --max-age-days) need $# 2 "--max-age-days needs a value"; MAX_AGE_DAYS="$2"; shift 2 ;;
    --all-ages) MAX_AGE_DAYS=0; shift ;;
    --no-diff) WANT_DIFF=0; shift ;;
    --github-only) DO_AZ=0; shift ;;
    --azure-only) DO_GH=0; shift ;;
    --ado-org) need $# 2 "--ado-org needs a value"; ADO_ORG="$2"; shift 2 ;;
    --ado-project) need $# 2 "--ado-project needs a value"; ADO_PROJECT="$2"; shift 2 ;;
    --ado-scope) need $# 3 "--ado-scope needs ORG and PROJECT"; add_ado_scope "$2" "$3"; shift 3 ;;
    *) warn "unknown arg $1"; exit 2 ;;
  esac
done

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
trap 'rm -rf "$TMP"' EXIT
: >"$OUT"

gh_as() {
  local user="$1" token active
  shift
  if token="$(gh auth token --hostname github.com --user "$user" 2>/dev/null)"; then
    GH_TOKEN="$token" gh "$@"
    return
  fi
  active="$(gh api user -q .login 2>/dev/null || true)"
  [ "$user" = "$active" ] && gh "$@"
}

gh_accounts() {
  local accounts
  accounts="$(gh auth status --hostname github.com --json hosts 2>/dev/null \
    | jq -r '.hosts["github.com"][]? | select(.state == "success") | .login')" || accounts=""
  [ -n "$accounts" ] && printf "%s\n" "$accounts" || gh api user -q .login 2>/dev/null || true
}

gh_codeowners() {
  local user="$1" repo="$2" path content
  for path in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do
    content="$(gh_as "$user" api "repos/$repo/contents/$path" -q .content 2>/dev/null | base64 -d 2>/dev/null || true)"
    [ -n "$content" ] && { printf "%s" "$content"; return; }
  done
  true
}

gh_emit() {
  local user="$1" repo="$2" num="$3" me="$4" teams="$5" meta co diff="" coverage="no diff"
  meta="$(gh_as "$user" pr view "$num" --repo "$repo" \
    --json title,url,author,isDraft,updatedAt,additions,deletions,files,reviewRequests 2>/dev/null)" || return
  co="$(gh_codeowners "$user" "$repo")"
  if [ "$WANT_DIFF" -eq 1 ]; then
    diff="$(gh_as "$user" pr diff "$num" --repo "$repo" 2>/dev/null || true)"
    [ -n "$diff" ] && coverage="full diff" || coverage="diff unavailable"
  fi
  jq -nc --arg repo "$repo" --argjson num "$num" --arg me "$me" --argjson teams "$teams" \
    --arg co "$co" --arg diff "$diff" --arg coverage "$coverage" --argjson m "$meta" '
    {platform:"github", repo:$repo, number:$num, title:$m.title, url:$m.url,
     author:($m.author.login // ""), draft:$m.isDraft, updatedAt:($m.updatedAt // ""),
     additions:$m.additions, deletions:$m.deletions, files:[($m.files[]?.path)],
     reviewers:[($m.reviewRequests[]? | {name:(.login // .slug // .name // ""), required:false})],
     teams:[($m.reviewRequests[]? | select(.slug) | (($repo | split("/")[0]) + "/" + .slug))],
     me:$me, my_teams:$teams, codeowners:$co, diff:$diff, coverage:$coverage,
     clone_url:("https://github.com/" + $repo + ".git"), pr_ref:("pull/" + ($num|tostring) + "/head")}'
}

fetch_github() {
  command -v gh >/dev/null 2>&1 || { warn "gh unavailable; skipping GitHub"; return; }
  local user me teams repo num reviewer query
  while IFS= read -r user; do
    [ -n "$user" ] || continue
    me="$(gh_as "$user" api user -q .login 2>/dev/null)" || continue
    teams="$(gh_as "$user" api user/teams -q '[.[] | (.organization.login + "/" + .slug)]' 2>/dev/null || echo "[]")"
    for reviewer in @me $(printf "%s" "$teams" | jq -r '.[]?'); do
      query=(--review-requested="$reviewer" --state=open)
      [ -n "$SINCE" ] && query+=(--updated ">=$SINCE")
      while read -r repo num; do
        [ -n "${repo:-}" ] && gh_emit "$user" "$repo" "$num" "$me" "$teams" >>"$OUT"
      done < <(gh_as "$user" search prs "${query[@]}" --limit "$LIMIT" --json repository,number 2>/dev/null \
        | jq -r '.[] | "\(.repository.nameWithOwner) \(.number)"' || true)
    done
  done < <(gh_accounts)
}

az_git() {
  local org="$1" resource="$2"
  shift 2
  local cmd=(az devops invoke --area git --resource "$resource" --api-version 7.1 -o json)
  [ -n "$org" ] && cmd+=(--org "$org")
  "${cmd[@]}" "$@"
}

az_user() {
  local account user
  account="$(az account show --query user.name -o tsv 2>/dev/null || true)"
  user="$(az ad signed-in-user show -o json 2>/dev/null || echo "{}")"
  printf "%s\n" "$(printf "%s" "$user" | jq -r --arg account "$account" '($account|select(length>0)) // .mail // .userPrincipalName // .mailNickname // "me"')"
}

ado_scopes() {
  local i=0
  [ -n "$ADO_ORG$ADO_PROJECT" ] || [ "${#ADO_EXTRA_ORGS[@]}" -gt 0 ] || printf "%s\t%s\n" "" ""
  [ -n "$ADO_ORG$ADO_PROJECT" ] && printf "%s\t%s\n" "$(ado_norm_org "$ADO_ORG")" "$ADO_PROJECT"
  while [ "$i" -lt "${#ADO_EXTRA_ORGS[@]}" ]; do
    printf "%s\t%s\n" "${ADO_EXTRA_ORGS[$i]}" "${ADO_EXTRA_PROJECTS[$i]}"
    i=$((i + 1))
  done
}

ado_projects() {
  local org="$1" project="$2"
  if [ "$project" != "*" ]; then printf "%s\n" "$project"; return; fi
  [ -n "$org" ] || { warn "project '*' requires --ado-org or AZURE_DEVOPS_ORG"; return 1; }
  az devops project list --org "$org" --top 1000 -o json 2>"$TMP/az-projects.err" \
    | jq -r '.value[]?.name' || { warn "az project list failed for $org"; sed -n '1,3p' "$TMP/az-projects.err" >&2; }
}

ado_prs() {
  local org="$1" project="$2" me="$3" cmd=(az repos pr list --status active --top "$LIMIT" --reviewer "$me" --include-links)
  [ -n "$org" ] && cmd+=(--org "$org")
  [ -n "$project" ] && cmd+=(--project "$project")
  "${cmd[@]}" -o json 2>"$TMP/az-prs.err" \
    || { warn "az repos pr list failed for ${org:-configured org} project '${project:-configured project}'"; sed -n '1,3p' "$TMP/az-prs.err" >&2; return 1; }
}

az_changes() {
  local pr="$1" org="$2" repo project pr_id iter src base iterations
  IFS=$'\t' read -r repo project pr_id <<EOF
$(printf "%s" "$pr" | jq -r '[.repository.id // .repository.name // "", .repository.project.name // .repository.project.id // "", .pullRequestId // ""] | @tsv')
EOF
  [ -n "$repo" ] && [ -n "$project" ] && [ -n "$pr_id" ] || return 1
  iterations="$(az_git "$org" pullRequestIterations --route-parameters "project=$project" "repositoryId=$repo" "pullRequestId=$pr_id" 2>/dev/null)" || return 1
  IFS=$'\t' read -r iter src base <<EOF
$(printf "%s" "$iterations" | jq -r 'def xs: if type=="array" then . else .value end; (xs | max_by(.id) // {}) | [.id // "", .sourceRefCommit.commitId // "", .commonRefCommit.commitId // .targetRefCommit.commitId // ""] | @tsv')
EOF
  [ -n "$iter" ] || return 1
  az_git "$org" pullRequestIterationChanges \
    --route-parameters "project=$project" "repositoryId=$repo" "pullRequestId=$pr_id" "iterationId=$iter" \
    --query-parameters '$top=2000' 2>/dev/null \
    | jq --arg source "$src" --arg base "$base" '. + {sourceCommit:$source, baseCommit:$base}'
}

az_content() {
  local pr="$1" org="$2" path="$3" commit="$4" out="$5" repo project
  IFS=$'\t' read -r repo project <<EOF
$(printf "%s" "$pr" | jq -r '[.repository.id // .repository.name // "", .repository.project.name // .repository.project.id // ""] | @tsv')
EOF
  [ -n "$repo" ] && [ -n "$project" ] && [ -n "$path" ] && [ -n "$commit" ] || return 1
  az_git "$org" items --route-parameters "project=$project" "repositoryId=$repo" \
    --query-parameters "path=$path" "versionDescriptor.version=$commit" "versionDescriptor.versionType=commit" "includeContent=true" 2>/dev/null \
    | jq -re 'select(.contentMetadata.isBinary != true) | .content // empty' >"$out"
}

az_diff() {
  local pr="$1" org="$2" changes="$3" src base path old type oldf newf n=0
  [ "$WANT_DIFF" -eq 1 ] || return 0
  IFS=$'\t' read -r src base <<EOF
$(printf "%s" "$changes" | jq -r '[.sourceCommit // "", .baseCommit // ""] | @tsv')
EOF
  [ -n "$src" ] && [ -n "$base" ] || return 1
  while IFS=$'\t' read -r path old type; do
    [ -n "$path" ] || continue
    oldf="$TMP/old-$n"; newf="$TMP/new-$n"; : >"$oldf"; : >"$newf"
    [ "$type" = add ] || az_content "$pr" "$org" "$old" "$base" "$oldf" || echo "Azure content unavailable for base: $old"
    [ "$type" = delete ] || az_content "$pr" "$org" "$path" "$src" "$newf" || echo "Azure content unavailable for source: $path"
    diff -u --label "a/${old#/}" --label "b/${path#/}" "$oldf" "$newf" || true
    n=$((n + 1))
  done < <(printf "%s" "$changes" | jq -r '.changeEntries[]? | select((.item.gitObjectType // "blob") != "tree") | [(.item.path // .originalPath // ""), (.originalPath // .item.path // ""), (.changeType // "edit")] | @tsv')
}

az_emit() {
  local pr="$1" org="$2" project="$3" me="$4" changes="$5" files diff repo_url org_name coverage="no diff"
  files="$(printf "%s" "$changes" | jq -c '[.changeEntries[]? | (.item.path // .originalPath // empty) | sub("^/";"")]' 2>/dev/null || echo "[]")"
  diff="$(az_diff "$pr" "$org" "$changes" 2>/dev/null || true)"
  if [ -n "$diff" ]; then
    case "$diff" in *"Azure content unavailable"*) coverage="partial diff" ;; *) coverage="full diff" ;; esac
  fi
  if [ "$WANT_DIFF" -eq 1 ] && [ -z "$diff" ]; then
    diff="$(printf "%s" "$changes" | jq -r '.changeEntries[]? | "- " + ((.changeType // "change")|tostring) + " " + ((.item.path // .originalPath // "") | sub("^/";""))' 2>/dev/null || true)"
    if [ -n "$diff" ]; then
      diff="Azure DevOps changed files (summary only):"$'\n'"$diff"
      coverage="summary only"
    else
      coverage="diff unavailable"
    fi
  fi
  repo_url="$(jr "$pr" '.repository.url // .url // ""')"
  org_name="$(ado_org_name "${org:-$repo_url}")"
  jq -nc --argjson m "$pr" --argjson files "${files:-[]}" --arg me "$me" --arg org "$org_name" --arg project "$project" --arg diff "$diff" --arg coverage "$coverage" '
    def project_name: if $project == "" then ($m.repository.project.name // $m.repository.project.id // "") else $project end;
    def web_repo: "https://dev.azure.com/" + $org + "/" + (project_name|@uri) + "/_git/" + (($m.repository.name // "")|@uri);
    {platform:"azure", repo:($org + "/" + project_name + "/" + ($m.repository.name // "")),
     number:$m.pullRequestId, title:$m.title, url:(web_repo + "/pullrequest/" + ($m.pullRequestId|tostring)),
     author:($m.createdBy.uniqueName // ""), draft:($m.isDraft // false),
     updatedAt:($m.lastMergeSourceCommit.committer.date // $m.lastMergeCommit.committer.date // $m.creationDate // ""),
     additions:0, deletions:0, files:$files,
     reviewers:[($m.reviewers[]? | {name:(.uniqueName // .displayName // ""), required:(.isRequired // false)})],
     teams:[], me:$me, my_teams:[], codeowners:"", diff:$diff, coverage:$coverage, clone_url:web_repo, pr_ref:$m.sourceRefName}'
}

fetch_azure() {
  command -v az >/dev/null 2>&1 && az repos --help >/dev/null 2>&1 || { warn "az unavailable; skipping Azure DevOps"; return; }
  local me org scope_project project prs pr changes
  me="$(az_user)"
  while IFS=$'\t' read -r org scope_project; do
    while IFS= read -r project; do
      [ -n "$project" ] || [ -z "$scope_project" ] || continue
      prs="$(ado_prs "$org" "$project" "$me")" || continue
      printf "%s" "$prs" | jq -c --arg since "$SINCE" '.[] | select($since == "" or ((.lastMergeSourceCommit.committer.date // .lastMergeCommit.committer.date // .creationDate // "") >= $since))' |
        while IFS= read -r pr; do
          changes="$(az_changes "$pr" "$org" || echo "{}")"
          az_emit "$pr" "$org" "$project" "$me" "$changes" >>"$OUT" || warn "failed to normalize Azure PR"
        done
    done < <(ado_projects "$org" "$scope_project")
  done < <(ado_scopes)
}

[ "$DO_GH" -eq 1 ] && fetch_github
[ "$DO_AZ" -eq 1 ] && fetch_azure

if [ -s "$OUT" ]; then
  jq -s 'unique_by(.url)' "$OUT"
else
  echo "[]"
fi

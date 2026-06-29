#!/usr/bin/env bash
# review-queue-fetch.sh — gather PRs I'm asked to review across GitHub + Azure DevOps
# and print one normalized JSON array on stdout. Deterministic, no AIU, read-only.
#
# Each record fed to review-queue.cwf.py:
#   { platform, repo, number, title, url, author, draft, additions, deletions,
#     files[], reviewers[{name,required}], teams[], me, my_teams[], codeowners, diff }
#
# A platform with a missing/unauthed CLI is skipped (logged to stderr), not fatal,
# so the harness can review whichever side is reachable. gh is required; az optional.
#
# Usage: review-queue-fetch.sh [--limit N] [--max-diff BYTES] [--no-diff]
#        [--github-only|--azure-only] [--ado-org URL --ado-project NAME]
set -euo pipefail

LIMIT=30
MAX_DIFF=12000
WANT_DIFF=1
DO_GH=1
DO_AZ=1
ADO_ORG="${AZURE_DEVOPS_ORG:-}"
ADO_PROJECT="${AZURE_DEVOPS_PROJECT:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2;;
    --max-diff) MAX_DIFF="$2"; shift 2;;
    --no-diff) WANT_DIFF=0; shift;;
    --github-only) DO_AZ=0; shift;;
    --azure-only) DO_GH=0; shift;;
    --ado-org) ADO_ORG="$2"; shift 2;;
    --ado-project) ADO_PROJECT="$2"; shift 2;;
    *) echo "review-queue-fetch: unknown arg $1" >&2; exit 2;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "review-queue-fetch: jq is required" >&2; exit 3; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "[]" >"$TMP/gh.json"
echo "[]" >"$TMP/az.json"

# ---- GitHub ---------------------------------------------------------------
if [ "$DO_GH" -eq 1 ] && command -v gh >/dev/null 2>&1 && ME="$(gh api user -q .login 2>/dev/null)"; then
  MY_TEAMS="$(gh api user/teams -q '[.[] | (.organization.login + "/" + .slug)]' 2>/dev/null || echo "[]")"
  # PRs where I'm a requested reviewer — directly or via a team I belong to.
  gh search prs --review-requested=@me --state=open --limit "$LIMIT" \
    --json repository,number 2>/dev/null \
    | jq -r '.[] | "\(.repository.nameWithOwner) \(.number)"' >"$TMP/prs.txt" || : >"$TMP/prs.txt"
  while read -r REPO NUM; do
    [ -n "${REPO:-}" ] || continue
    META="$(gh pr view "$NUM" --repo "$REPO" \
      --json title,url,author,isDraft,additions,deletions,files,reviewRequests 2>/dev/null)" || continue
    CO=""
    for p in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do
      CO="$(gh api "repos/$REPO/contents/$p" -q .content 2>/dev/null | base64 -d 2>/dev/null || true)"
      [ -n "$CO" ] && break
    done
    DIFF=""
    [ "$WANT_DIFF" -eq 1 ] && DIFF="$(gh pr diff "$NUM" --repo "$REPO" 2>/dev/null | head -c "$MAX_DIFF" || true)"
    jq -n --arg repo "$REPO" --argjson num "$NUM" --arg me "$ME" \
      --argjson teams "$MY_TEAMS" --arg co "$CO" --arg diff "$DIFF" --argjson m "$META" \
      '{platform:"github", repo:$repo, number:$num, title:$m.title, url:$m.url,
        author:($m.author.login // ""), draft:$m.isDraft, additions:$m.additions,
        deletions:$m.deletions, files:[($m.files[]?.path)],
        reviewers:[($m.reviewRequests[]? | {name:(.login // .slug // .name // ""), required:false})],
        teams:[($m.reviewRequests[]? | select(.slug) | .slug)],
        me:$me, my_teams:$teams, codeowners:$co, diff:$diff,
        clone_url:("https://github.com/" + $repo + ".git"),
        pr_ref:("pull/" + ($num|tostring) + "/head")}'
  done <"$TMP/prs.txt" | jq -s '.' >"$TMP/gh.json" || echo "[]" >"$TMP/gh.json"
else
  [ "$DO_GH" -eq 1 ] && echo "review-queue-fetch: gh unavailable/unauthed; skipping GitHub" >&2
fi

# ---- Azure DevOps ---------------------------------------------------------
if [ "$DO_AZ" -eq 1 ] && command -v az >/dev/null 2>&1 && az repos --help >/dev/null 2>&1; then
  AZ_ME="$(az ad signed-in-user show --query mailNickname -o tsv 2>/dev/null || echo me)"
  ORG_ARG=(); [ -n "$ADO_ORG" ] && ORG_ARG=(--org "$ADO_ORG")
  PROJ_ARG=(); [ -n "$ADO_PROJECT" ] && PROJ_ARG=(--project "$ADO_PROJECT")
  az repos pr list "${ORG_ARG[@]}" "${PROJ_ARG[@]}" --status active --top "$LIMIT" \
    --query "[?reviewers[?contains(uniqueName,'$AZ_ME') || displayName=='$AZ_ME']]" 2>/dev/null \
    | jq --arg me "$AZ_ME" '[.[] | {
        platform:"azure", repo:(.repository.name // ""), number:.pullRequestId,
        title:.title, url:(.repository.webUrl // ""), author:(.createdBy.uniqueName // ""),
        draft:(.isDraft // false), additions:0, deletions:0, files:[],
        reviewers:[(.reviewers[]? | {name:(.uniqueName // .displayName // ""), required:(.isRequired // false)})],
        teams:[], me:$me, my_teams:[], codeowners:"", diff:"",
        clone_url:(.repository.remoteUrl // ""), pr_ref:.sourceRefName }]' >"$TMP/az.json" 2>/dev/null \
    || echo "[]" >"$TMP/az.json"
else
  [ "$DO_AZ" -eq 1 ] && echo "review-queue-fetch: az unavailable; skipping Azure DevOps" >&2
fi

jq -s 'add' "$TMP/gh.json" "$TMP/az.json"

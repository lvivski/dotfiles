#!/usr/bin/env bash
set -euo pipefail

case "${BASH_SOURCE[0]}" in
  */*) script_dir="${BASH_SOURCE[0]%/*}" ;;
  *) script_dir="." ;;
esac
script_dir="$(cd "$script_dir" && pwd)"
script="$script_dir/review-queue-fetch.sh"
temp_dir="$(mktemp -d)"
stdout_file="$temp_dir/stdout"
stderr_file="$temp_dir/stderr"
trap 'rm -f -- "$stdout_file" "$stderr_file"; rmdir -- "$temp_dir"' EXIT

invocation=""
stdout=""
stderr=""

fail() {
  printf 'not ok - %s\n' "$invocation"
  printf '%s\nstdout:\n%s\nstderr:\n%s\n' "$*" "$stdout" "$stderr" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "Expected output to contain '$2'." ;;
  esac
}

expect() {
  local expected_status="$1" expected_error="$2" status
  shift 2
  invocation="${*:-default options}"
  if (cd "$temp_dir" && env -i PATH="" "$BASH" "$script" "$@") \
      </dev/null >"$stdout_file" 2>"$stderr_file"; then
    status=0
  else
    status=$?
  fi
  stdout="$(<"$stdout_file")"
  stderr="$(<"$stderr_file")"
  [ "$status" -eq "$expected_status" ] || fail "Expected exit $expected_status; got $status."
  if [ -z "$expected_error" ]; then
    [ -z "$stderr" ] || fail "Expected empty stderr."
  else
    assert_contains "$stderr" "$expected_error"
  fi
  if [ "$expected_status" -ne 0 ]; then
    [ -z "$stdout" ] || fail "Expected empty stdout."
  fi
}

printf '1..6\n'

for flag in --help -h; do
  expect 0 "" "$flag"
  case "$stdout" in
    "Usage: review-queue-fetch.sh"*) ;;
    *) fail "Expected help to start with usage." ;;
  esac
  for text in "JSON array on stdout" "--ado-scope ORG PROJ" "--max-age-days N" "jq is missing"; do
    assert_contains "$stdout" "$text"
  done
done
printf 'ok 1 - help works without fetch tools or authentication\n'

oversized=99999999999999999999999999999999999999999999999999
for value in "" 0 -1 1.5 abc "$oversized"; do
  expect 2 "--limit must be a positive integer" --limit "$value"
done
for value in "" -1 1.5 abc "$oversized"; do
  expect 2 "--max-age-days must be a non-negative integer" --max-age-days "$value"
done
printf 'ok 2 - invalid numeric options fail before fetching\n'

expect 2 "mutually exclusive" --github-only --azure-only
expect 2 "mutually exclusive" --azure-only --github-only
printf 'ok 3 - conflicting platform options fail explicitly\n'

for flag in --limit --max-age-days --max-diff --ado-org --ado-project --unknown; do
  expect 2 "Use --help for usage" "$flag"
  assert_contains "$stderr" "$flag"
done
expect 2 "Use --help for usage" --ado-scope example
assert_contains "$stderr" "--ado-scope"
printf 'ok 4 - missing values and unknown options explain the error\n'

expect 3 "jq is required"
expect 3 "jq is required" --limit 1 --max-age-days 0
expect 3 "jq is required" --limit 001 --max-age-days 030
expect 3 "jq is required" --all-ages --github-only
expect 3 "jq is required" --azure-only --ado-org example --ado-project platform
expect 3 "jq is required" --ado-scope example platform --ado-scope second other --no-diff
printf 'ok 5 - valid options reach the dependency check without fetching\n'

expect 3 "--max-diff ignored; diffs are never truncated" --max-diff 10
assert_contains "$stderr" "jq is required"
printf 'ok 6 - deprecated diff limits remain ignored\n'

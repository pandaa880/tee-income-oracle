#!/usr/bin/env bash
# Keeps one open `monitor` issue in step with the devnet monitor: opens it when a run isn't ok
# (reopening one closed in the last 24 h, so a flapping check doesn't pile up issues), edits it on
# later runs (a comment, which notifies, only when the status changes) and closes it with the
# healthy report once everything is ok again.
# Usage: monitor-issue.sh <dir holding report.md and status>. Needs GH_TOKEN and the Actions env.
set -euo pipefail

dir="$1"
report="$dir/report.md"
status="$(cat "$dir/status" 2>/dev/null || echo fail)"
if [ ! -s "$report" ]; then
  mkdir -p "$dir"
  printf '**Devnet demo: FAIL**: the monitor stopped before writing a report.\n' > "$report"
fi
printf '\n[Run log](%s/%s/actions/runs/%s)\n' "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID" >> "$report"
cat "$report" >> "$GITHUB_STEP_SUMMARY"

gh label create monitor --color B60205 --description "Devnet demo monitor" --force > /dev/null
open="$(gh issue list --label monitor --state open --json number --jq '.[0].number // empty')"
title="Devnet demo monitor: $(printf '%s' "$status" | tr '[:lower:]' '[:upper:]')"

if [ "$status" = ok ]; then
  if [ -n "$open" ]; then
    gh issue comment "$open" --body-file "$report"
    gh issue close "$open" --reason completed
  fi
  exit 0
fi

if [ -z "$open" ]; then
  recent="$(gh issue list --label monitor --state closed --limit 1 --json number,closedAt \
    --jq '.[] | select(now - (.closedAt | fromdateiso8601) < 86400) | .number')"
  if [ -n "$recent" ]; then
    gh issue reopen "$recent"
    gh issue edit "$recent" --title "$title" --body-file "$report"
    gh issue comment "$recent" --body-file "$report"
  else
    gh issue create --title "$title" --label monitor --body-file "$report"
  fi
else
  previous="$(gh issue view "$open" --json title --jq .title)"
  gh issue edit "$open" --title "$title" --body-file "$report"
  if [ "$previous" != "$title" ]; then
    gh issue comment "$open" --body-file "$report"
  fi
fi

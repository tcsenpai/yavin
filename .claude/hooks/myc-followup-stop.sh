#!/usr/bin/env bash
# Mycelium Stop hook — enforce end-of-task follow-up check.
#
# No-op unless the current project is a mycelium project (AGENTS.md
# carries the myc marker). When open follow-ups exist, it feeds them
# back to the agent so they get surfaced to the user instead of relying
# on the agent remembering the AGENTS.md rule.
#
# Installed globally (~/.claude/) by install-hook.sh, and/or project-locally
# (.claude/) by `myc init` / `myc hooks install`. The self-dedup guard below
# ensures it runs at most once per stop even when BOTH copies are wired.

# Claude Code passes the hook payload as JSON on stdin.
input=$(cat)

# Loop guard: if this Stop was itself triggered by a Stop hook, bail —
# otherwise blocking would re-fire this hook forever.
if echo "$input" | jq -e '.stop_hook_active == true' >/dev/null 2>&1; then
  exit 0
fi

# Self-dedup: a global and a project-local copy can both be wired into
# hooks.Stop. Without this, the check would fire twice per stop. Key a
# short-lived marker on the stop's session_id (falling back to a hash of
# transcript_path, then the cwd) so only the FIRST invocation proceeds.
dedup_key=$(echo "$input" | jq -r '.session_id // .transcript_path // empty' 2>/dev/null)
[ -n "$dedup_key" ] || dedup_key="$PWD"
dedup_hash=$(printf '%s' "$dedup_key" | cksum | cut -d' ' -f1)
marker="${TMPDIR:-/tmp}/.myc-fu-stop-${dedup_hash}"
if [ -f "$marker" ]; then
  # Fresh marker (<10s) means a sibling copy already handled this stop.
  now=$(date +%s)
  # On a platform where neither stat form works, mtime is empty; treat that as
  # "fresh" so we dedup (a marker file only exists if a sibling just ran). The
  # opposite default (mtime=0 -> now-0 huge -> never dedup) made both the global
  # and project-local hooks fire the FOLLOW-UP CHECK on every stop.
  mtime=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker" 2>/dev/null)
  if [ -z "$mtime" ] || [ $((now - mtime)) -lt 10 ]; then
    exit 0
  fi
fi
touch "$marker" 2>/dev/null || true

# Gate 1: mycelium project? Marker is version-independent (myc:agents-start v=N).
grep -q "myc:agents-start" AGENTS.md 2>/dev/null || exit 0

# Gate 1.5: snooze active? `myc followup snooze` writes a decrementing counter
# to <project>/.mycelium/.followup-snooze. `myc` resolves the project by walking
# up from its cwd to the first ancestor holding .mycelium/mycelium.db, so the
# hook MUST do the same — otherwise a snooze written from a subdir lands in a
# .mycelium/ the hook never reads, and the check re-nags every stop despite the
# snooze (the "snooze doesn't stick" bug). Walk up here to match get_db_path().
snooze_file=""
d="$PWD"
while [ -n "$d" ]; do
  if [ -f "$d/.mycelium/mycelium.db" ]; then
    snooze_file="$d/.mycelium/.followup-snooze"
    break
  fi
  [ "$d" = "/" ] && break
  d=$(dirname "$d")
done
if [ -n "$snooze_file" ] && [ -f "$snooze_file" ]; then
  n=$(cat "$snooze_file" 2>/dev/null | tr -dc '0-9')
  if [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null; then
    left=$((n - 1))
    if [ "$left" -gt 0 ]; then
      printf '%s' "$left" > "$snooze_file"
    else
      rm -f "$snooze_file"
    fi
    exit 0
  fi
fi

# Gate 2: myc binary available?
command -v myc >/dev/null 2>&1 || exit 0

# jq is required to parse myc JSON; degrade silently if missing.
command -v jq >/dev/null 2>&1 || exit 0

# Count OPEN follow-ups only. Per the project rule, `in_progress` items are
# already being worked and don't need an end-of-task decision — so they must
# NOT trigger the block (matches the `myc task close` close-hint behavior).
counts=$(myc followup count --format json 2>/dev/null) || exit 0
open=$(echo "$counts" | jq '(.open // 0)')
[ "${open:-0}" -gt 0 ] 2>/dev/null || exit 0

# Build a bullet list of the OPEN items for the reminder.
items=$(myc followup list --status open --format json 2>/dev/null \
  | jq -r '.[] | "  - [\(.id)] \(.title // "untitled"): \(.body)"')

# Emit Stop-hook JSON. `block` + `reason` is how a Stop hook feeds text
# back to the model; the guard above ensures it fires at most once.
jq -n --arg open "$open" --arg items "$items" '{
  decision: "block",
  reason: ("MYCELIUM FOLLOW-UP CHECK: " + $open + " open follow-up(s) exist. " +
    "Per project rule, surface them to the user before wrapping — never process " +
    "silently. Ask whether to handle them now or leave for later.\n\n" +
    "Open follow-ups:\n" + $items)
}'

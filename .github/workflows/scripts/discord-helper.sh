# shellcheck shell=bash
# Discord webhook call helper with retry/backoff.
#
# Sourced by .github/workflows/discord-{pr,issues,discussions}.yml. Each
# workflow performs actions/checkout (default branch / PR head), then:
#
#   source "${GITHUB_WORKSPACE}/.github/workflows/scripts/discord-helper.sh"
#   PATCH_BODY=$(discord_curl -X PATCH ...) || true
#   PATCH_STATUS=$(cat "$DISCORD_STATUS_FILE")
#
# Discord webhooks return 429 (with Retry-After) and transient 5xx during
# incidents. Without retry any blip aborts the job, blocking the calling
# workflow's checks queue. discord_curl wraps curl so 429/5xx are retried;
# non-429 4xx are returned to the caller unchanged.
#
# Non-idempotent callers (POST that creates a message) should pass
# --no-retry-5xx as the first argument. That restricts retries to 429
# (which guarantees the request was rejected) and surfaces 5xx and
# network failures to the caller, avoiding duplicate Discord messages
# on uncertain delivery. The flag name only mentions 5xx, but it also
# disables the no-response-received retry path (000/empty status), which
# is the correct at-most-once choice for POST.
#
#   CREATE_BODY=$(discord_curl --no-retry-5xx -X POST \
#                  -H 'Content-Type: application/json' -d "$payload" \
#                  "${DISCORD_WEBHOOK_URL}?wait=true") || true
#
# Status sink: callers invoke discord_curl via $(...), which runs in a
# subshell, so shell variables set inside don't propagate back. The HTTP
# status is published through DISCORD_STATUS_FILE (a step-owned temp file)
# so callers can read it after the substitution returns.

DISCORD_STATUS_FILE=$(mktemp)
trap 'rm -f "$DISCORD_STATUS_FILE"' EXIT

discord_curl() {
  local max_attempts=5 attempt=1 backoff=1 retry_5xx=1
  if [ "${1:-}" = "--no-retry-5xx" ]; then retry_5xx=0; shift; fi
  local headers response status body retry_after
  headers=$(mktemp); trap 'rm -f "$headers"' RETURN
  while [ $attempt -le $max_attempts ]; do
    : > "$headers"
    response=$(curl -sS --connect-timeout 10 --max-time 60 -D "$headers" -w "\n%{http_code}" "$@") || true
    status=$(printf '%s' "$response" | tail -n 1)
    body=$(printf '%s' "$response" | sed '$d')

    if [ -n "$status" ] && [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
      printf '%s' "$status" > "$DISCORD_STATUS_FILE"
      printf '%s' "$body"
      return 0
    fi

    if [ "$status" = "429" ]; then
      retry_after=$(awk 'tolower($1)=="retry-after:"{print $2}' "$headers" | tr -d '\r' | head -n1)
      retry_after=${retry_after:-$backoff}
      retry_after=$(awk -v n="$retry_after" 'BEGIN{ x=n+0; printf "%d", (x<1?1:(x==int(x)?x:int(x)+1)) }')
      [ "$retry_after" -gt 60 ] && retry_after=60
      echo "::warning::Discord 429 (rate limited); sleeping ${retry_after}s before retry $((attempt+1))/${max_attempts}" >&2
      sleep "$retry_after"
    elif [ -n "$status" ] && [ "$status" -ge 500 ] && [ "$retry_5xx" -eq 1 ]; then
      echo "::warning::Discord ${status} (transient); sleeping ${backoff}s before retry $((attempt+1))/${max_attempts}" >&2
      sleep "$backoff"
      backoff=$((backoff * 2)); [ "$backoff" -gt 30 ] && backoff=30
    elif { [ -z "$status" ] || [ "$status" = "000" ]; } && [ "$retry_5xx" -eq 1 ]; then
      echo "::warning::Discord call failed (no HTTP response); sleeping ${backoff}s before retry $((attempt+1))/${max_attempts}" >&2
      sleep "$backoff"
      backoff=$((backoff * 2)); [ "$backoff" -gt 30 ] && backoff=30
    else
      printf '%s' "$status" > "$DISCORD_STATUS_FILE"
      printf '%s' "$body"
      return 1
    fi
    attempt=$((attempt + 1))
  done
  printf '%s' "${status:-000}" > "$DISCORD_STATUS_FILE"
  printf '%s' "$body"
  return 1
}

# ── Discord sync marker contract ─────────────────────────────────────────
# The notifier stores the linked Discord message ID in a GitHub comment so
# follow-up events PATCH the existing embed instead of posting a duplicate.
# All three notifier workflows (pr/issues/discussions) go through the helpers
# below — change the marker format here only.

# jq/PCRE pattern matching the marker anywhere in a comment body. Pass to jq
# via --arg, e.g.  jq --arg re "$DISCORD_MARKER_PATTERN" '... test($re) ...'.
# Unanchored so it still matches once wrapped in <details>, staying
# backward-compatible with legacy bare-marker comments.
# shellcheck disable=SC2034  # consumed by the sourcing workflows, not here
DISCORD_MARKER_PATTERN='<!-- discord-msg-id:[0-9]+ -->'

# render_discord_marker <msg_id> — emit the GitHub comment body that stores
# <msg_id>. Wrapped in <details> so it renders as a collapsible note instead
# of a blank "No description provided" comment.
render_discord_marker() {
  printf '%s\n' \
    '<details>' \
    '<summary>🤖 Internal: Discord sync marker</summary>' \
    '' \
    'Auto-managed by the Discord notification workflow. Stores the linked Discord message ID. Do not edit or delete.' \
    '' \
    "<!-- discord-msg-id:${1} -->" \
    '</details>'
}

# extract_discord_marker — read a comment body (or marker line) on stdin and
# print the stored Discord message ID, or nothing if absent.
extract_discord_marker() {
  grep -oE 'discord-msg-id:[0-9]+' | cut -d':' -f2 | head -n1
}

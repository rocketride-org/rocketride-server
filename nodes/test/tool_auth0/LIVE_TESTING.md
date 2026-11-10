# Auth0 live verification

Status: **partial**. The read-only tools and an OpenRouter chat pipeline were
exercised against the user-designated development tenant. Results and remaining
checks are recorded below. No live writes were performed.

Use only a user-designated non-production Auth0 tenant, a designated test user,
and credentials supplied through RocketRide's secure node configuration. Keep
client secrets, access tokens, user identifiers, email addresses, IP addresses,
raw API responses, and log contents out of test output and committed evidence.
Keep these checks separate from the mocked CI tests. A running RocketRide engine
with this node installed and the test tenant configuration is required.

## Read-only checks

1. Configure the node with the authorized read-only M2M application and leave
   writes disabled. Confirm the tenant and test user are the designated test
   resources. Do not put credentials in command lines or chat.
2. Call `search_users` for the test user's known email, then repeat with a
   different letter case. Confirm the intended account appears in both results.
   Record pass/fail only; search-v3 is eventually consistent, so record an
   inconclusive result if the account is not indexed yet.
3. Call `get_user` using the designated test user's ID and record whether the
   administrative `blocked` value is present and valid, without recording it
   alongside an identifying value.
4. Call `get_user_logs` for that user. Check the result limit and newest-first
   order, then use one returned log ID to call `get_log_event`. If there is no
   existing event, mark the individual-event check blocked; do not create login
   events without separate authorization.
5. Call `get_user_blocks`; on a designated user known to have no brute-force
   blocks, record whether Auth0 returns an empty block list. Confirm this state
   is separate from the administrative block reported by `get_user`.
6. Verify token reuse by observing only the number of OAuth token requests for
   repeated reads within the token's lifetime. Do not log the token, request
   body, headers, or raw response. Record the count and timeframe only.
7. To establish the minimum `get_user_logs` scope, repeat with a separately
   configured read-only M2M application whose granted Management API scopes are
   known: first test `read:logs_users` without `read:logs`; if unavailable,
   report that check as blocked. Test `read:logs` separately if necessary.
   Other read operations require their own scopes; do not infer the minimum
   user-log scope from a token that has both permissions.

## Live write: unavailable

The node does not expose `unblock_user` and denies unblock requests even when
write credentials are configured. It cannot perform a live write until an
independent human authorization mechanism is supported. Do not make a DELETE
as part of these read-only checks.

## Sanitized evidence

| Check | Result | Notes without secrets or identifiers |
| --- | --- | --- |
| Authorized dedicated test tenant and test user | Pass | User confirmed tenant, users and intended scopes. |
| Read token acquisition and reuse | Pass | One token request for three direct client reads in under one minute. |
| Exact-email and mixed-case search | Pass | Tool searches passed for three users; direct client searches with both casings returned the same user. |
| User profile and administrative block state | Pass | Read for all three designated users. |
| Recent user logs and individual event | Pass | Both tools succeeded; a direct client read also confirmed page limit and order. |
| Brute-force block state and no-block response | Pass | No blocks returned for the three designated users. |
| Minimum user-log scope | Not run | A separately scoped read-only application is needed. |
| Unblock | Not run | Node writes are disabled pending independent human authorization. |

The OpenRouter chat pipeline returned an answer consistent with the direct
read-only result. The agent's individual tool calls were not independently
traced, so this does not establish a complete agent tool-call trace.

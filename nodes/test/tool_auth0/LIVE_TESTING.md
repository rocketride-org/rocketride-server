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

## Live write: explicit approval required

Do not enable writes or make a DELETE during the read-only checks. Before any
write, identify the exact dedicated tenant and test user, the observed pre-write
administrative and brute-force states, and the write application. Request the
user's explicit approval for each planned action:

* Calling `unblock_user` on the designated account when a brute-force block is
  present can clear its brute-force protection records. Check the administrative
  block before and after and record only whether it changed.
* Calling `unblock_user` with no blocks exercises the node's no-op path; the
  current implementation does **not** send a DELETE in that case. Verifying
  Auth0's response to a DELETE when no block exists is a separate live write and
  requires explicit approval for that direct request as well.

Do not create a block, change the administrative block, or retry an ambiguous
write without separate authorization. A precheck and DELETE are not atomic, so
record the observed state and outcome without asserting which record changed.

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
| Approved unblock with existing block | Not run | Requires explicit approval |
| Node no-op with no blocks | Not run | Requires explicit approval |
| Auth0 DELETE with no blocks | Not run | Separate explicit approval required |
| Administrative state unchanged after approved write | Not run | |

The OpenRouter chat pipeline returned an answer consistent with the direct
read-only result. The agent's individual tool calls were not independently
traced, so this does not establish a complete agent tool-call trace.

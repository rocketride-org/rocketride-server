# functions

The Supabase Edge Functions service of the `supabase` node: one agent tool that calls an Edge Function deployed in your Supabase project and returns its answer. Pick it when an agent should run custom server code you already wrote for your project.

## About Supabase

Supabase is a hosted backend platform built on PostgreSQL. Edge Functions are small TypeScript programs that run on Supabase's servers close to your users. Each one is reached over HTTPS at your project URL under `/functions/v1/<name>`.

## What it does

The service has no data lanes; it is used only as an agent tool. `invoke_function` sends one HTTP request to a deployed Edge Function with the project's secret key, then returns the HTTP status and the response body. It connects with the Project URL and a secret key. Use it to run project-specific logic; to read or change data directly, the Database or other Supabase services are the better fit.

## As a tool

Tool names are the bare function names below; an agent sees each one as `<component-id>.<function>`. Messages from the node name a function `supabase_functions.<function>`, for example `supabase_functions.invoke_function`. A call above the node's **Access level** is refused with a message naming the level to set.

| Function | Description |
|---|---|
| `invoke_function` | Call an Edge Function (`name`, optional `body`, optional `method`, default POST, optional `headers`). Returns `name`, `status`, `ok`, `content_type`, `body`, `body_bytes`, `truncated`, and `note` when the body was cut or not returned. Needs `write`. |

`name` is the function's slug as shown under Edge Functions in the dashboard (a letter, then letters, digits, `_` or `-`). `method` is one of `POST`, `GET`, `PUT`, `PATCH`, `DELETE`. A `body` that is an object, array, number or boolean is sent as JSON; a string is sent as `text/plain`. GET requests cannot have a body.

`headers` is an object of extra request headers, at most 20. The node always sends the secret key itself as `apikey` and `Authorization: Bearer`; an agent cannot set `Authorization`, `apikey`, `Host`, `Cookie`, `Content-Length`, `Transfer-Encoding` or `Connection`, and a call that tries is refused.

The answer:

- `status` and `ok`: the function's HTTP status, and whether it is 2xx. A function's own error (any 4xx or 5xx, including its own 401, except the two gateway answers below) is returned with `ok: false`, not raised, so the agent can read the error body.
- `body`: parsed JSON, or text. It is `null` when the function returned no body, or returned binary content such as an image; then `note` says so.
- `body_bytes`: the size of the body in bytes, as the function sent it. When it is above **Max response size**, `truncated` is `true` and `body` holds the first part as text; if the function sent no `Content-Length`, `body_bytes` is then absent.
- If the configured secret key appears anywhere in the answer, it is replaced with `***`.

Two answers of the Edge Functions gateway are raised as errors instead: its HTTP 401 (a body with an `UNAUTHORIZED_...` code, or exactly `{"msg": "Invalid JWT"}` from older gateways), which says the secret key was refused and how to fix it (see Notes), and its 404 (code `NOT_FOUND`) for a function that is not deployed, which names the function.

## Configuration

Paste the **Project URL** and a **Secret key** and set **Access level** to `write`; the other fields have working defaults.

### Access level

`invoke_function` needs `write`, because a function can change data. At the default `read` the node offers the agent no tools: `invoke_function` is not listed, and a call is refused. This is on purpose, so a new node cannot run functions until someone chooses to allow it. Set `write` to turn it on. The canvas tile says "Tools need write or admin", and a node started at `read` writes one warning to the job log saying it offers no tools. `admin` allows it too.

### Limits

- **Timeout (s)** (default 60, 1 to 400): how long one call may take. Supabase stops a function at its own wall-clock limit, which depends on the plan.
- **Max response size (KB)** (default 256, 1 to 10240): the largest body returned to the agent. The answer is streamed and reading stops at this size, so a larger body is never held in memory.
- **Max request size (KB)** (default 1024, 1 to 10240): the largest `body` an agent may send. A larger one is refused before the call.

## Authentication

Use a secret key (`sb_secret_...`) from Project Settings -> API Keys. Publishable and anon keys are refused at start-up. The function receives the secret key in its `apikey` and `Authorization` headers.

## Notes

### Functions with "Verify JWT" on

The new `sb_secret_` keys are not JWTs. A function with JWT verification on (the default when it is deployed) refuses them with HTTP 401, and `invoke_function` then fails with a message that says so. For each function the agent should call, either:

- turn JWT verification off for that function (its **Verify JWT** setting in the dashboard, `verify_jwt = false` under `[functions.<name>]` in `supabase/config.toml`, or `supabase functions deploy <name> --no-verify-jwt`), and check the `apikey` header inside the function instead; or
- use a different key the function accepts.

Turning the check off makes the function callable by anyone who knows its URL, so the function must do its own check.

## Upstream docs

- [Edge Functions](https://supabase.com/docs/guides/functions)
- [Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)
- [Function configuration (verify_jwt)](https://supabase.com/docs/guides/functions/function-configuration)
- [API keys](https://supabase.com/docs/guides/api/api-keys)

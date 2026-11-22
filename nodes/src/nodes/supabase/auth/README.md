# auth

The Supabase Auth service: agent tools that manage a Supabase project's users and check who a signed-in user is. Pick it when an agent has to look up, create, invite, change or remove users of an app built on Supabase.

## About Supabase

Supabase is a hosted backend platform built on PostgreSQL. Supabase Auth is its user system: it stores an app's users, signs them in with passwords, magic links or social providers, and gives each signed-in user an access token (a JWT) that the app sends with its requests.

## What it does

This service is a tool node only: attach it to an agent and the agent can call the functions below. No data flows through lanes. It talks to the project's Auth admin API with the project URL and a secret key, so it acts as the project owner, not as a user. The **Access level** setting decides which functions may run. Results never contain passwords, password hashes, confirmation or recovery tokens.

## As a tool

Tool names are the bare function names below; an agent sees each one as `<component-id>.<function>`. Messages from the node name a function `supabase_auth.<function>`, for example `supabase_auth.get_user`. A call above the node's **Access level** is refused with a message naming the level to set.

| Function | Description |
|---|---|
| `list_users` | One page of users. Arguments: `page` (default 1), `per_page` (default and maximum: **Users per page**, 50 unless changed; larger values are lowered). Returns `users` (id, email, phone, created_at, last_sign_in_at, email_confirmed_at, banned_until), `page`, `per_page`, `count`, and `more_may_exist` (true when the page is full). Needs `read`. |
| `get_user` | One user by `user_id` (a UUID). Returns id, email, phone, role, created_at, updated_at, last_sign_in_at, email_confirmed_at, phone_confirmed_at, confirmed_at, invited_at, banned_until, deleted_at, is_anonymous, user_metadata, app_metadata. Needs `read`. |
| `verify_user` | Checks a user's login token. Argument: `access_token` (the user's JWT; a leading `Bearer ` is allowed). Returns `{"valid": true, "user": {"id", "email"}}`, or `{"valid": false, "reason"}` when Supabase refuses the token (invalid, expired, revoked, or its user is gone). Other failures raise an error instead: network and server errors, and a refusal that carries no token error code from Supabase Auth, such as the gateway's `401 Invalid API key` when the node's secret key was revoked (the error says to check Project URL and Secret key). Needs `read`. |
| `create_user` | Creates a user without sending email. Arguments: `email`, `password` (optional), `email_confirm` (optional, default false), `user_metadata` (optional object). Returns the user, as `get_user`. Needs `write`. |
| `invite_user` | Creates the user and emails an invite link. Arguments: `email`, `redirect_to` (optional). Returns the user, as `get_user`. Needs `write`. |
| `generate_link` | Makes a sign-in link without sending email. Arguments: `type` (`signup`, `magiclink`, `recovery` or `invite`), `email`, `password` (only for `signup`, where it is required), `redirect_to` (optional). Returns `type`, `email`, `user_id` and `link`. Needs `write`. |
| `update_user` | Changes a user. Arguments: `user_id` and at least one of `email`, `phone`, `password`, `email_confirm`, `phone_confirm`, `user_metadata`, `ban_duration` (`"24h"` bans for a day, `"none"` lifts a ban). Returns the user, as `get_user`. Needs `write`. |
| `delete_user` | Deletes a user. Arguments: `user_id`, `soft_delete` (optional, default false; true anonymises the user and blocks sign-in instead of removing the row). Returns `{"deleted": true, "user_id", "soft_delete"}`. Needs `admin`. |

The link from `generate_link` works once for whoever holds it, so the agent should only hand it to the user it is for. The email one-time code and hashed token that Supabase also returns are left out on purpose. `update_user` cannot change a user's role or app_metadata.

## Configuration

Paste the **Project URL** and a **Secret key**, then set **Access level** to the lowest level the agent needs. Most users can leave **Users per page** alone.

### Access level

`read` (the default) allows `list_users`, `get_user` and `verify_user`. `write` adds `create_user`, `invite_user`, `generate_link` and `update_user`. `admin` adds `delete_user`. The secret key can do everything, so this setting is the only guard on what the agent may change. An agent that only checks who a user is needs `read`.

### Users per page

The most users one `list_users` call returns (1 to 1000, default 50), and its default page size. Larger projects are read page by page; raise it only if the agent needs fewer, bigger pages.

## Authentication

Needs the project URL (`https://<project-ref>.supabase.co`) and a secret key (starts with `sb_secret_`) from Project Settings -> API Keys. Publishable and anon keys are refused at start-up, because they cannot use the admin API. A blank URL or key stops the node at start-up with a message naming the field.

## Notes

### verify_user and the user's token

The token is sent to Supabase for that one request and is never stored, logged or returned. The node never signs in as the user, so later calls keep using the secret key.

### Email delivery

`invite_user` sends email through the project's email settings. Supabase's built-in email service only delivers to members of the project team and sends a few messages an hour; set up custom SMTP in the project for real users. `create_user` and `generate_link` send no email.

## Upstream docs

- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Auth admin API (Python)](https://supabase.com/docs/reference/python/admin-api)
- [API keys](https://supabase.com/docs/guides/api/api-keys)

# Backend requirements: `rrext_account_org` workspace lifecycle verbs

**For:** Ryan (engine/account)
**From:** the unified-settings / Account IA work (client plan: Account's six tabs collapse to three; the Profile section gains a workspace picker as master control and a "Manage workspaces…" slide-over with per-row Rename / Leave / Delete plus New workspace).
**Status:** Rename already exists (`update_org_name`). Create / Leave / Delete are NEW. The client ships with these actions feature-gated (disabled + explanation) until the verbs land, so this work can proceed in parallel with the client phases.

Terminology: "workspace" is the product name for an org. A person can be a member
of multiple workspaces; one is their current/default (`setDefaultOrg`).

## Verbs

All under the existing `rrext_account_org` command as subcommands, authorized
against the calling session.

### `create { name }`

- Creates a new org named `name`; the **caller becomes its admin**.
- On success the server **switches the caller's default org to the new one**
  and pushes `apaext_org_changed` (see Landing rule) — the client rescopes
  through its one existing switch path.
- Validation: non-empty name; normal org-name rules (same as `update_org_name`).

### `leave { orgId }`

- Membership-gated: the caller must be a member of `orgId`.
- **Rejects ONLY when:**
  1. The caller is the org's **last admin** (two admins: either may leave —
     personal workspaces are leavable like any other), or
  2. `orgId` is the caller's **last workspace** (no zero-org accounts).
- Error messages must say which rule rejected, in user-presentable words
  (the client shows them verbatim):
  - "You're the last admin — transfer the role first."
  - "This is your last workspace."
- Anything the caller deployed **stays with the workspace** (no data changes;
  membership row removed).

### `delete { orgId }`

- Admin-gated: the caller must be an admin of `orgId`. This is the exit for
  sole-member workspaces (where `leave` would strand the org).
- **Rejects when:**
  1. `orgId` is the caller's **last workspace**, or
  2. The org has an **active subscription** (cancel billing first — reject
     message must say so).
- **Destroys the org's data for ALL members**: pipelines, deployments, apps,
  environment variables, API keys. The client confirm dialog names the member
  count and these consequences — the verb response (or a cheap pre-check)
  must expose the **member count** so the dialog can state it. Suggestion:
  `delete { orgId, confirm: false }` → `{ members: N, subscriptionActive: bool }`
  dry-run; `confirm: true` executes.

## Landing rule (shared by `leave` and `delete`)

When the org the caller is **currently in** (their default) is left or deleted:

1. The server re-points the caller's default org to:
   - their **personal workspace**, if they still belong to it; otherwise
   - their **oldest remaining membership**.
2. The server pushes **`apaext_org_changed`** to every connection of that
   user — exactly the push `setDefaultOrg` produces today, so every client
   rescopes through the one existing switch path. No new client event.

Leaving/deleting a **non-current** workspace changes nothing about the
caller's default — it just disappears from their workspace list (a normal
`shell:accountUpdate`-style refresh of the membership list is sufficient).

For `delete`, OTHER members of the destroyed org get the same treatment on
their next touch (or push, implementation's choice): default re-pointed by
the landing rule, `apaext_org_changed` pushed.

## Billing note (small, independent)

The billing read wire should accept an **explicit `orgId`** parameter with a
membership check (default: the caller's current org, today's behavior).
The merged Account UI keeps Billing pointed at the one committed current
workspace, but an explicit parameter keeps "view another workspace's
billing" possible later without a wire change.

## Discovery / gating

The client needs to know whether these verbs exist to enable the UI. Either:
- the verbs appear in whatever capability/feature surface the client already
  probes, or
- an unknown-subcommand call fails with a distinguishable "unknown
  subcommand" error (the client treats that as "not shipped yet").

State which one applies.

## Acceptance checklist

- [ ] `create` makes caller admin, switches default, pushes `apaext_org_changed`
- [ ] `leave` enforces exactly the two rejection rules, with the stated messages
- [ ] `delete` is admin-gated, enforces last-workspace + active-subscription rejections, exposes member count (dry-run), destroys org data
- [ ] Landing rule: personal-workspace-first, else oldest membership; push on current-org loss; non-current loss = list refresh only
- [ ] Other members of a deleted org get re-pointed per the landing rule
- [ ] Billing read accepts optional `orgId` + membership check
- [ ] Gating/discovery mechanism documented

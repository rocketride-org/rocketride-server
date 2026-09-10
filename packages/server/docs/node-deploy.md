---
title: Deploying nodes
---

# Deploying nodes

A custom node is distributed the way an app is: the node directory is zipped,
sent to the server over the [WebSocket](/protocols/websocket), and registered as
an **immutable version** on the deployments registry. Nothing is installed into
a machine — publishing puts a version on the shelf, and a separate step decides
who can reach it.

Two commands cover the whole surface:

| Command                                                 | What it does                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `rrext_deploy` with `subcommand: "add"`, `kind: "node"` | Upload a node version (carries the zip)                        |
| `rrext_deploy_node`                                     | Control it: `versions`, `deploy`, `where`, `disable`, `remove` |

That split matches apps exactly: one generic door to put code on the server,
one surface to control it afterwards.

## Publishing a version

Send the node directory as a zip in the binary `data` frame:

```json
{
	"command": "rrext_deploy",
	"arguments": {
		"subcommand": "add",
		"kind": "node",
		"comment": "first cut of the CSV splitter"
	}
}
```

The zip must carry the node's `services.json` **at its root**. That file is the
node's own declaration and it decides the identity: the id comes from
`protocol` (`my_node://` → `my_node`), the display name from `title`, and the
version from `version`. The request does not get a say — a caller naming a
different node must not be able to publish under it.

The response body carries the registry `artifact` and the `orgId` the write
landed in:

```json
{
	"artifact": { "version": 3, "sha256": "…", "artifactPath": "…" },
	"orgId": "acme"
}
```

**A published version is inert.** It is on the shelf and nobody can run it yet.
Making it reachable is `deploy`, below.

### Publishing and binding in one call

`deployTo` on the same request publishes and then binds, which is what the CLI
sends behind `--deploy-to`. A bare team name or id is read as that team; the
`@` targets described under [deploy](#making-a-version-reachable) pass through
unchanged. The response carries the `audience` that was bound alongside the
artifact.

It is a convenience, not a second door: the binding runs through the same rule
`deploy` applies, so nothing becomes reachable here that the explicit verb
would have refused. If the bind fails, **the version still stands** — the
bytes landed and the version is real, so the error says so and the caller
binds it afterwards rather than uploading again.

### What the server checks, in order

Each of these refuses **before** a registry row exists, so a rejected upload
never leaves a version with no bytes behind it:

1. The connection is authenticated.
2. `data` is a binary frame — text is refused rather than left to explode
   inside the zip reader.
3. The zip is at most 50 MB **compressed**, measured before anything is parsed.
4. `services.json` exists at the root, parses, and carries a usable id.
5. The archive is safe: no `..` segments, no absolute paths, at most 2,000
   files, and at most 100 MB when unpacked — measured on the bytes that
   actually come out, not on the sizes the archive claims.

Only then is the version allocated, and only then does content land:

```
<artifact sibling>/bundle/<nodeId>-v<NNNNNN>.zip   the transport zip, kept for provenance
<artifact sibling>/source/…                        the unpacked tree the engine reads
```

If a content write fails partway, what was written is removed and the version
is flipped to `failed`.

## Dependencies

A node declares what it needs the way every in-tree node does: one
`requirements.txt` at the root of its directory. That is the normal case — 116
of the 139 nodes in the tree carry one.

Publishing reads it and records the declared lines on the **artifact**, not
only inside the bundle:

```json
{ "requirements": ["httpx", "pydantic"] }
```

Keeping it on the artifact is what lets anything resolving the node decide
whether it can run it **before** downloading the bundle. Comments and blank
lines are dropped; nothing else is interpreted, because pinning policy belongs
to whoever installs.

### What a node may not bring

An `overrides.txt` is refused, and the version is never registered. Overrides
do not add a dependency — they **replace what other packages declare**, and the
engine sweeps them process-wide. One published node carrying one would rewrite
dependency resolution for every other node running alongside it.

## Seeing what is published

```json
{
	"command": "rrext_deploy_node",
	"arguments": { "subcommand": "versions", "nodeId": "my_node" }
}
```

Returns the rail, newest first:

```json
{
	"versions": [
		{
			"registryVersion": 3,
			"nodeVersion": "1.2.0",
			"runtime": "python",
			"state": "ready",
			"sha256": "…",
			"publishedAt": 1757500000,
			"author": "Ariel Vernaza",
			"message": "first cut of the CSV splitter"
		}
	]
}
```

`registryVersion` is the number every other verb takes. `nodeVersion` is what
the node calls itself, and two rows can carry the same one — which is why the
registry number is the handle.

## Making a version reachable

```json
{
	"command": "rrext_deploy_node",
	"arguments": {
		"subcommand": "deploy",
		"nodeId": "my_node",
		"version": 3,
		"target": "@me"
	}
}
```

`target` is `@me` (the default), `@team/<name-or-id>`, or `@public`. There is no
org-wide target: an organisation is the governance container, and "everyone"
is a team an org admin maintains.

**First release, update and rollback are all this one verb** — pointing an
audience at a different registry version is the whole operation. Rolling back
is pinning the older number again.

## Taking a node back

```json
{
	"command": "rrext_deploy_node",
	"arguments": {
		"subcommand": "disable",
		"nodeId": "my_node",
		"target": "@me"
	}
}
```

`disable` stops serving one binding and is reversible — bind again and it is
back. `remove` takes the row out of the listing.

### Withdrawing everywhere

`"target": "@all"` withdraws every binding the node currently has, in one
call. It is the answer to "unpublish this", which otherwise means reading
`where` and then issuing one call per audience.

Every audience is checked **before any is touched**, so the call either
withdraws all of them or none. Withdrawing half and stopping would leave the
node reachable exactly where the caller wanted it gone.

The bar is the same one that granting the binding needed: a team you are no
longer a member of, or public reach outside your namespace, fails the whole
call rather than being skipped.

**Neither touches the version.** A published version is immutable and stays on
the registry, which is exactly what keeps rollback possible: taking a node back
from a team today does not stop you pinning that same version tomorrow. What is
withdrawn is the pointer, never the artifact.

## Who can expose a node, and how far

The bar is the audience, and it applies the same whether you are putting
something up or taking it down:

| Target               | Requirement                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `@me`                | Nothing beyond an authenticated session                                 |
| `@team/<name-or-id>` | You must be a member of that team                                       |
| `@public`            | The org must be a registered developer **and** own the node's namespace |
| `@org`               | Does not exist — use an org-admin-maintained "All members" team         |

Private reach needs no namespace: the registry is partitioned by organisation,
so two orgs can both hold a node called `csv_split` and never see each other's.
Public reach is one shared space, so a node offered there must be named
`<developerId>` or `<developerId>.<name>` — otherwise the first org to publish
`csv_split` would own that name for everybody.

Note this is **looser than apps on purpose**: an app id must sit in the
developer namespace always, while nodes are named after their protocol
(`store_chroma`, `llm_openai`). Requiring a namespace everywhere would break
that convention to solve a problem that only exists in public.

## Which nodes a caller has

Bindings answer "who can reach this node". The reverse question — "which nodes
can this caller use" — is one resolution over all of them, the same scope walk
apps take:

1. Walk `@public`, then each of the caller's teams, then the caller.
2. On a node-id collision the **more specific rung wins**: user beats team
   beats public. A same-rung tie breaks on the lowest org id, so a stray public
   row can never displace a lower org's claim on a name.
3. A binding serves only when it is `enabled` **and** its version is
   serveable: public reach demands a `ready` version, internal reach accepts
   anything that did not fail.

Each resolved entry carries what a caller needs to decide before fetching
anything — the registry version, the node's own version, its `runtime`, its
declared `requirements` and the bundle digest.

This is deliberately **one** answer rather than two. The picker offers what it
returns and the run-time resolver fetches what it names; a designer offering a
node the run then refuses would be worse than not offering it at all.

## Finding where a node is pinned

```json
{
	"command": "rrext_deploy_node",
	"arguments": { "subcommand": "where", "nodeId": "my_node" }
}
```

```json
{ "pins": [{ "audience": "u1", "version": 3 }] }
```

## Fields worth knowing about

**`runtime`** is `python` today and rides on every artifact. Python nodes are a
source tree the engine imports as it stands. It is recorded from the first
version because native nodes will not be portable: a compiled node ships one
artifact per platform and is tied to the engine build it was compiled against,
so anything resolving a node has to know what it is about to fetch. Registry
artifacts are immutable, which makes an absent field expensive to add later.

**The build lifecycle** on the version's metadata is `ready` the moment a
Python node is published — its source is what runs, so there is nothing to
compile. The field exists for the same reason as `runtime`.

## What happens when a pipeline uses one

A published node is never installed. A run brings in only the nodes that run
names, uses them, and drops them.

**Deciding** comes first and touches nothing. Each component's `provider` is
the node's id, so what a pipeline asks for needs no translating. Subtract what
the engine already carries — for a pipeline of stock nodes that is the whole
of it, one set difference and no lookup. Whatever is left is resolved against
the caller's pins, and **a node with no pin stops the run before any bytes
move**, naming every missing node at once and the org they were looked for in.

**Getting** them follows, and the order is deliberate:

1. The bundle's digest is checked against what the artifact recorded, before a
   zip reader ever sees the bytes.
2. The archive is guarded again — publishing checked the same things, but that
   was a different moment and a different copy.
3. It is unpacked into a cache keyed by **digest**, not by version, so two
   versions never collide and nothing ever needs invalidating.
4. Its declared `requirements.txt` is installed through the engine's own
   installer, which resolves against the constraints lock — a node that cannot
   fit the environment is refused rather than downgrading a package another
   node in the same run depends on.
5. The directory is placed where the engine imports external nodes from, which
   is why the manifest's own `path` never has to be rewritten.

Two runs resolving the same node do not collide: each unpacks into a staging
directory and renames into place, so the second either finds the slot already
there or loses the rename and uses the winner's identical copy.

When the run ends its tree is dropped and the cache stays warm.

## From the command line

The same surface, without hand-writing WebSocket frames. Publishing rides the
generic rail; everything after it is the `node` group:

```
rocketride deploy add ticket_feed.zip --kind node --deploy-to <teamId>

rocketride node versions ticket_feed
rocketride node deploy ticket_feed 3 --target @team/Platform
rocketride node where ticket_feed
rocketride node disable ticket_feed --target @team/Platform
rocketride node remove ticket_feed --target @all
```

These are deployment-target verbs: an absent `ROCKETRIDE_DEPLOY_*` pair stops
the command rather than falling back to the development connection, so a node
never lands somewhere it was not aimed at.

The same calls are on the SDK as `client.deploy.nodeVersions`, `nodeDeploy`,
`nodeWhere` and `nodeWithdraw` — that is what a UI talks to.

## Related

- [WebSocket protocol](/protocols/websocket): the transport these commands ride.
- [Pipeline JSON Reference](/pipeline-reference): the `.pipe` payload shape.

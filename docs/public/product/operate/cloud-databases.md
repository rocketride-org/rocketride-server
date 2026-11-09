---
title: Cloud Databases
---

# Cloud Databases

RocketRide Cloud runs PostgreSQL databases for its built-in database nodes, so a
pipeline can keep data without a database of its own. The
[`rocketride_sql`](/nodes/rocketride_sql),
[`rocketride_vector`](/nodes/rocketride_vector) and
[`rocketride_graph`](/nodes/rocketride_graph) nodes use them. This page covers
what an app or pipeline owner gets: which database holds the data, the limits,
what happens to the data when people, teams, organizations or apps go away, and
what the backups cover. How each node reads and writes is on its own page.

## One database per organization

Every organization has one database, shared by all of its members. Each team
also has its own database, and each member has a personal database in every
organization they belong to. A node's **Database** setting picks one of the
three and defaults to the organization's.

- A database is created empty on the first run that needs it. Every database
  comes with pgvector and Apache AGE installed and a graph named `rocketride`.
- A run uses the databases of the organization it runs in. An app from the
  store starts its pipelines as the person using it, in that person's
  organization, so each organization that uses an app keeps that app's data in
  its own databases, not in the publisher's. A deployed pipeline runs in the
  organization it was deployed from, whoever calls it.
- There is no database or schema per app. Every app and pipeline that uses the
  same database can read, change and drop the same tables in the `public`
  schema, so give your tables names that will not collide with another app's,
  for example with a prefix.

## Limits

These limits apply to each database on RocketRide Cloud today:

| Limit                 | Value                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions at once  | Up to 6. A transaction that cannot get one waits up to 60 seconds, then fails.                                                                                      |
| Idle open transaction | Closed after 10 minutes.                                                                                                                                            |
| Session state         | Connections are pooled per transaction, so `SET`, temporary tables, `LISTEN` and session advisory locks do not carry over to the next transaction. Use `SET LOCAL`. |

Each node adds its own query timeouts and row caps; see its page. For example,
the SQL node runs the queries it writes for a question read-only, with a
60-second limit.

There is no quota per database on storage, tables, rows or queries per minute.
All databases run on one shared PostgreSQL cluster, so its disk, memory and
connections are shared by every organization.

## When data is removed

Removing an app does not touch any database. Removing a member, a team or an
organization retains its databases first and deletes them later.

| Event                                                      | Databases affected                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| An app is removed from a desktop, or its subscription ends | None. The tables the app created stay where they are; drop them yourself when you no longer need them. |
| A member leaves an organization or is removed from it      | That member's personal database in the organization                                                    |
| A team is deleted                                          | The team's database                                                                                    |
| An organization is deleted                                 | The organization's database, every team database and every member's personal database in it            |

A retained database is closed: its login is disabled, its open connections are
cut, and a run that needs it fails at start. Its data is kept for 30 days.

- A member who rejoins the organization within those 30 days gets their
  personal database back as it was. Once the cleanup has deleted it, they start
  with an empty one.
- A deleted team or organization cannot be brought back from the product.
- After 30 days a daily cleanup takes a final copy of the database (a
  `pg_dump`) and then deletes it. A database whose copy fails is not deleted.
  The final copy is held by RocketRide and is not offered for download.

## Backups

- Changes are archived continuously, and a full backup is taken every day.
  Backups are kept for 30 days.
- Live data is held on a primary and two replicas; a commit is on at least one
  replica before it is acknowledged.
- Backups are configured for point-in-time recovery of the whole cluster, never
  of one database. There is no restore of one organization's, team's or
  member's database, and no self-service restore. The 30-day retention above is
  the only undo for a single database.
- A database the cleanup deleted stays in the backups until they are pruned
  after 30 days. The storage keeps pruned backup files for up to 35 more days,
  so its data can survive for about 65 days in all.

## Export

There is no export today. RocketRide offers no download or dump of a database,
and the databases accept connections only from inside RocketRide Cloud, so a
SQL client or `pg_dump` on your machine cannot reach them.

To take data out, read it through a pipeline and write it where you need it:

- **SQL**: with direct query execution on, run `SELECT` statements through the
  node's `execute` tool or `client.database.query()` in the
  [TypeScript](/clients/typescript) or [Python](/clients/python) SDK. A query
  returning more rows than the node's execute row limit fails, so page through
  a table.
- **Vector**: with **Expose as tools** on, `list_documents` lists the stored
  documents and `get` pages through one document's chunks. `get` reads at most
  10,000 chunks of a document, so a larger one comes back marked `truncated`,
  and a document in the trash is refused until it is restored.
- **Graph**: with direct execution on, run a `MATCH ... RETURN` query through
  `execute`, in pages that stay under the node's execute row limit.

## Related

- [`rocketride_sql`](/nodes/rocketride_sql),
  [`rocketride_vector`](/nodes/rocketride_vector),
  [`rocketride_graph`](/nodes/rocketride_graph): the nodes that use these
  databases, and which database each run may use.
- [Cloud](/operate/cloud): connect a client to RocketRide Cloud.
- [Security](/operate/security): what a running pipeline can see.

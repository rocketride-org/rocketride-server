---
title: 'drizzle (rocketride/drizzle)'
date: 2026-08-07
---

# Drizzle ORM over pipes

- [Overview](#overview)
- [Method Signature](#method-signature)
- [Parameters](#parameters)
- [Prerequisites](#prerequisites)
- [Examples](#examples)
  - [Define a schema and query rows](#define-a-schema-and-query-rows)
  - [Writes and row counts](#writes-and-row-counts)
  - [Handling query errors](#handling-query-errors)
  - [Transactions](#transactions)
  - [Nested transactions and isolation config](#nested-transactions-and-isolation-config)
- [Limitations](#limitations)
- [Related Methods](#related-methods)

## Overview

The `rocketride/drizzle` entry point builds a [Drizzle ORM](https://orm.drizzle.team/) instance whose Postgres driver transports SQL over a RocketRide pipeline instead of a TCP socket. No database connection is opened by the client — every query is forwarded through the pipeline's `execute` tool function, and transactions ride the `begin`/`commit`/`rollback` tool functions with full support for isolation config and nested savepoints.

Because `drizzle-orm` has zero runtime dependencies and no Node built-ins, this integration is browser-bundle safe — no polyfills required. It also lives in its own package export, so apps that never use the ORM pay nothing for it.

> **Requirement:** the target database node must have `allow_execute: true` set in its pipeline configuration. The same flag also gates transactions (`begin`/`commit`/`rollback`) — no additional configuration is needed.

## Method Signature

```typescript
import { drizzle } from 'rocketride/drizzle';

drizzle(options: {
  client: DatabaseLike;      // pass client.database
  token: string;
  nodeId?: string;
} & DrizzleConfig): PgDatabase;
```

## Parameters

| Parameter | Type           | Required | Description                                                                                  |
| --------- | -------------- | -------- | -------------------------------------------------------------------------------------------- |
| `client`  | `DatabaseLike` | Yes      | The SDK transport — pass `client.database`.                                                  |
| `token`   | `string`       | Yes      | Pipeline token for authentication and resource access.                                       |
| `nodeId`  | `string`       | No       | Target database node id; pins queries and transactions to one node.                          |
| `schema`  | `DrizzleConfig['schema']` | No | Drizzle schema object enabling the relational query API (`db.query.*`).            |
| `logger`  | `boolean \| Logger` | No  | `true` for Drizzle's `DefaultLogger`, or a custom `Logger`.                                  |
| `casing`  | `DrizzleConfig['casing']` | No | Column-name casing convention passed through to the Drizzle dialect.               |
| `cache`   | `DrizzleConfig['cache']` | No | A Drizzle [cache](https://orm.drizzle.team/docs/cache) instance; forwarded to every prepared query so reads and writes alike consult it. |

## Prerequisites

1. A running pipeline with a Postgres database node (`allow_execute: true`).
2. `drizzle-orm` installed as an optional peer dependency: `npm install drizzle-orm` (supported range: `0.45.x`).
3. **Tables must already exist in the target database** — drizzle-kit schema management (`push`, `studio`) is not part of this integration; migrations run from a trusted context via `client.database.query()` if needed.

## Examples

### Define a schema and query rows

```typescript
import { RocketRideClient } from 'rocketride';
import { drizzle } from 'rocketride/drizzle';
import { eq } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

const users = pgTable('users', {
	id: integer('id').primaryKey(),
	name: text('name'),
	email: text('email'),
});

const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'wss://cloud.rocketride.ai',
});
await client.connect();

const { token } = await client.use({ filepath: './db-pipeline.pipe' });

// Build a Drizzle instance backed by the RocketRide pipeline
const db = drizzle({ client: client.database, token, nodeId: 'my-postgres-node' });

// Fully typed queries — table must exist in the target DB
const activeUsers = await db.select().from(users).where(eq(users.id, 1));
console.log(activeUsers);

await client.terminate(token);
await client.disconnect();
```

### Writes and row counts

Statements without `.returning()` — `db.execute()`, plain `insert`/`update`/`delete` — resolve to `{ rows, rowCount }`, matching node-postgres. `rowCount` is `rows.length` for row-returning statements; otherwise it's the server's affected-row count. Selects and `.returning()` queries still resolve to a plain array of rows.

```typescript
const result = await db.execute(sql`update accounts set balance = balance - 100 where id = ${1} and balance >= 100`);

if (result.rowCount === 0) {
	// No row matched the predicate — optimistic-lock miss. Retry the read or
	// surface a conflict to the caller.
	throw new Error('stale balance read, retry the transfer');
}
```

### Handling query errors

Failed statements surface as Drizzle's `DrizzleQueryError` — its `message` is `Failed query: ...` and does **not** include the original error text. Read `err.cause` for the actual error the pipeline returned:

```typescript
import { DrizzleQueryError } from 'drizzle-orm';

try {
	await db.select().from(users).where(eq(users.id, badId));
} catch (err) {
	if (err instanceof DrizzleQueryError) {
		console.error(err.message); // "Failed query: select ... params: ..."
		console.error(err.cause); // the original error from the pipeline
	}
	throw err;
}
```

This wrapping is upstream Drizzle behavior — it applies whether or not a `cache` is configured.

### Transactions

Transactions are forwarded through the pipeline's `begin`/`commit`/`rollback` tool functions. Use `db.transaction()` exactly as you would with any Drizzle driver — if the callback throws, the transaction is automatically rolled back:

```typescript
const db = drizzle({ client: client.database, token, nodeId: 'my-postgres-node' });

await db.transaction(async (tx) => {
	await tx.update(accounts).set({ balance: sql`${accounts.balance} - 100` }).where(eq(accounts.id, 1));
	await tx.update(accounts).set({ balance: sql`${accounts.balance} + 100` }).where(eq(accounts.id, 2));
	// Throwing here rolls the whole transaction back.
});
```

If the callback throws, the driver rolls back and re-throws your original error — a failure during that rollback (the session already discarded, transport down) is swallowed rather than replacing it, so `catch` always sees the error that caused the rollback, not a secondary one.

A transaction session left open with no activity is rolled back and reaped by the server after an idle timeout (300s by default), though the reaper is lazy and only sweeps stale sessions the next time a transaction starts on that node; recover from a session that outlived it the same way you'd handle any other rollback failure.

### Nested transactions and isolation config

Nested `tx.transaction()` calls map to Postgres savepoints; the optional config maps to `SET TRANSACTION`:

```typescript
await db.transaction(
	async (tx) => {
		await tx.insert(orders).values({ id: 1 });
		try {
			await tx.transaction(async (tx2) => {
				await tx2.insert(auditLog).values({ orderId: 1 });
				throw new Error('audit failed'); // rolls back the savepoint only
			});
		} catch {
			// outer transaction continues and commits
		}
	},
	{ isolationLevel: 'serializable' }
);
```

Savepoint recovery works the same way for a real SQL error, not just a thrown JS error — a failing statement (e.g. a unique-constraint violation) doesn't kill the whole transaction: the server keeps the session alive after Postgres marks it aborted, the driver rolls back to the savepoint, and the outer transaction continues:

```typescript
await db.transaction(async (tx) => {
	await tx.insert(orders).values({ id: 1 });
	try {
		await tx.transaction(async (tx2) => {
			await tx2.insert(orders).values({ id: 1 }); // duplicate key — a real SQL error
		});
	} catch (err) {
		// savepoint rolled back; outer transaction is still usable
	}
	await tx.insert(orders).values({ id: 2 });
});
```

## Limitations

- **No binary parameters.** Queries transport as JSON, so `Buffer`/`bytea` parameters aren't supported — the server rejects them with a bind error rather than silently coercing or dropping them. Encode binary data (e.g. base64 into a `text`/`bytea`-via-`decode()` column) before binding it.

## Related Methods

- `database.query()` — raw SQL over the pipeline; supports `rowMode: 'array'` for positional rows.
- `database.beginTransaction()` / `database.commit()` / `database.rollback()` — the session primitives the driver rides on.
- `database.dialect()` — discover the underlying engine of a node.

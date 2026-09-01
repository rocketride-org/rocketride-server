---
title: Sequelize over Pipelines
sidebar_position: 13
---

# Sequelize over Pipelines

`client.database.sequelize(options)` builds a [Sequelize v6](https://sequelize.org/)
ORM instance whose Postgres dialect transports SQL over a RocketRide pipeline
instead of a TCP socket. No pg connection is opened — every `findAll`, `create`,
`update`, `destroy`, and raw query is forwarded through the pipeline's `execute`
tool function, and transactions ride the `begin`/`commit`/`rollback` tool
functions.

This lets browser and Node.js apps use familiar Sequelize model semantics
(`Model.findAll`, `Model.create`, `sequelize.transaction`) while the actual SQL
runs inside the pipeline on the server side.

> **Requirement:** the target database node must have `allow_execute: true` set in
> its pipeline configuration. The same flag also gates transactions
> (`begin`/`commit`/`rollback`) — no additional configuration is needed.

> **TypeScript-only.** The Python SDK has the same raw database surface
> (`client.database` with `query`/`begin_transaction`/`commit`/`rollback`) but no
> ORM binding.

## Method signature

```typescript
client.database.sequelize(options: {
  Sequelize: SequelizeConstructor;
  token: string;
  nodeId?: string;
  sequelizeOptions?: import('sequelize').Options;
}): Sequelize
```

> **Why `Sequelize` is passed in:** `sequelize` is a peer dependency, not a hard
> dependency, of the `rocketride` client. It transitively depends on Node built-ins
> (`util`, `debug`) that cannot be bundled for browser targets. Importing
> `Sequelize` yourself and passing the class in keeps `rocketride` safe to bundle
> in browser apps that never touch this method.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `Sequelize` | `SequelizeConstructor` | Yes | The `Sequelize` class, from `import { Sequelize } from 'sequelize'`. |
| `token` | `string` | Yes | Pipeline task token from [`use()`](/clients/typescript/pipelines). |
| `nodeId` | `string` | No | Target database node ID. When omitted, the first database node in the pipeline handles queries. |
| `sequelizeOptions` | `Options` | No | Extra Sequelize options merged over the defaults (e.g. `logging`, `define`). |

## Prerequisites

1. A running pipeline with a database node configured with `allow_execute: true`.
2. A pipeline token obtained from `client.use()`.
3. `sequelize` installed as a peer dependency (`npm install sequelize`).

## Define a model and query rows

```typescript
import { RocketRideClient } from 'rocketride';
import { Sequelize, DataTypes } from 'sequelize';

const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'wss://api.rocketride.ai',
});
await client.connect();

const { token } = await client.use({ filepath: './db-pipeline.pipe' });

// Build a Sequelize instance backed by the RocketRide pipeline
const sequelize = client.database.sequelize({ Sequelize, token, nodeId: 'my-postgres-node' });

// Define a model — no sync needed; table must exist in the target DB
const User = sequelize.define(
	'User',
	{
		id: { type: DataTypes.INTEGER, primaryKey: true },
		name: { type: DataTypes.STRING },
		email: { type: DataTypes.STRING },
		active: { type: DataTypes.BOOLEAN },
	},
	{ tableName: 'users', timestamps: false }
);

// Query rows
const users = await User.findAll({ where: { active: true }, limit: 10 });
console.log(users.map((u) => u.toJSON()));

await client.terminate(token);
await client.disconnect();
```

## Transactions

Transactions are forwarded through the pipeline's `begin`/`commit`/`rollback` tool
functions. Use `sequelize.transaction()` exactly as you would with a normal
Sequelize instance:

```typescript
const sequelize = client.database.sequelize({ Sequelize, token, nodeId: 'my-postgres-node' });

await sequelize.transaction(async (t) => {
	await sequelize.query('UPDATE accounts SET balance = balance - 100 WHERE id = :from', {
		replacements: { from: 1 },
		transaction: t,
	});
	await sequelize.query('UPDATE accounts SET balance = balance + 100 WHERE id = :to', {
		replacements: { to: 2 },
		transaction: t,
	});
	// If this callback throws, the transaction is automatically rolled back.
});
```

## Standalone factory (advanced)

If you are not using `RocketRideClient` directly (e.g. in a React hook that already
has a client from `useShellConnection()`), import the `createSequelize` factory:

```typescript
import { createSequelize } from 'rocketride';
import { Sequelize } from 'sequelize';

// client is the RocketRideClient instance from your shell context
const sequelize = createSequelize({
	Sequelize,
	db: client.database,
	token: myToken,
	nodeId: 'my-postgres-node',
});

const [rows] = await sequelize.query('SELECT * FROM products WHERE category = :cat', {
	replacements: { cat: 'electronics' },
});
console.log(rows);
```

`CreateSequelizeOptions` is also exported for TypeScript consumers that pass the
options object separately.

## Related

- `client.database.query()` — raw SQL without the ORM layer
  ([reference](/clients/typescript/reference#database)).
- `client.database.beginTransaction()` — manual transaction management.
- [`use()`](/clients/typescript/pipelines) — start the pipeline that carries the
  SQL.

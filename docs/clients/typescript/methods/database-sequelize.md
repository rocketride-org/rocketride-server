---
title: 'database.sequelize()'
date: 2026-07-01
---

- [Overview](#overview)
- [Method Signature](#method-signature)
- [Parameters](#parameters)
- [Prerequisites](#prerequisites)
- [Examples](#examples)
  - [Define a model and query rows](#define-a-model-and-query-rows)
  - [Transactions](#transactions)
  - [Standalone factory (advanced)](#standalone-factory-advanced)
- [Related Methods](#related-methods)

## Overview

`client.database.sequelize(options)` builds a [Sequelize v6](https://sequelize.org/) ORM instance whose Postgres dialect transports SQL over a RocketRide pipeline instead of a TCP socket. No pg connection is opened — every `findAll`, `create`, `update`, `destroy`, and raw query is forwarded through the pipeline's `execute` tool function, and transactions ride the `begin`/`commit`/`rollback` tool functions.

This lets browser and Node.js apps use familiar Sequelize model semantics (`Model.findAll`, `Model.create`, `sequelize.transaction`) while the actual SQL runs inside the pipeline on the server side.

> **Requirement:** the target database node must have `allow_execute: true` set in its pipeline configuration. The same flag also gates transactions (`begin`/`commit`/`rollback`) — no additional configuration is needed.

---

## Method Signature

```typescript
client.database.sequelize(options: {
  Sequelize: SequelizeConstructor;
  token: string;
  nodeId?: string;
  sequelizeOptions?: import('sequelize').Options;
}): Sequelize
```

> **Why `Sequelize` is passed in:** `sequelize` is a peer dependency, not a hard dependency, of the `rocketride` client. It transitively depends on Node built-ins (`util`, `debug`) that cannot be bundled for browser targets. Importing `Sequelize` yourself and passing the class in keeps `rocketride` safe to bundle in browser apps that never touch this method.

---

## Parameters

| Parameter          | Type                   | Required | Description                                                                                     |
| ------------------ | ---------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `Sequelize`        | `SequelizeConstructor` | Yes      | The `Sequelize` class, from `import { Sequelize } from 'sequelize'`.                             |
| `token`            | `string`               | Yes      | Pipeline task token from `use()`.                                                               |
| `nodeId`           | `string`               | No       | Target database node ID. When omitted, the first database node in the pipeline handles queries. |
| `sequelizeOptions` | `Options`              | No       | Extra Sequelize options merged over the defaults (e.g. `logging`, `define`).                    |

---

## Prerequisites

1. A running pipeline with a database node configured with `allow_execute: true`.
2. A pipeline token obtained from `client.use()`.
3. `sequelize` installed as a peer dependency (`npm install sequelize`).

---

## Examples

### Define a model and query rows

```typescript
import { RocketRideClient, Question } from 'rocketride';
import { Sequelize, DataTypes } from 'sequelize';

const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'wss://cloud.rocketride.ai',
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
	},
	{ tableName: 'users', timestamps: false }
);

// Query rows
const users = await User.findAll({ where: { active: true }, limit: 10 });
console.log(users.map((u) => u.toJSON()));

await client.terminate(token);
await client.disconnect();
```

### Transactions

Transactions are forwarded through the pipeline's `begin`/`commit`/`rollback` tool functions. Use `sequelize.transaction()` exactly as you would with a normal Sequelize instance:

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

### Standalone factory (advanced)

If you are not using `RocketRideClient` directly (e.g. in a React hook that already has a client from `useShellConnection()`), you can import the `createSequelize` factory directly:

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

`CreateSequelizeOptions` is also exported for TypeScript consumers that pass the options object separately:

```typescript
import { createSequelize, CreateSequelizeOptions } from 'rocketride';
import { Sequelize } from 'sequelize';

const opts: CreateSequelizeOptions = {
	Sequelize,
	db: client.database,
	token: myToken,
};
const sequelize = createSequelize(opts);
```

---

## Related Methods

- `client.database.query()` — Execute raw SQL without the Sequelize ORM layer.
- `client.database.beginTransaction()` — Manually manage transactions.
- [`use()`](./use) — Start a pipeline (returns the token needed here).
- [`terminate()`](./terminate) — Stop a running pipeline.

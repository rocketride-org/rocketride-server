/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { Sequelize, Options } from 'sequelize';
import { makePgShim } from './pg-shim.js';
import type { DatabaseLike } from '../../database.js';

/**
 * Constructor shape of the `Sequelize` class, injected by the caller so the
 * RocketRide client never statically (runtime) imports the `sequelize`
 * package. `sequelize` transitively pulls in Node built-ins (`util`, `debug`)
 * that cannot be bundled for browser targets (dropper-ui, chat-ui, etc.).
 * Callers pass their own `import { Sequelize } from 'sequelize'` through.
 */
export type SequelizeConstructor = new (options?: Options) => Sequelize;

/** Options for {@link createSequelize}. */
export interface CreateSequelizeOptions {
	/** The `Sequelize` class, injected by the caller (`import { Sequelize } from 'sequelize'`). */
	Sequelize: SequelizeConstructor;
	/** A `DatabaseLike` instance (e.g. `client.database`) to forward SQL through. */
	db: DatabaseLike;
	/** Pipeline token for authentication and resource access. */
	token: string;
	/** Optional target database node ID; pins connections to a specific node. */
	nodeId?: string;
	/** Extra Sequelize options merged over the defaults. */
	sequelizeOptions?: Options;
}

/**
 * Build a Sequelize v6 instance whose Postgres dialect transports SQL over
 * a RocketRide `DatabaseLike` (e.g. `client.database`) instead of a TCP socket.
 *
 * Internally wires `makePgShim` as `dialectModule` so Sequelize never opens a
 * real pg connection — all queries, transactions, and parameter binding are
 * forwarded through the RocketRide pipeline protocol.
 *
 * @param opts - See {@link CreateSequelizeOptions}.
 * @returns A fully configured `Sequelize` instance ready for model definition and queries.
 *
 * @example
 * ```ts
 * import { Sequelize } from 'sequelize';
 * const sq = createSequelize({ Sequelize, db: client.database, token: myToken, nodeId: 'myDb' });
 * const User = sq.define('User', { name: DataTypes.STRING }, { tableName: 'users', timestamps: false });
 * const users = await User.findAll();
 * ```
 */
export function createSequelize(opts: CreateSequelizeOptions): Sequelize {
	const shim = makePgShim({ db: opts.db, token: opts.token, nodeId: opts.nodeId });
	return new opts.Sequelize({
		dialect: 'postgres',
		dialectModule: shim as unknown as object,
		database: opts.nodeId || 'rocketride',
		username: 'rocketride',
		password: '',
		host: 'rocketride',
		logging: false,
		...opts.sequelizeOptions,
	} as Options);
}

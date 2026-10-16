// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// THE DATABASE COMPONENT — one builder, two providers, three places it lands
// =============================================================================
//
// {@link dbComponent} is the only place in the app that knows what a database
// node looks like, and it is used in three:
//
// 1. the DATA PIPE (`dd_db`), which is how the app reads and writes — a
//    webhook source with the database wired to it as a tool, started once per
//    session and addressed through `client.tool({ tool: 'execute', … })`;
// 2. the BOT's pipeline (`capture_db`), which is how the discord node writes
//    `dd_events` server-side, with no browser involved;
// 3. nothing else — a replay copy is asserted NOT to carry one.
//
// ONE BUILDER IS THE PRODUCTION SWAP. Setting `dbProvider` to
// `rocketride_sql` changes the provider and drops host/user/password/database
// (the Cloud resolves the DSN from the signed-in identity); `table` and
// `allow_execute` are identical, the schema is identical,
// and every statement in `repo.ts` is identical. Because capture and the data
// pipe both come from here, they cannot end up pointed at different
// databases.
//
// A DATABASE NODE CONNECTS WHEN ITS PIPELINE STARTS, so a pipeline carrying
// one cannot start while the database is down. That is why Start checks the
// database first and refuses with the command that starts it
// (`src/bot/useBotTask.ts`). Once the bot is running, a database that goes
// away costs only capture writes: the discord node writes off the answering
// path, logs the failure, and Ralph keeps answering.
//
// THE PASSWORD IS A VARIABLE NAME. `conn.passwordVariable` holds the NAME of
// a server variable, and what the component carries is the `${NAME}`
// placeholder the server resolves (`resolve_pipeline_env`) — the same
// contract as the bot token. The password itself never reaches the browser.
// =============================================================================

/** The two database nodes that share `ai.common.database`. */
export type DbProvider = 'db_postgres' | 'rocketride_sql';

/** Where the dashboard database is, as the manifest settings describe it. */
export interface DbConnection {
	/** Which node to use. */
	provider: DbProvider;
	/** `host:port`. Unused by `rocketride_sql`. */
	host: string;
	/** Database name. Unused by `rocketride_sql`. */
	database: string;
	/** Database user. Unused by `rocketride_sql`. */
	user: string;
	/** The NAME of the server variable holding the password. Unused by `rocketride_sql`. */
	passwordVariable: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** The data pipe's `project_id` — half of its task identity. */
export const DATA_PROJECT_ID = '9d1b3e5f-2a4c-4b7d-8e6f-1c3a5b7d9e20';

/** The data pipe's source component id — the other half. */
export const DATA_SOURCE = 'data_webhook';

/** The data pipe's database component id — what `client.tool` addresses. */
export const DATA_NODE_ID = 'dd_db';

/** The bot pipeline's capture component id. */
export const CAPTURE_NODE_ID = 'capture_db';

/**
 * The table the discord node captures into. Set explicitly because the node's
 * default became `discord_events`; this app's data has always lived in
 * `dd_events`, and every query in `repo.ts` reads it.
 */
export const CAPTURE_TABLE = 'dd_events';

/** The local container the README's Database section creates. */
export const LOCAL_CONTAINER = 'rr-discord-pg';

/**
 * Appended to the discord source's `captureSource` label when the bot's pipe
 * can page Slack, so every row it writes says so. The fold reads it to mark
 * the first escalation in a thread as a Slack page.
 */
export const SLACK_PAGING_SUFFIX = '+tool_slack';

/** The task name the data pipe runs under. */
export const DATA_TASK_NAME = 'Discord Dashboard data';

/**
 * The `table` every database component names.
 *
 * The node wants one for its natural-language surface, which this app never
 * uses — every call is `execute` with the app's own SQL. `dd_events` is named
 * because it is the biggest table and the one a human poking at the node in
 * the canvas would want to see.
 */
export const DEFAULT_TABLE = 'dd_events';

// =============================================================================
// THE COMPONENT
// =============================================================================

/** One control edge, as a tool component declares it. */
export interface ToolControl {
	/** Always `'tool'` for a tool-lane wiring. */
	classType: 'tool';
	/** The id of the component that may call this tool. */
	from: string;
}

/**
 * The database component for either provider.
 *
 * A tool component is wired by a control edge declared ON the tool, naming
 * its caller — so `control` is what decides who can reach the database, and
 * an agent only ever sees the tools whose `control.from` is the agent itself.
 *
 * @param id - The component id. {@link DATA_NODE_ID} or {@link CAPTURE_NODE_ID}.
 * @param conn - Where the database is.
 * @param control - The callers, one edge each.
 * @returns The component, ready to drop into a pipeline's `components`.
 */
export function dbComponent(id: string, conn: DbConnection, control: ToolControl[]): Record<string, unknown> {
	// The two flags both providers share, and the reason either of them is a
	// dashboard database at all: raw SQL is permitted and the table is named.
	const shared = {
		table: DEFAULT_TABLE,
		allow_execute: true,
	};

	if (conn.provider === 'rocketride_sql') {
		return {
			id,
			provider: 'rocketride_sql',
			name: 'Dashboard database',
			config: {
				profile: 'default',
				// No host, user, password or database: the Cloud resolves the DSN
				// from the signed-in RocketRide identity, which is the whole point
				// of this provider.
				default: { ...shared },
				parameters: {},
			},
			control,
		};
	}

	return {
		id,
		provider: 'db_postgres',
		name: 'Dashboard database',
		config: {
			profile: 'default',
			default: {
				host: conn.host,
				user: conn.user,
				password: `\${${conn.passwordVariable}}`,
				database: conn.database,
				...shared,
			},
			parameters: {},
		},
		control,
	};
}

// =============================================================================
// THE DATA PIPE
// =============================================================================

/**
 * The pipeline the app reads and writes through.
 *
 * Two components and one edge. The webhook source exists because a pipeline
 * needs one and because the control edge needs something to hang off; nothing
 * is ever sent to it. Every call is `client.tool({ token, tool: 'execute',
 * nodeId: 'dd_db', input: { sql, params } })`, which borrows an instance from
 * the pool and returns `{ rows, affected_rows }` directly — no Question, no
 * Answer, no SSE.
 *
 * @param conn - Where the database is.
 * @returns The pipeline document, ready for `client.use`.
 */
export function dataPipeline(conn: DbConnection): Record<string, unknown> {
	return {
		components: [
			{
				id: DATA_SOURCE,
				provider: 'webhook',
				name: 'Dashboard data',
				config: {
					hideForm: true,
					mode: 'Source',
					parameters: {},
					type: 'webhook',
					name: 'Webhook',
				},
				ui: { position: { x: 440, y: 300 }, nodeType: 'default', formDataValid: true },
			},
			{
				...dbComponent(DATA_NODE_ID, conn, [{ classType: 'tool', from: DATA_SOURCE }]),
				ui: { position: { x: 760, y: 300 }, nodeType: 'default', formDataValid: true },
			},
		],
		source: DATA_SOURCE,
		project_id: DATA_PROJECT_ID,
		viewport: { x: 0, y: 0, zoom: 1 },
		version: 1,
	};
}

// =============================================================================
// IDENTITY
// =============================================================================

/**
 * A stable key for one connection.
 *
 * The gateway restarts its task when this changes and leaves it alone when it
 * does not, so it has to cover everything that reaches the component — and
 * nothing that does not, or a re-render would churn the task.
 *
 * @param conn - The connection.
 * @returns The key.
 */
export function connectionKey(conn: DbConnection): string {
	if (conn.provider === 'rocketride_sql') return 'rocketride_sql';
	return ['db_postgres', conn.host, conn.database, conn.user, conn.passwordVariable].join('|');
}

/**
 * Read the connection out of the shell's app settings.
 *
 * The dev overlay (App Builder) registers the bundle but not the manifest, so
 * `settings[key]` is undefined there — hence the defaults, which are the same
 * literals `package.json` declares.
 *
 * @param settings - `useWorkspace().settings`.
 * @param defaults - {@link SETTING_DEFAULTS} from `state/types.ts`.
 * @param keys - The five setting keys, in a fixed order.
 * @returns The connection.
 */
export function connectionFromSettings(settings: Record<string, unknown>, defaults: Record<string, string>, keys: { provider: string; host: string; database: string; user: string; password: string }): DbConnection {
	/** One setting's value, falling back to the mirrored manifest default. */
	const read = (key: string): string => String(settings[key] ?? defaults[key] ?? '');
	const provider = read(keys.provider);
	return {
		provider: provider === 'rocketride_sql' ? 'rocketride_sql' : 'db_postgres',
		host: read(keys.host),
		database: read(keys.database),
		user: read(keys.user),
		passwordVariable: read(keys.password),
	};
}

// =============================================================================
// WHEN THE DATABASE IS DOWN
// =============================================================================

/**
 * Why Start was refused, and how to get the database back.
 *
 * The bot's pipeline carries the capture database, and a database node
 * connects when its pipeline starts — so with capture on, a database that is
 * down would fail the start with an engine error. Start asks the database
 * first and says this instead.
 *
 * @param conn - Where the database is.
 * @param reason - What the probe said.
 * @param verb - `start` or `restart`, for the sentence.
 * @returns One message for the toast and the Bot screen.
 */
export function databaseDownMessage(conn: DbConnection, reason: string, verb: 'start' | 'restart'): string {
	// An engine error can be a whole traceback; its first line is the reason.
	const firstLine = reason.split('\n')[0].trim();
	const short = firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine;
	// No "the bot did not start" here: the caller's toast already leads with it.
	const lead = `The dashboard database is not reachable (${short}).`;
	if (conn.provider === 'rocketride_sql') {
		return `${lead} Check the RocketRide Cloud database for this account, then press ${verb === 'start' ? 'Start' : 'Restart'} again, or turn off Settings › Advanced › Capture To Database.`;
	}
	const hostname = conn.host.split(':')[0].trim().toLowerCase();
	const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '';
	const how = local ? `Start it with: docker start ${LOCAL_CONTAINER}. Then press` : `Start the Postgres server at ${conn.host}, then press`;
	return `${lead} ${how} ${verb === 'start' ? 'Start' : 'Restart'} again, or turn off Settings › Advanced › Capture To Database.`;
}

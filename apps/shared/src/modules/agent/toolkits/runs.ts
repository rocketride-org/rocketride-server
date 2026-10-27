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
// RUNS — the pipeline runs this conversation started, and whether a run is one
// =============================================================================

/**
 * terminate and restart ask the user in Ask mode, and in Auto mode act only
 * on a run this conversation started (approval.ts). This ledger says which
 * runs those are.
 *
 * - A `use` the engine answers with `reused: false` started a run. `use`
 *   returns no start time, so the ledger reads `getTaskStatus(token)` at once
 *   and records the token, project_id, source and startTime from it, with the
 *   scope and the conversation. A reused run, or one whose status could not be
 *   read, is not recorded.
 * - A `deploy.run` start is never recorded: a token and a later start time
 *   don't prove this conversation started it.
 * - Right before an Auto terminate or restart, `recheck` reads the status
 *   again. The start time, project_id and source must match the record, and
 *   the host's scope must be the one recorded. The engine reuses a token for
 *   the same project and source, so a later run on it has another start time.
 * - After a restart, the record is refreshed from a status read.
 *
 * The records live in the session file (version 2), so a reloaded
 * conversation still owns its runs. Between the recheck and the call the run
 * could still change; that window is a known limit.
 */

import type { RocketRideClient } from 'rocketride';

import type { RunRecord } from '../turn';
import { isJsonObject, messageOf, type ClientGetter } from './common';

// =============================================================================
// TYPES
// =============================================================================

/** The run a terminate or restart call names: its token, or for restart, its project and source (and a team for a team's deployed run). */
export interface RunTarget {
	token?: string;
	projectId?: string;
	source?: string;
	teamId?: string;
}

/** What the approvals ask about runs. */
export interface RunOwnership {
	/**
	 * The record of the run a call targets, when this conversation started it.
	 *
	 * @param target - The run the call names.
	 * @returns The record, or undefined for a run started elsewhere or not verified.
	 */
	owned(target: RunTarget): RunRecord | undefined;
	/**
	 * Reads the run's status again, right before an Auto terminate or restart.
	 *
	 * @param record - The record approve() found.
	 * @returns null when the run is still the one recorded, else why not.
	 */
	recheck(record: RunRecord): Promise<string | null>;
}

/** What the ledger needs from its run. */
export interface RunLedgerOptions {
	/** The real client, for status reads. */
	client: ClientGetter;
	/** The scope the run started in ('' for the user's own files). */
	scopeKey: string;
	/** The host's scope now: a team switch changes it. */
	currentScope: () => string;
	/** The conversation (session id). */
	conversationId: string;
}

// =============================================================================
// THE LEDGER
// =============================================================================

/** One run's view of the conversation's runs. */
export class RunLedger implements RunOwnership {
	/** The records this run added, in order. */
	readonly started: RunRecord[] = [];

	/**
	 * @param records - The conversation's records; the ledger adds to and refreshes this array in place.
	 * @param o - The client, the scopes and the conversation.
	 */
	constructor(
		readonly records: RunRecord[],
		private readonly o: RunLedgerOptions
	) {}

	owned(target: RunTarget): RunRecord | undefined {
		// a team's deployed run is never one this conversation started with use
		if (target.teamId) return undefined;
		if (target.token) return this.records.find((r) => r.token === target.token);
		if (target.projectId && target.source) return this.records.find((r) => r.projectId === target.projectId && r.source === target.source);
		return undefined;
	}

	async recheck(record: RunRecord): Promise<string | null> {
		if (this.o.currentScope() !== record.scopeKey) return 'the workspace switched to another team since it started';
		let status: Awaited<ReturnType<RocketRideClient['getTaskStatus']>>;
		try {
			status = await this.status(record.token);
		} catch (err) {
			return `its status could not be read (${messageOf(err)})`;
		}
		if (status.startTime !== record.startTime) return 'a different run holds its token now';
		if (status.project_id !== record.projectId || status.source !== record.source) return 'its project or source changed';
		return null;
	}

	/**
	 * Hears a rocketride_client call that worked: a fresh `use` is recorded,
	 * and a restart refreshes the record of the run it named.
	 *
	 * @param method - The client method.
	 * @param params - Its arguments.
	 * @param result - What it returned.
	 */
	async afterCall(method: string, params: readonly unknown[], result: unknown): Promise<void> {
		if (method === 'use') await this.recordUse(result);
		else if (method === 'restart' && isJsonObject(params[0])) {
			const o = params[0];
			const record = this.owned({ token: text(o.token), projectId: text(o.projectId), source: text(o.source), teamId: text(o.teamId) });
			if (record) await this.refresh(record);
		}
	}

	/** Records a run that `use` started fresh, from a status read. */
	private async recordUse(result: unknown): Promise<void> {
		if (!isJsonObject(result) || result.reused !== false || typeof result.token !== 'string') return;
		const { token } = result;
		try {
			const status = await this.status(token);
			const record: RunRecord = { token, projectId: status.project_id, source: status.source, startTime: status.startTime, scopeKey: this.o.scopeKey, conversationId: this.o.conversationId };
			// a token the engine reused for a new run replaces its old record
			const at = this.records.findIndex((r) => r.token === token);
			if (at >= 0) this.records.splice(at, 1);
			this.records.push(record);
			this.started.push(record);
		} catch (err) {
			console.log(`[agent] run ${token.slice(0, 11)}… started, but its status could not be read, so it is not recorded as this conversation's: ${messageOf(err)}`);
		}
	}

	/** Refreshes a record after a restart; one whose status cannot be read stays as it was, and its recheck then fails. */
	private async refresh(record: RunRecord): Promise<void> {
		try {
			const status = await this.status(record.token);
			Object.assign(record, { projectId: status.project_id, source: status.source, startTime: status.startTime });
		} catch (err) {
			console.log(`[agent] run ${record.token.slice(0, 11)}… restarted, but its status could not be read: ${messageOf(err)}`);
		}
	}

	/** The run's status, from the real client. */
	private status(token: string): ReturnType<RocketRideClient['getTaskStatus']> {
		const client = this.o.client();
		if (!client) return Promise.reject(new Error('not connected'));
		return client.getTaskStatus(token);
	}
}

/** A field as text, or undefined. */
function text(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

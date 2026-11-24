/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Pipelines-table widget: renders the list_running_pipelines tool result and
 * offers refresh/terminate via bridge tool calls. Data contract (verified
 * against tools/visibility.py and the conftest contract fixture): the tool
 * returns JSON text content shaped { ok, tasks: [...], count } where each
 * task row has { token, name, description? } (state is NOT in the row —
 * per-task state needs get_task_status and stays out of slice 1).
 */
import { App } from '@modelcontextprotocol/ext-apps';

import { mountBrandHeader } from '../shared/brand';
import { applyHostTheme } from '../shared/host-theme';
import '../shared/theme.css';

interface TaskRow {
	token: string;
	name: string;
	description?: string;
}

const app = new App({ name: 'RocketRide pipelines table', version: '0.1.0' });
applyHostTheme(app);
const root = document.getElementById('root') as HTMLElement;
// Announce refresh/terminate re-renders to assistive technology.
root.setAttribute('aria-live', 'polite');

/**
 * Extract task rows from a CallToolResult. Throws on a host-level tool error
 * (isError), an in-band failure envelope (ok: false), or malformed JSON, so
 * callers surface the failure instead of rendering an empty "no pipelines"
 * state over it.
 */
function parseRows(result: unknown): TaskRow[] {
	const res = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
	// Tool results arrive as [{ type: 'text', text: '<json>' }].
	const text = (res.content ?? []).find((c) => c.type === 'text')?.text;
	if (res.isError) {
		throw failure(text);
	}
	if (!text) throw new Error('malformed tool result (missing text content)');
	let payload: { ok?: boolean; tasks?: TaskRow[]; message?: string };
	try {
		payload = JSON.parse(text) as { ok?: boolean; tasks?: TaskRow[]; message?: string };
	} catch {
		throw new Error('malformed tool result (not JSON)');
	}
	// The tool contract is { ok: true, tasks: [...] } — anything else renders
	// as an error, never as an empty "No pipelines running" state.
	if (payload.ok !== true || !Array.isArray(payload.tasks)) {
		throw new Error(payload.message || 'malformed tool result');
	}
	return payload.tasks;
}

/**
 * A failed tool result as an Error whose message is the readable cause: the
 * server's own `message` (for example a waitlist refusal or a timeout), or
 * the plain text. The raw text rides along for the console.
 */
function failure(text: string | undefined): Error & { raw?: string } {
	let cause = text || 'the tool call failed';
	try {
		const payload = JSON.parse(text ?? '') as { message?: unknown };
		cause = typeof payload.message === 'string' && payload.message ? payload.message : 'the tool call failed';
	} catch {
		// Not JSON: the text itself is the cause.
	}
	return Object.assign(new Error(cause), { raw: text });
}

function causeOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A one-sentence state with Refresh below it, so the widget can always
 * recover. The sentence gets its own line; the button keeps full strength. */
function showMessage(message: string, kind: 'empty' | 'error'): void {
	root.classList.remove('empty');
	const text = document.createElement('p');
	text.className = kind === 'error' ? 'rr-message rr-message-error' : 'rr-message';
	text.textContent = message;
	root.replaceChildren(text, makeRefreshButton());
}

function showError(message: string): void {
	showMessage(message, 'error');
}

/** A failed row action: one sentence between the table and Refresh. */
function showRowError(message: string): void {
	root.querySelector('.rr-status')?.remove();
	const text = document.createElement('p');
	text.className = 'rr-message rr-message-error rr-status';
	text.textContent = message;
	root.insertBefore(text, root.lastElementChild);
}

function makeRefreshButton(): HTMLButtonElement {
	const reload = document.createElement('button');
	reload.className = 'rr-btn rr-btn-ghost';
	reload.textContent = 'Refresh';
	// refresh() catches its own errors and never rejects.
	reload.onclick = () => void refresh();
	return reload;
}

function render(rows: TaskRow[]): void {
	root.classList.remove('empty');
	if (rows.length === 0) {
		// Keep Refresh available in the empty state too, so the widget can
		// recover once pipelines start.
		showMessage('No pipelines are running.', 'empty');
		return;
	}
	const table = document.createElement('table');
	table.className = 'rr-table';
	table.innerHTML = '<thead><tr><th>Name</th><th>Description</th><th>Token</th><th></th></tr></thead>';
	const tbody = document.createElement('tbody');
	for (const row of rows) {
		const tr = document.createElement('tr');
		const cells = [row.name, row.description ?? '', row.token].map((v, i) => {
			const td = document.createElement('td');
			if (i === 2) td.className = 'rr-mono';
			td.textContent = v;
			return td;
		});
		const actions = document.createElement('td');
		const stop = document.createElement('button');
		stop.className = 'rr-btn rr-btn-danger';
		stop.textContent = 'Terminate';
		stop.onclick = async () => {
			stop.disabled = true;
			stop.textContent = 'Stopping…';
			try {
				// terminate's schema requires task_token (see execution.py _TERMINATE_SCHEMA).
				const result = await app.callServerTool({ name: 'terminate', arguments: { task_token: row.token } });
				// callServerTool resolves with isError set on a server-side tool
				// failure instead of rejecting — treat that as a failure too, or
				// the row would stay visible with its button dead.
				const res = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
				if (res.isError) {
					throw failure((res.content ?? []).find((c) => c.type === 'text')?.text);
				}
				await refresh();
			} catch (err) {
				stop.disabled = false;
				stop.textContent = 'Retry';
				// The task may already be gone, so say why the stop failed, not that it still runs.
				// A Refresh that finished first has replaced this row; leave the new list alone.
				if (tr.isConnected) showRowError(`Could not stop "${row.name}": ${causeOf(err)}`);
				console.error('terminate failed', err, (err as { raw?: string }).raw);
			}
		};
		actions.appendChild(stop);
		tr.append(...cells, actions);
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	const card = document.createElement('div');
	card.className = 'rr-card';
	card.appendChild(table);
	root.replaceChildren(card);
	root.appendChild(makeRefreshButton());
}

async function refresh(): Promise<void> {
	try {
		const result = await app.callServerTool({ name: 'list_running_pipelines', arguments: {} });
		render(parseRows(result));
	} catch (err) {
		showError(`Could not refresh the list: ${causeOf(err)}`);
		console.error('refresh failed', err, (err as { raw?: string }).raw);
	}
}

mountBrandHeader('RocketRide Pipelines');

// Initial data: the host pushes the tool result that triggered this widget.
app.ontoolresult = (result) => {
	try {
		render(parseRows(result));
	} catch (err) {
		showError(`Could not load the running pipelines: ${causeOf(err)}`);
		console.error('render failed', err, (err as { raw?: string }).raw);
	}
};
app.connect().catch((err) => {
	showError('Could not connect to the MCP host.');
	console.error('connect failed', err);
});

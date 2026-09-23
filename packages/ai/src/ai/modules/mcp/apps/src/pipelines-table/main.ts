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
import '../shared/theme.css';

interface TaskRow {
	token: string;
	name: string;
	description?: string;
}

const app = new App({ name: 'RocketRide pipelines table', version: '0.1.0' });
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
		throw new Error(text || 'tool call failed');
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

/** Error state that keeps Refresh available — assigning root.textContent
 * would wipe every child including the button, dead-ending the widget. */
function showError(message: string): void {
	root.classList.add('empty');
	root.replaceChildren();
	root.append(message, makeRefreshButton());
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
		root.classList.add('empty');
		// Keep Refresh available in the empty state too, so the widget can
		// recover once pipelines start.
		root.replaceChildren();
		root.append('No pipelines running.', makeRefreshButton());
		return;
	}
	const table = document.createElement('table');
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
			try {
				// terminate's schema requires task_token (see execution.py _TERMINATE_SCHEMA).
				const result = await app.callServerTool({ name: 'terminate', arguments: { task_token: row.token } });
				// callServerTool resolves with isError set on a server-side tool
				// failure instead of rejecting — treat that as a failure too, or
				// the row would stay visible with its button dead.
				if ((result as { isError?: boolean }).isError) {
					throw new Error('terminate reported an error');
				}
				await refresh();
			} catch (err) {
				stop.disabled = false;
				stop.textContent = 'Terminate (failed — retry)';
				console.error('terminate failed', err);
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
		const msg = err instanceof Error ? err.message : String(err);
		showError(`Failed to refresh pipelines: ${msg}`);
		console.error('refresh failed', err);
	}
}

mountBrandHeader('RocketRide Pipelines');

// Initial data: the host pushes the tool result that triggered this widget.
app.ontoolresult = (result) => {
	try {
		render(parseRows(result));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showError(`Failed to render pipelines: ${msg}`);
		console.error('render failed', err);
	}
};
app.connect().catch((err) => {
	const msg = err instanceof Error ? err.message : String(err);
	showError(`Could not connect to the MCP host: ${msg}`);
});

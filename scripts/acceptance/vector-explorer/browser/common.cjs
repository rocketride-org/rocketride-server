// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Helpers the Vector Explorer browser lanes share: the step recorder (only an
 * explicit `true` passes), the WebSocket frame capture and the tool calls the
 * page made, the store's own side read through the TypeScript client with the
 * fixture's task token (never through the page), the B4 privacy property, and
 * page helpers that read numbers defensively (a missing value is null, never 0).
 */
'use strict';
/* global document */
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');
const E = require('../env.cjs');
const { CONSOLE } = require('./ui.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * A recorder for one lane run. `step(page, name, fn)` runs fn(note); the step
 * passes only when fn returns exactly `true`. note(value) attaches data to the
 * step's row in the lane JSON (e.g. measured numbers), whatever the verdict.
 */
function createRecorder(fixtureKey, out, prefix) {
	const results = [];
	fs.mkdirSync(out, { recursive: true });
	function rec(name, ok, detail, extra) {
		const row = { fixture: fixtureKey, name, status: ok ? 'PASS' : 'FAIL', detail };
		if (extra !== undefined) row.extra = extra;
		results.push(row);
		console.log(
			`  [${ok ? 'PASS' : 'FAIL'}] ${fixtureKey}: ${name}` +
				`${!ok && detail ? ` -- ${String(detail).slice(0, 220)}` : ''}`
		);
	}
	async function step(page, name, fn) {
		let extra;
		const note = (value) => {
			extra = value;
		};
		try {
			const detail = await fn(note);
			rec(name, detail === true, detail === true ? undefined : `returned ${JSON.stringify(detail)}`, extra);
		} catch (e) {
			rec(name, false, String(e && e.message ? e.message : e).split('\n')[0], extra);
		}
		await page
			.screenshot({
				path: path.join(out, `${prefix}-${fixtureKey}-${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png`),
			})
			.catch(() => {});
	}
	function write(file) {
		fs.writeFileSync(path.join(out, file), JSON.stringify(results, null, 2));
	}
	return { results, rec, step, write };
}

// ---------------------------------------------------------------------------
// Helpers that need no browser
// ---------------------------------------------------------------------------

/** The objectId the engine derives for an upload named `name`: uuid5(NAMESPACE_URL, 'null://Stream/' + name). */
function objectId(name) {
	const ns = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
	const hash = nodeCrypto
		.createHash('sha1')
		.update(Buffer.concat([ns, Buffer.from('null://Stream/' + name, 'utf8')]))
		.digest();
	const b = Buffer.from(hash.subarray(0, 16));
	b[6] = (b[6] & 0x0f) | 0x50;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = b.toString('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A minimal one-page PDF whose text layer is `text` (ASCII). */
function makePdf(text) {
	const esc = text.replace(/[\\()]/g, (c) => '\\' + c);
	const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
			'/Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	let body = '%PDF-1.4\n';
	const offsets = [];
	objects.forEach((obj, i) => {
		offsets.push(body.length);
		body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
	});
	const xref = body.length;
	body +=
		`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
		offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, 'latin1');
}

/** Every float array of exactly `dim` numbers inside `value`, with the key path that holds it. */
function fullVectors(value, dim, at = '$', found = []) {
	if (Array.isArray(value)) {
		if (
			value.length === dim &&
			value.every((x) => typeof x === 'number') &&
			value.some((x) => !Number.isInteger(x))
		)
			found.push({ at, vector: value });
		else value.forEach((v, i) => fullVectors(v, dim, `${at}[${i}]`, found));
	} else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) fullVectors(v, dim, `${at}.${k}`, found);
	}
	return found;
}

/** The tool name a DAP request asks for, when it is a tool call. */
function toolOf(request) {
	const args = (request && request.arguments) || {};
	return args.tool || (args.arguments && args.arguments.tool) || args.tool_name || null;
}

/** The node a tool call addresses ('' for a broadcast). */
function nodeOf(request) {
	const args = (request && request.arguments) || {};
	return typeof args.nodeId === 'string' ? args.nodeId : null;
}

/** True for a request that sends document bytes (the SDK's sendFiles: rrext_process open/write). */
function isUpload(request) {
	const args = (request && request.arguments) || {};
	return (
		!!request && request.command === 'rrext_process' && (args.subcommand === 'open' || args.subcommand === 'write')
	);
}

/**
 * The store tools that write (the shared tool set; dialect.write_tools): a move to the trash and back,
 * the one permanent delete, and upsert. Nothing else the page sends changes the store but an upload.
 */
const WRITE_TOOLS = Object.freeze(['soft_delete', 'restore', 'delete', 'upsert']);

/**
 * Where a `chunks` answer (limit 1) says a document is: 'active' (it reads at least one chunk), 'trash'
 * (IN_TRASH: every chunk is in the trash), 'gone' (NOT_FOUND: no chunk at all). Anything else is
 * described, never taken for one of the three.
 */
function documentStateOf(answer) {
	if (!answer || typeof answer !== 'object') return `no answer (${JSON.stringify(answer)})`;
	if (answer.success === true)
		return Array.isArray(answer.items) && answer.items.length > 0 ? 'active' : 'read no chunk';
	if (answer.code === 'IN_TRASH') return 'trash';
	if (answer.code === 'NOT_FOUND') return 'gone';
	return `refused (${answer.code || answer.error || 'no code'})`;
}

/** Exact equality of two numeric arrays. */
function sameVector(a, b) {
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

// Columns of a sample/project/neighbors answer hold one value per point (or edge, or scoped key), so
// their length can equal the dimension by chance; so can a row of a similarity_matrix answer, which holds
// one similarity per resolved key. Such a path is exempt only when the array is exactly as long as the
// answer's own count: a dimension-long float array anywhere else is a vector.
const COLUMN_TOOLS = new Set(['sample', 'project', 'neighbors', 'similarity_matrix']);
const COLUMN_PATH = /\.(points\.\w+|density|knn\.sims|similarities|scores|matrix\[\d+\])$/;

/**
 * How many values the column at `at` must hold: the sample's `n` (points.*, density), its edge count
 * (knn.sims, as many as knn.cols), the size of the sample a project call names (similarities), the
 * scope a neighbors call sent (scores), or a similarity matrix's `n` (matrix[i], when the matrix has
 * exactly n rows). Null when the answer does not say.
 */
function columnLength(tool, at, answer, input, sampleSizes) {
	const a = answer || {};
	if (tool === 'sample' && /\.(points\.\w+|density)$/.test(at)) return Number.isInteger(a.n) ? a.n : null;
	if (tool === 'sample' && /\.knn\.sims$/.test(at))
		return a.knn && Array.isArray(a.knn.cols) ? a.knn.cols.length : null;
	if (tool === 'project' && /\.similarities$/.test(at))
		return sampleSizes.has(input.sample_id) ? sampleSizes.get(input.sample_id) : null;
	if (tool === 'neighbors' && /\.scores$/.test(at))
		return Array.isArray(input.scope_keys) ? input.scope_keys.length : null;
	if (tool === 'similarity_matrix' && /\.matrix\[\d+\]$/.test(at))
		return Number.isInteger(a.n) && Array.isArray(a.matrix) && a.matrix.length === a.n ? a.n : null;
	return null;
}

/**
 * The privacy property (B4) over captured WebSocket frames (parsed JSON, in
 * order), for vectors of `dim` (dialect.dimension) floats: no response carries
 * one except `vectors` (at most 2) and `embed` answers; no event carries one;
 * no request carries one other than a vector an embed answer returned earlier.
 * A column of a sample/project/neighbors answer (COLUMN_PATH) is not a vector
 * when it holds exactly the answer's own count of values (columnLength).
 * Returns the violations (empty when the property holds).
 */
function privacyViolations(frames, dim) {
	if (!Number.isInteger(dim) || dim <= 0)
		return [`dialect.dimension is unknown (${JSON.stringify(dim)}), so the property cannot be checked`];
	const requests = new Map();
	const sampleSizes = new Map();
	const embedded = [];
	const violations = [];
	for (const { dir, msg } of frames) {
		if (!msg) continue;
		if (dir === 'sent' && msg.type === 'request') {
			requests.set(msg.seq, msg);
			for (const hit of fullVectors(msg.arguments, dim)) {
				if (!embedded.some((v) => sameVector(v, hit.vector)))
					violations.push(
						`request ${toolOf(msg) || msg.command} carries a ${dim}-float array ` +
							`at ${hit.at} that no embed answer returned`
					);
			}
		} else if (dir === 'received' && msg.type === 'response') {
			const req = requests.get(msg.request_seq);
			const tool = toolOf(req);
			const answer = msg.body && msg.body.result !== undefined ? msg.body.result : msg.body;
			const input = (req && req.arguments && req.arguments.input) || {};
			if (tool === 'sample' && answer && answer.sample_id) sampleSizes.set(answer.sample_id, answer.n);
			const exempt = (h) =>
				COLUMN_TOOLS.has(tool) &&
				COLUMN_PATH.test(h.at) &&
				columnLength(tool, h.at, answer, input, sampleSizes) === h.vector.length;
			const hits = fullVectors(msg.body, dim).filter((h) => !exempt(h));
			if (!hits.length) continue;
			if (tool === 'embed') {
				hits.forEach((h) => embedded.push(h.vector));
			} else if (tool === 'vectors') {
				if (hits.length > 2) violations.push(`a vectors answer carries ${hits.length} vectors (at most 2)`);
			} else {
				violations.push(
					`response to ${tool || (req && req.command) || 'an unknown request'} ` +
						`carries a ${dim}-float array at ${hits[0].at}`
				);
			}
		} else if (dir === 'received' && msg.type === 'event') {
			const hits = fullVectors(msg.body, dim);
			if (hits.length) violations.push(`event ${msg.event || '?'} carries a ${dim}-float array at ${hits[0].at}`);
		}
	}
	return violations;
}

/** The records of a CSV text (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes). */
function csvRecords(text) {
	const records = [];
	let record = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i += 1;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			record.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i += 1;
			record.push(field);
			records.push(record);
			record = [];
			field = '';
		} else field += c;
	}
	if (field !== '' || record.length) {
		record.push(field);
		records.push(record);
	}
	return records;
}

const NUMBER = /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** Whether a list of number-like strings is a float vector of at least `dim` values. */
function floatRun(values, dim) {
	const nums = values.filter((v) => NUMBER.test(v)).map(Number);
	return nums.length >= dim && nums.some((x) => !Number.isInteger(x));
}

/**
 * The B4 property over a file the page let the user download (a CSV or JSON export): where it
 * holds a float array of at least `dim` (dialect.dimension) numbers, as a JSON array, as a
 * bracketed list inside a string or a CSV cell, or spread over the numeric fields of one CSV
 * record; and the names of the `secrets` ({name: value}) whose value appears anywhere in it.
 * Empty when the file is clean; one entry when the dimension is unknown (nothing can be checked).
 */
function downloadVectors(text, dim, secrets = {}) {
	if (!Number.isInteger(dim) || dim <= 0)
		return [`dialect.dimension is unknown (${JSON.stringify(dim)}), so the download cannot be checked`];
	const body = typeof text === 'string' ? text : String(text);
	const found = [];
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = undefined;
	}
	if (parsed !== undefined)
		for (const hit of fullVectors(parsed, dim)) found.push(`a ${dim}-float array at ${hit.at}`);
	// A vector serialised inside a string or a cell: every bracketed list of numbers in the raw text.
	for (const m of body.matchAll(/\[([^[\]]*)\]/g)) {
		if (floatRun(m[1].split(','), dim) && m[1].split(',').every((v) => NUMBER.test(v)))
			found.push(`a bracketed list of ${m[1].split(',').length} floats at offset ${m.index}`);
	}
	if (parsed === undefined) {
		csvRecords(body).forEach((record, i) => {
			if (floatRun(record, dim))
				found.push(`record ${i + 1} holds ${record.filter((v) => NUMBER.test(v)).length} numeric fields`);
		});
	}
	for (const [name, value] of Object.entries(secrets))
		if (typeof value === 'string' && value && body.includes(value)) found.push(name);
	return found;
}

// ---------------------------------------------------------------------------
// What the page sent and received
// ---------------------------------------------------------------------------

/** Capture every JSON WebSocket frame of the page, in order. */
function captureFrames(page) {
	const capture = { frames: [], sockets: 0 };
	const push = (dir, f) => {
		try {
			capture.frames.push({ dir, msg: JSON.parse(String(f.payload)) });
		} catch {
			// binary or non-JSON frame
		}
	};
	page.on('websocket', (ws) => {
		capture.sockets += 1;
		ws.on('framesent', (f) => push('sent', f));
		ws.on('framereceived', (f) => push('received', f));
	});
	return capture;
}

/**
 * The tool calls of the page for `tool` from frame index `since` on, each with
 * its answer when one arrived: { index, input, nodeId, request, result, response }.
 */
function exchanges(capture, tool, since = 0) {
	const out = [];
	const frames = capture.frames;
	for (let i = since; i < frames.length; i += 1) {
		const { dir, msg } = frames[i];
		if (dir !== 'sent' || !msg || msg.type !== 'request' || toolOf(msg) !== tool) continue;
		const args = msg.arguments || {};
		const row = {
			index: i,
			input: args.input || {},
			nodeId: nodeOf(msg),
			request: msg,
			result: undefined,
			response: undefined,
		};
		for (let j = i + 1; j < frames.length; j += 1) {
			const r = frames[j];
			if (r.dir === 'received' && r.msg && r.msg.type === 'response' && r.msg.request_seq === msg.seq) {
				row.response = r.msg;
				row.result = r.msg.body ? r.msg.body.result : undefined;
				break;
			}
		}
		out.push(row);
	}
	return out;
}

/** Wait for an answered `tool` call of the page after frame `since` (optionally matching `where`). */
async function waitForExchange(capture, tool, { since = 0, timeout = 60000, where = () => true } = {}) {
	const deadline = Date.now() + timeout;
	for (;;) {
		if (capture.sockets === 0) throw new Error('the page opened no WebSocket');
		const hit = exchanges(capture, tool, since).find((x) => x.response && where(x));
		if (hit) return hit;
		if (Date.now() > deadline) throw new Error(`no answered ${tool} call within ${timeout} ms`);
		await sleep(250);
	}
}

/** Requests the page sent from frame `since` on that match `pred`. */
function requestsSince(capture, since, pred) {
	return capture.frames
		.slice(since)
		.filter((f) => f.dir === 'sent' && f.msg && f.msg.type === 'request' && pred(f.msg));
}

// ---------------------------------------------------------------------------
// The store's side, through the TypeScript client (never through the page)
// ---------------------------------------------------------------------------

function storeClient(base) {
	let sdk = null;
	async function server() {
		if (sdk) return sdk;
		let mod;
		try {
			mod = require(path.join(E.CLIENT_TS_DIR, 'dist', 'cjs', 'client', 'index.js'));
		} catch (e) {
			throw new Error(
				`the TypeScript client is not built (./builder client-typescript:build): ${e.message.split('\n')[0]}`
			);
		}
		const client = new mod.RocketRideClient({ auth: E.API_KEY, uri: base });
		await client.connect();
		sdk = client;
		return client;
	}
	/** The running tasks (the task list the SDKs read, `rrext_get_tasks`). */
	async function runningTasks() {
		const client = await server();
		const body = await client.call('rrext_get_tasks');
		return (body && body.tasks) || [];
	}
	async function tokenOf(fixture, source) {
		const tasks = await runningTasks();
		const row = tasks.find((t) => (t.pipeline || {}).project_id === fixture.projectId && t.source === source);
		if (!row) throw new Error(`${fixture.name} / ${source} is not running (start_fixtures.py)`);
		return row.token;
	}
	/** A tool call on `nodeId` through the fixture's Tools task. */
	async function tool(fixture, name, input = {}, nodeId = 'store_1') {
		const client = await server();
		return client.tool({ token: await tokenOf(fixture, 'tools_1'), tool: name, nodeId, input, timeout: 60000 });
	}
	/**
	 * Upload texts through the fixture's ingest source, each under its own name (the name the
	 * objectId derives from, e.g. C:/demo/ops/memo_q1.txt): [{ name, text }] -> the upload results.
	 */
	async function upload(fixture, files) {
		const client = await server();
		const token = await tokenOf(fixture, 'ingest_1');
		const items = files.map((f) => ({
			file: new File([f.text], path.posix.basename(f.name), { type: 'text/plain' }),
			objinfo: { name: f.name },
		}));
		return client.sendFiles(items, token, 4);
	}
	/** Where the store keeps a document (documentStateOf): read with `chunks`, a refusal included. */
	async function state(fixture, objectId) {
		try {
			return documentStateOf(await tool(fixture, 'chunks', { object_id: objectId, limit: 1 }));
		} catch (e) {
			if (e && (e.code === 'IN_TRASH' || e.code === 'NOT_FOUND')) return documentStateOf({ code: e.code });
			return `not read (${String(e && e.message ? e.message : e).split('\n')[0]})`;
		}
	}
	/** dialect.dimension of the fixture's managed store (null when it does not say). */
	async function dimension(fixture) {
		const answer = await tool(fixture, 'dialect');
		return answer && Number.isInteger(answer.dimension) && answer.dimension > 0 ? answer.dimension : null;
	}
	async function close() {
		if (sdk) await sdk.disconnect().catch(() => {});
	}
	return { server, runningTasks, tokenOf, tool, state, upload, dimension, close };
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function bodyText(page) {
	const text = await page.locator('body').innerText();
	return typeof text === 'string' ? text : '';
}

/**
 * Click a view switch ("Console", "Map") or a panel tab: a tab, or a button where the app uses buttons.
 * Only a visible one counts: every open connection keeps its console mounted (hidden) behind the one in front.
 */
async function switchView(page, name) {
	const tab = page.getByRole('tab', { name }).filter({ visible: true }).first();
	if (await tab.isVisible().catch(() => false)) return tab.click();
	return page.getByRole('button', { name }).filter({ visible: true }).first().click();
}

/** A shell tab by its label: the tabs above the panes (the Connections landing, each console, each document). */
function shellTab(page, label) {
	return page.locator('div[draggable="true"]').getByText(label, { exact: true }).first();
}

/** A stats-strip figure as shown ('1,500'): the number, or null while it shows none ('…', '—', ''). */
function figureNumber(text) {
	const t = typeof text === 'string' ? text.trim() : '';
	return /^\d{1,3}(,\d{3})*$|^\d+$/.test(t) ? Number(t.replace(/,/g, '')) : null;
}

/**
 * A figure of the stats strip in front (data-figure="<key>"), as a number; null when there is none yet.
 * Read from the strip's own element: a regex over the page text also matches the directory's
 * "Documents" header, and a hidden console's strip is not the one shown.
 */
async function statsFigure(page, key) {
	const text = await page.evaluate((selector) => {
		const shown = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length > 0);
		return shown ? shown.textContent : '';
	}, CONSOLE.statsFigure(key));
	return figureNumber(text);
}

/** Wait (at most `timeout` ms) until the stats strip in front shows a number for `key`, optionally `value`. */
async function waitForStatsFigure(page, key, timeout, value = null) {
	await page.waitForFunction(
		([selector, want]) => {
			const shown = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length > 0);
			const t = shown ? shown.textContent.trim() : '';
			if (!/^\d{1,3}(,\d{3})*$|^\d+$/.test(t)) return false;
			return want === null || Number(t.replace(/,/g, '')) === want;
		},
		[CONSOLE.statsFigure(key), value],
		{ timeout }
	);
}

/** The rows of the upload list in front: { path, status } (status is the row's data-status). */
async function uploadRows(page) {
	const rows = await page.evaluate(
		(selector) =>
			[...document.querySelectorAll(selector)]
				.filter((li) => li.getClientRects().length > 0)
				.map((li) => ({
					path: (li.querySelector('span[title]') || {}).title || '',
					status: li.getAttribute('data-status'),
				})),
		CONSOLE.uploads
	);
	return Array.isArray(rows) ? rows : [];
}

/**
 * Wait (at most `timeout` ms) until the upload list in front has a finished row (done, failed, refused,
 * cancelled) for every path ending with one of `suffixes`, then return the rows. Each row is matched by
 * its own path: a count of "chunks added" anywhere in the page also matches the polite announcement.
 */
async function waitForUploads(page, suffixes, timeout) {
	await page
		.waitForFunction(
			([selector, ends]) => {
				const rows = [...document.querySelectorAll(selector)].filter((li) => li.getClientRects().length > 0);
				const finished = (li) =>
					['done', 'failed', 'refused', 'cancelled'].includes(li.getAttribute('data-status'));
				return ends.every((end) =>
					rows.some(
						(li) => ((li.querySelector('span[title]') || {}).title || '').endsWith(end) && finished(li)
					)
				);
			},
			[CONSOLE.uploads, suffixes],
			{ timeout }
		)
		.catch(() => {});
	return uploadRows(page);
}

/** Whether every path ending with one of `suffixes` has a row that is done. */
function uploadsDone(rows, suffixes) {
	return suffixes.every((end) => rows.some((row) => row.path.endsWith(end) && row.status === 'done'));
}

/** Wait (at most `timeout` ms, polling) until the page text matches `pattern`; whether it did. */
async function waitForText(page, pattern, timeout) {
	const deadline = Date.now() + timeout;
	for (;;) {
		if (pattern.test(await bodyText(page))) return true;
		if (Date.now() > deadline) return false;
		await sleep(100);
	}
}

async function focusedText(page) {
	const text = await page.evaluate(() => (document.activeElement ? document.activeElement.textContent || '' : ''));
	return typeof text === 'string' ? text : '';
}

/** An attribute as an integer; null when absent, empty or not a plain integer. */
async function attrInt(locator, name) {
	const v = await locator.getAttribute(name).catch(() => null);
	return typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null;
}

/** An attribute as a number; null when absent, empty or not a number. */
async function attrNum(locator, name) {
	const v = await locator.getAttribute(name).catch(() => null);
	return typeof v === 'string' && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim()) ? Number(v.trim()) : null;
}

/** An attribute as a string; null when absent. */
async function attrText(locator, name) {
	const v = await locator.getAttribute(name).catch(() => null);
	return typeof v === 'string' ? v : null;
}

/** A locator's text, '' when there is none. */
async function textOf(locator) {
	const v = await locator.innerText().catch(() => '');
	return typeof v === 'string' ? v : '';
}

/**
 * Open a fixture's connection on its console, from wherever the page is: the launcher, the
 * Connections landing, or another connection's console or a document tab (the landing's shell tab
 * is brought to the front first). A console already open is focused, not opened twice. Returns once
 * the console's stats strip shows its document count.
 */
async function openConnection(page, fixture) {
	const launcher = page.getByRole('button', { name: CONSOLE.launcher });
	if (await launcher.isVisible().catch(() => false)) await launcher.click();
	const landing = shellTab(page, CONSOLE.connectionsTab);
	if (await landing.isVisible().catch(() => false)) await landing.click();
	await page.getByText(fixture.name).filter({ visible: true }).first().click();
	for (const name of CONSOLE.openConsole) {
		const button = page.getByRole('button', { name }).filter({ visible: true }).first();
		if (await button.isVisible().catch(() => false)) {
			await button.click();
			break;
		}
	}
	await waitForStatsFigure(page, 'documents', 60000);
}

/** The visible Documents / Trash switch button of the directory in front: which is 'active' or 'trash'. */
function directoryViewButton(page, which) {
	return page
		.getByRole('group', { name: CONSOLE.views })
		.filter({ visible: true })
		.first()
		.getByRole('button', { name: which === 'trash' ? CONSOLE.trashView : CONSOLE.documentsView })
		.first();
}

/** Bring the directory's Documents or Trash view to the front: click its switch, wait until it is pressed. */
async function showDirectoryView(page, which, timeout = 10000) {
	const toggle = directoryViewButton(page, which);
	await toggle.click();
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if ((await toggle.getAttribute('aria-pressed').catch(() => null)) === 'true') return;
		await sleep(250);
	}
	throw new Error(`the ${which === 'trash' ? 'Trash' : 'Documents'} switch is not pressed after the click`);
}

/** The count on the visible Trash switch ("Trash (N)": stats.deleted_documents); null when it shows none. */
async function trashCount(page) {
	const label = await directoryViewButton(page, 'trash')
		.innerText()
		.catch(() => '');
	const m = CONSOLE.trashView.exec(String(label || '').trim());
	return m && m[1] ? Number(m[1].replace(/,/g, '')) : null;
}

module.exports = {
	sleep,
	createRecorder,
	objectId,
	makePdf,
	fullVectors,
	toolOf,
	nodeOf,
	isUpload,
	WRITE_TOOLS,
	documentStateOf,
	sameVector,
	privacyViolations,
	csvRecords,
	downloadVectors,
	captureFrames,
	exchanges,
	waitForExchange,
	requestsSince,
	storeClient,
	bodyText,
	switchView,
	shellTab,
	figureNumber,
	statsFigure,
	waitForStatsFigure,
	uploadRows,
	waitForUploads,
	uploadsDone,
	waitForText,
	focusedText,
	attrInt,
	attrNum,
	attrText,
	textOf,
	openConnection,
	showDirectoryView,
	trashCount,
};

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Browser lane (production shell served by the real engine): Vector Explorer's
 * management console (gate G3). Chrome (installed, channel "chrome"), one
 * fresh context. The map has its own lane (lane_vector_map.cjs, gate G4).
 *
 * Fixtures: start_fixtures.py (the four template fixtures, stock_rag and
 * qdrant_pager) seeded by demo/seed_demo.sh (--pager for qdrant_pager). The lane
 * works on one template fixture (argument, default qdrant) and adds and removes
 * documents of its own there, named lane-<run>...; it never touches the demo
 * documents.
 *
 * Steps (each records PASS/FAIL and a screenshot; only an explicit `true` passes):
 *   connections: one card per tools-controlled store, store_2 never, the stock
 *     RAG pipeline as a Read-only card
 *   the console's stats match the store's own answer
 *   an upload adds a document and grows the stats; the store has it
 *   a folder upload stores nested paths
 *   two files named report.pdf in different folders land on two rows, each
 *     attributed to its own document
 *   re-uploading a stored path asks before replacing (Cancel focused); Cancel
 *     sends nothing (no upload request in the page's frames, the store
 *     unchanged); once on 127.0.0.1 and once on the LAN origin (LAN_URL)
 *   a chat answer carries at least one source; "open" lands on that chunk
 *   trash: Cancel is focused and sends nothing (no write request in the
 *     page's frames, the store unchanged); Move to trash asks for nothing
 *     typed and moves exactly that document to the trash (one soft_delete;
 *     the store reads it as in the trash, the other upload stays active),
 *     the stats drop and the Trash switch counts one more
 *   trash view: the Trash switch lists the store's trash; Restore brings
 *     the document back at once (one restore; active again, the stats back
 *     up); moved to the trash again, Delete permanently (Cancel focused; the
 *     table name typed on a shared rocketride_vector table, nothing typed
 *     elsewhere) deletes exactly that document (one delete; the store no
 *     longer knows it, the other upload still active)
 *   the 1,500-document store loads to completion with the progress line,
 *     the first row unchanged at every look while it loads
 *   sign-out leaves no task token in the page's storage
 *   privacy (B4): no response or event carries a float array of
 *     dialect.dimension numbers except vectors (two at most) and embed
 *     answers; no request carries one other than a query vector embed
 *     returned in this session
 *
 * The store's side of each step is read through the TypeScript client
 * (packages/client-typescript/dist/cjs; ./builder client-typescript:build) with
 * the fixture's Tools task token, never through the page. Selectors and
 * wording: ui.cjs.
 *
 * Usage: node lane_vector.cjs [base-url] [out-dir] [fixture]
 *   (base-url and out-dir default to ENGINE_URL and OUT_DIR; fixture is a key of
 *   env.cjs FIXTURES, default qdrant). LAN_URL: the same engine on a LAN address.
 * vector-ui:e2e-live runs it as `node lane_vector.cjs <base-url> <out-dir> <browser> [backends]`
 * (backends: a comma list, else VECTOR_UI_E2E_BACKENDS, else the four supported ones). The
 * lane then runs once per backend into <out-dir>/<backend> and writes every row, with its
 * browser and backend, to <out-dir>/lane_vector.json. It drives Google Chrome only.
 */
'use strict';
/* global document, localStorage, sessionStorage, window, MutationObserver */
const E = require('../env.cjs');
const C = require('./common.cjs');
const { CONSOLE: UI } = require('./ui.cjs');
const nodeCrypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** The browsers vector-ui:e2e-live names (third argument); this lane drives Google Chrome only. */
const RUNNER_BROWSERS = ['chrome', 'firefox', 'webkit'];
/** The backends a vector-ui:e2e-live run covers when none are named. */
const RUNNER_BACKENDS = ['postgres', 'rocketride_vector', 'qdrant', 'chroma'];

/**
 * The lane's arguments: `<base-url> <out-dir> [fixture]` run directly, or
 * `<base-url> <out-dir> <browser> [backends]` from vector-ui:e2e-live.
 *
 * @param {string[]} args - process.argv without the node binary and the script.
 * @param {Record<string, string | undefined>} env - The environment.
 * @returns {{ base: string, out: string, browser: string | null, fixtures: string[] }}
 *   browser is null when run directly.
 */
function laneArgs(args, env) {
	const [base = E.ENGINE_URL, out = E.OUT_DIR, third, fourth] = args;
	if (!RUNNER_BROWSERS.includes(third)) return { base, out, browser: null, fixtures: [third || 'qdrant'] };
	const named = (fourth || env.VECTOR_UI_E2E_BACKENDS || RUNNER_BACKENDS.join(','))
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
	return { base, out, browser: third, fixtures: named };
}

const ARGS = laneArgs(process.argv.slice(2), process.env);
const { base, out } = ARGS;
const fixtureKey = ARGS.fixtures[0];
const RUN = nodeCrypto.randomBytes(4).toString('hex');

/**
 * The writes among sent frames, in order: the write tools (C.WRITE_TOOLS: 'soft_delete', 'restore',
 * 'delete', 'upsert') by name and uploads as 'upload'.
 */
function sentWrites(frames) {
	const out = [];
	for (const f of frames) {
		if (f.dir !== 'sent' || !f.msg || f.msg.type !== 'request') continue;
		const tool = C.toolOf(f.msg);
		if (C.WRITE_TOOLS.includes(tool)) out.push(tool);
		else if (C.isUpload(f.msg)) out.push('upload');
	}
	return out;
}

/** The object_ids the page's `tool` calls asked for from frame `since` on, in order. */
function askedIds(capture, tool, since) {
	return C.exchanges(capture, tool, since).flatMap((x) =>
		Array.isArray(x.input.object_ids) ? x.input.object_ids : []
	);
}

/**
 * Runs in the page: record { loading, first } on every DOM change while documents load, where
 * loading is the "Loading documents…" line (null when none) and first the first note-NNNN.txt row
 * shown (null when none). Kept in window.__vxLoading, one entry per change of either.
 */
function watchLoading() {
	window.__vxLoading = [];
	const look = () => {
		const text = document.body.innerText;
		const line = /Loading documents…[^\n]*/.exec(text);
		const row = {
			loading: line ? line[0] : null,
			first: text.split('\n').find((l) => /note-\d{4}\.txt/.test(l)) || null,
		};
		const last = window.__vxLoading[window.__vxLoading.length - 1];
		if (!last || last.loading !== row.loading || last.first !== row.first) window.__vxLoading.push(row);
	};
	new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
}

/**
 * The verdict on a watched load of `expected` documents: true, or why not. The progress line must
 * show with "N of <expected>", the first row must not change while it shows (reshuffled), and the
 * directory must end with every document listed and nothing loading.
 */
function loadVerdict(seen, shown, expected) {
	const during = seen.filter((r) => r.loading !== null);
	if (!during.length) return 'the progress line never showed';
	const total = expected.toLocaleString('en-US');
	if (!during.some((r) => new RegExp(`of\\s+${total}\\b`).test(r.loading))) return `no "N of ${total}" progress line`;
	const problem = reshuffled(during.map((r) => r.first));
	if (problem) return problem;
	const last = seen[seen.length - 1];
	if (!last || last.loading !== null) return 'documents were still loading at the end';
	return shown === expected ? true : `the directory shows ${shown} documents`;
}

/**
 * Why the first rows seen while documents loaded show a reshuffle (null when
 * they do not). Looks before the first row rendered (null) are ignored; after
 * it, any other first row (or none) is a reshuffle.
 */
function reshuffled(firstRows) {
	const start = firstRows.findIndex((r) => r !== null);
	if (start === -1) return 'no row was shown while loading';
	const seen = firstRows.slice(start);
	if (seen.length < 2) return `fewer than 2 looks at a shown row while loading (${seen.length})`;
	const changed = seen.findIndex((r) => r !== seen[0]);
	return changed === -1 ? null : `rows reshuffled while loading: ${seen[0]} -> ${seen[changed]}`;
}

async function main() {
	const { chromium } = E.loadPlaywright();
	const fixture = E.FIXTURES[fixtureKey];
	if (!fixture) throw new Error(`unknown fixture ${fixtureKey}; known: ${Object.keys(E.FIXTURES).join(', ')}`);
	const { step, write } = C.createRecorder(fixtureKey, out, 'vector');
	const store = C.storeClient(base);
	// Where the store keeps one of the lane's documents: 'active', 'trash' or 'gone' (C.documentStateOf).
	const stateOf = (name) => store.state(fixture, C.objectId(name));
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-lane-'));
	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	const capture = C.captureFrames(page);
	// The document count of the stats strip in front (null while it shows none).
	const statsDocuments = () => C.statsFigure(page, 'documents');
	const uploadFiles = async (files) => {
		await C.openAddDocuments(page);
		return page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(files);
	};
	const uploadFolder = async (dir) => {
		await C.openAddDocuments(page);
		return page.locator('input[type="file"][webkitdirectory]').first().setInputFiles(dir);
	};
	const own = {
		single: `lane-${RUN}.md`,
		folder: `lane-${RUN}`,
		nested: `lane-${RUN}/nested/deeper/note.md`,
		reportA: `lane-${RUN}/a/report.pdf`,
		reportB: `lane-${RUN}/b/report.pdf`,
	};
	try {
		await E.signIn(page, base);

		await step(
			page,
			'connections: one card per tools-controlled store, store_2 never, stock RAG read-only',
			async () => {
				await page.getByRole('button', { name: UI.launcher }).click();
				await page.getByText(fixture.name).first().waitFor({ timeout: 60000 });
				for (const key of ['postgres', 'rocketride_vector', 'qdrant', 'chroma']) {
					const n = await page.getByText(E.FIXTURES[key].name).count();
					if (n !== 1) return `${E.FIXTURES[key].name}: ${n} cards (expected exactly 1: store_1 only)`;
				}
				const text = await C.bodyText(page);
				if (!text.includes(E.FIXTURES.stock_rag.name)) return 'the stock RAG pipeline has no card';
				return UI.readOnly.test(text) ? true : 'no Read-only card';
			}
		);

		let before = null;
		await step(page, "the console's stats match the store's own answer", async () => {
			await C.openConnection(page, fixture);
			const shown = await statsDocuments();
			const stats = await store.tool(fixture, 'stats', { mode: 'full' });
			before = shown;
			return shown !== null && stats.success === true && shown === stats.documents
				? true
				: `shown ${shown}, store ${JSON.stringify(stats.documents)}`;
		});

		await step(page, 'an upload adds a document and grows the stats', async () => {
			if (before === null) return 'no stats were shown (previous step)';
			const file = path.join(work, own.single);
			fs.writeFileSync(
				file,
				`# Lane note ${RUN}\n\nThe lane uploads this note to check the ingest panel. ` +
					`Glassbrook spring feeds the settling tank.\n`
			);
			await uploadFiles([file]);
			const rows = await C.waitForUploads(page, [own.single], 120000);
			if (!C.uploadsDone(rows, [own.single]))
				return `the upload row did not finish as done: ${JSON.stringify(rows.slice(-3))}`;
			const stored = await stateOf(own.single);
			if (stored !== 'active') return `the store does not have the uploaded document (it is ${stored})`;
			await C.waitForStatsFigure(page, 'documents', 30000, before + 1).catch(() => {});
			return (await statsDocuments()) === before + 1
				? true
				: `stats show ${await statsDocuments()}, expected ${before + 1}`;
		});

		await step(page, 'a folder upload stores nested paths', async () => {
			const file = path.join(work, own.nested);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `# Nested note ${RUN}\n\nA note two folders deep.\n`);
			await uploadFolder(path.join(work, own.folder));
			// Wait for the nested file's own row: the polite announcement also says "chunks added".
			const rows = await C.waitForUploads(page, [own.nested], 120000);
			if (!C.uploadsDone(rows, [own.nested]))
				return (
					`the nested file's row did not finish as done: ` +
					`${JSON.stringify(rows.filter((r) => r.path.endsWith('note.md')))}`
				);
			const nested = await stateOf(own.nested);
			if (nested !== 'active') return `the store has no document named ${own.nested} (it is ${nested})`;
			return (await C.bodyText(page)).includes('deeper') ? true : 'the directory does not show the nested folder';
		});

		await step(page, 'two report.pdf files land on two rows, each attributed to its own document', async (note) => {
			const dir = path.join(work, `${own.folder}-reports`, own.folder);
			for (const [sub, word] of [
				['a', 'alpha'],
				['b', 'bravo'],
			]) {
				fs.mkdirSync(path.join(dir, sub), { recursive: true });
				fs.writeFileSync(path.join(dir, sub, 'report.pdf'), C.makePdf(`Report ${word} ${RUN} for the lane.`));
			}
			fs.rmSync(path.join(work, own.folder), { recursive: true, force: true });
			await uploadFolder(dir);
			// The two same-named files go out one after the other, not together: wait until both rows are finished.
			const rows = (await C.waitForUploads(page, [own.reportA, own.reportB], 180000)).filter((r) =>
				/report\.pdf$/.test(r.path)
			);
			note({ rows });
			if (rows.length < 2) return `${rows.length} upload rows name report.pdf`;
			if (!C.uploadsDone(rows, [own.reportA, own.reportB]))
				return `the report.pdf rows did not both finish as done: ${JSON.stringify(rows)}`;
			for (const [name, word] of [
				[own.reportA, 'alpha'],
				[own.reportB, 'bravo'],
			]) {
				const answer = await store.tool(fixture, 'chunks', { object_id: C.objectId(name), limit: 5 });
				if (!answer.success) return `the store has no ${name}`;
				if (!answer.items.some((c) => String(c.content).includes(word)))
					return `${name} does not hold its own text (${word})`;
			}
			return true;
		});

		const replaceStep = async (label, origin) => {
			await step(
				page,
				`re-uploading a stored path asks first, Cancel focused and sending nothing (${label})`,
				async () => {
					if (!origin) return 'LAN_URL is not set (the same engine on a LAN address)';
					if (origin !== base) {
						await E.signIn(page, origin);
						await C.openConnection(page, fixture);
					}
					const file = path.join(work, own.single);
					fs.writeFileSync(file, `# Changed ${RUN}\n\nThis text must never reach the store.\n`);
					const since = capture.frames.length;
					await uploadFiles([file]);
					await page.getByText(UI.replace).first().waitFor({ timeout: 30000 });
					const focused = (await C.focusedText(page)).trim();
					if (focused !== UI.cancel) return `focus is on ${JSON.stringify(focused)}, not Cancel`;
					await page.getByRole('button', { name: UI.cancel }).first().click();
					await page.waitForTimeout(1500);
					if (capture.sockets === 0) return 'the page opened no WebSocket';
					const sent = sentWrites(capture.frames.slice(since));
					if (sent.length) return `the page sent ${sent.join(', ')} although Cancel was chosen`;
					const answer = await store.tool(fixture, 'chunks', { object_id: C.objectId(own.single), limit: 5 });
					if (!answer.success) return 'the stored document is gone after Cancel';
					return answer.items.some((c) => String(c.content).includes('must never reach'))
						? 'the replacement reached the store after Cancel'
						: true;
				}
			);
		};
		await replaceStep('127.0.0.1', base);
		// The LAN origin needs the engine listening on that address (LAN_URL, e.g. http://<this host's address>:5590).
		await replaceStep('LAN origin', process.env.LAN_URL || null);

		await step(page, 'a chat answer carries sources and "open" lands on the chunk', async (note) => {
			await page
				.getByRole('textbox', { name: UI.chatBox })
				.filter({ visible: true })
				.first()
				.fill(E.WATER_QUESTION);
			await page.getByRole('button', { name: UI.askButton }).filter({ visible: true }).first().click();
			await page.getByText(E.STUB_LLM_TAG).first().waitFor({ timeout: 120000 });
			if (!(await C.bodyText(page)).includes(E.STUB_LLM_TAG)) return 'no stub answer is shown';
			const opens = page
				.getByRole('list', { name: UI.sources })
				.filter({ visible: true })
				.first()
				.getByRole('button', { name: UI.sourceOpen });
			if ((await opens.count()) < 1) return 'the answer shows no source';
			const label = await opens.first().getAttribute('aria-label');
			const target = UI.sourceTarget.exec(label || '');
			if (!target) return `the first source's "open" is named ${JSON.stringify(label)}`;
			await opens.first().click();
			// The document tab in front shows that chunk (its row carries data-chunk).
			const shown = (n) =>
				[...document.querySelectorAll(`[data-document] [data-chunk="${n}"]`)].some(
					(el) => el.getClientRects().length > 0
				);
			await page.waitForFunction(shown, Number(target[2]), { timeout: 30000 }).catch(() => {});
			const landed = await page.evaluate(shown, Number(target[2]));
			note({ source: label, landed });
			return landed === true ? true : `no chunk #${target[2]} of ${target[1]} is shown after open`;
		});

		// The Documents and Trash tabs (the redesign): a grid per tab, a pending bar under the panels while
		// documents are
		// staged, an inline confirmation, and the Trash tab's own buttons. The grids draw the rows in view only, so a
		// step filters a listing down to its document (C.showOne) before it touches the row.
		const rowButton = (name) => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
		const trashCount = () => C.trashCount(page);
		const bar = () => C.pendingBar(page);
		const writeSentence = async () => (await C.textOf(bar())).trim();
		// The Overview's own figure: the stats strip is in front on that tab only.
		const overviewDocuments = async () => {
			await C.showTab(page, 'overview');
			return statsDocuments();
		};

		await step(
			page,
			'documents: staging sends nothing, Apply asks first, Confirm moves exactly that document to the trash',
			async (note) => {
				// The chat step's "open" left a document tab in front: back to this connection's console.
				await C.openConnection(page, fixture);
				const shown = await overviewDocuments();
				const trashBefore = await trashCount();
				await C.showTab(page, 'documents');
				await C.showOne(page, own.single);
				const since = capture.frames.length;
				await C.stageDocument(page, own.single);
				await bar().waitFor({ timeout: 15000 });
				if (sentWrites(capture.frames.slice(since)).length) return 'staging a document sent a write';
				if (!/1 document/.test(await C.textOf(bar())))
					return `the pending bar does not name one document: ${await C.textOf(bar())}`;
				// Discard drops it and sends nothing.
				await bar().getByRole('button', { name: UI.discard }).click();
				await page.waitForTimeout(500);
				if (
					await bar()
						.isVisible()
						.catch(() => false)
				)
					return 'the pending bar stays after Discard';
				if (sentWrites(capture.frames.slice(since)).length) return 'Discard sent a write';
				// Stage again, Apply opens the confirmation; Cancel sends nothing and leaves the document stored.
				await C.stageDocument(page, own.single);
				await bar().getByRole('button', { name: UI.apply }).click();
				const group = C.inlineConfirm(page);
				await group.waitFor({ timeout: 15000 });
				if ((await group.getAttribute('aria-label')) !== UI.titles.trashOne)
					return `the confirmation is "${await group.getAttribute('aria-label')}"`;
				if (await group.getByRole('textbox').count()) return 'the move to the trash asks for something typed';
				await C.answerConfirm(page, { confirm: false });
				await page.waitForTimeout(1000);
				if (capture.sockets === 0) return 'the page opened no WebSocket';
				const cancelled = sentWrites(capture.frames.slice(since));
				if (cancelled.length) return `the page sent ${cancelled.join(', ')} although Cancel was chosen`;
				const kept = await stateOf(own.single);
				if (kept !== 'active') return `after Cancel the document is ${kept}`;
				// Apply again and Confirm: exactly one soft_delete, for exactly that document.
				const sinceConfirm = capture.frames.length;
				await bar().getByRole('button', { name: UI.apply }).click();
				await C.answerConfirm(page, { action: 'trash' });
				await C.waitForExchange(capture, 'soft_delete', { since: sinceConfirm, timeout: 60000 });
				await page.waitForTimeout(1500);
				const sent = sentWrites(capture.frames.slice(sinceConfirm));
				const asked = askedIds(capture, 'soft_delete', sinceConfirm);
				const single = await stateOf(own.single);
				const nested = await stateOf(own.nested);
				note({ sent, asked, single, nested, trashBefore });
				if (JSON.stringify(sent) !== JSON.stringify(['soft_delete']))
					return `Apply sent ${JSON.stringify(sent)}, not one soft_delete`;
				if (JSON.stringify(asked) !== JSON.stringify([C.objectId(own.single)]))
					return `soft_delete asked for ${JSON.stringify(asked)}, not the document's own objectId`;
				if (single !== 'trash') return `after Apply the document is ${single}, not in the trash`;
				if (nested !== 'active') return `Apply touched another document (it is ${nested})`;
				// The refresh after the write: the grid no longer lists it, the stats and the Trash tab's count follow.
				if (shown !== null) await C.waitForStatsFigure(page, 'documents', 30000, shown - 1).catch(() => {});
				const after = await overviewDocuments();
				if (shown === null || after !== shown - 1) return `stats ${shown} -> ${after}`;
				const trashAfter = await trashCount();
				note({ trashAfter });
				return trashBefore === null || trashAfter === trashBefore + 1
					? true
					: `the Trash tab counts ${trashAfter}, ${trashBefore} before`;
			}
		);

		await step(
			page,
			'trash: Restore brings the document back; a typed permanent delete (file or table name) deletes it',
			async (note) => {
				const id = C.objectId(own.single);
				const start = await stateOf(own.single);
				if (start !== 'trash') return `the document is ${start} before the Trash tab, not in the trash`;
				const shown = await overviewDocuments();
				let since = capture.frames.length;
				await C.showTab(page, 'trash');
				// The Trash tab lists the store's trash.
				const listing = await C.waitForExchange(capture, 'list_documents', {
					since,
					timeout: 30000,
					where: (x) => x.input.deleted === 'deleted',
				});
				await C.showOne(page, own.single);
				since = capture.frames.length;
				await rowButton(UI.restore(own.single)).click();
				await C.waitForExchange(capture, 'restore', { since, timeout: 60000 });
				await page.waitForTimeout(1500);
				const restoreSent = sentWrites(capture.frames.slice(since));
				const restored = askedIds(capture, 'restore', since);
				const back = await stateOf(own.single);
				note({ listing: listing.input, restoreSent, restored, back });
				if (JSON.stringify(restoreSent) !== JSON.stringify(['restore']))
					return `Restore sent ${JSON.stringify(restoreSent)}, not one restore`;
				if (JSON.stringify(restored) !== JSON.stringify([id]))
					return `restore asked for ${JSON.stringify(restored)}, not the document's own objectId`;
				if (back !== 'active') return `after Restore the document is ${back}`;
				const restoredLine = await writeSentence();
				note({ restoredLine });
				if (shown !== null) await C.waitForStatsFigure(page, 'documents', 30000, shown + 1).catch(() => {});
				const restoredStats = await overviewDocuments();
				if (shown === null || restoredStats !== shown + 1)
					return `after Restore the stats show ${restoredStats}, ${shown} before`;
				// To the trash again (stage, Apply, Confirm), then delete it permanently from the Trash tab.
				await C.showTab(page, 'documents');
				await C.showOne(page, own.single);
				since = capture.frames.length;
				await C.stageDocument(page, own.single);
				await bar().getByRole('button', { name: UI.apply }).click();
				await C.answerConfirm(page, { action: 'trash' });
				await C.waitForExchange(capture, 'soft_delete', { since, timeout: 60000 });
				await page.waitForTimeout(1000);
				const again = await stateOf(own.single);
				if (again !== 'trash') return `moved to the trash again, the document is ${again}`;
				await C.showTab(page, 'trash');
				await C.showOne(page, own.single);
				since = capture.frames.length;
				await rowButton(UI.deletePermanently(own.single)).click();
				const group = C.inlineConfirm(page);
				await group.waitFor({ timeout: 15000 });
				if ((await group.getAttribute('aria-label')) !== UI.titles.deleteOne)
					return `the confirmation is "${await group.getAttribute('aria-label')}"`;
				const confirm = group.getByRole('button', { name: UI.deleteConfirm }).first();
				// A permanent delete is always typed: the file name, or a shared rocketride_vector table's name. The
				// confirm
				// button stays disabled (aria-disabled) until what is typed matches.
				const prompt = await C.textOf(group);
				const table = UI.typedConfirm.exec(prompt);
				const file = UI.typedFile.exec(prompt);
				note({ typed: table ? 'table' : file ? 'file' : null });
				if (fixtureKey === 'rocketride_vector' && !table)
					return 'the shared table asked for no typed table name';
				if (!table && !file) return 'a permanent delete asked for nothing typed';
				if ((await confirm.getAttribute('aria-disabled')) !== 'true')
					return 'Delete permanently is enabled before anything is typed';
				// Cancel first: nothing is sent, the document stays in the trash.
				await C.answerConfirm(page, { confirm: false });
				await page.waitForTimeout(800);
				if (sentWrites(capture.frames.slice(since)).length)
					return 'Cancel on the permanent delete sent a write';
				await rowButton(UI.deletePermanently(own.single)).click();
				await C.answerConfirm(page, { action: 'delete' });
				await C.waitForExchange(capture, 'delete', { since, timeout: 60000 });
				await page.waitForTimeout(1500);
				const deleteSent = sentWrites(capture.frames.slice(since));
				const deleted = askedIds(capture, 'delete', since);
				const gone = await stateOf(own.single);
				const nested = await stateOf(own.nested);
				note({ deleteSent, deleted, gone, nested });
				if (JSON.stringify(deleteSent) !== JSON.stringify(['delete']))
					return `Delete permanently sent ${JSON.stringify(deleteSent)}, not one delete`;
				if (JSON.stringify(deleted) !== JSON.stringify([id]))
					return `delete asked for ${JSON.stringify(deleted)}, not the document's own objectId`;
				if (gone !== 'gone') return `after Delete permanently the document is ${gone}`;
				return nested === 'active' ? true : `Delete permanently touched another document (it is ${nested})`;
			}
		);

		// Two more documents for the batch steps: moved to the trash through the app, then restored behind its back.
		const batch = [`lane-${RUN}-batch-a.md`, `lane-${RUN}-batch-b.md`];
		own.batchA = batch[0];
		own.batchB = batch[1];
		await step(
			page,
			'a batch already restored elsewhere: Restore selected says what moved, never a restore it did not do',
			async (note) => {
				for (const name of batch) {
					const file = path.join(work, name);
					fs.writeFileSync(
						file,
						`# ${name}\n\nBatch note ${RUN}. Glassbrook spring feeds the settling tank.\n`
					);
				}
				await C.showTab(page, 'documents');
				await uploadFiles(batch.map((name) => path.join(work, name)));
				const rows = await C.waitForUploads(page, batch, 120000);
				if (!C.uploadsDone(rows, batch))
					return `the batch uploads did not finish as done: ${JSON.stringify(rows.slice(-3))}`;
				// Stage both (the scope box narrows to the lane's batch prefix), Apply, Confirm: both in the trash.
				await C.showOne(page, `lane-${RUN}-batch`);
				let since = capture.frames.length;
				for (const name of batch) await C.stageDocument(page, name);
				await bar().getByRole('button', { name: UI.apply }).click();
				const group = C.inlineConfirm(page);
				await group.waitFor({ timeout: 15000 });
				if ((await group.getAttribute('aria-label')) !== 'Move 2 documents to the trash?')
					return `the confirmation is "${await group.getAttribute('aria-label')}"`;
				await C.answerConfirm(page, { action: 'trash' });
				await C.waitForExchange(capture, 'soft_delete', { since, timeout: 60000 });
				await page.waitForTimeout(1500);
				for (const name of batch)
					if ((await stateOf(name)) !== 'trash') return `${name} is not in the trash after Apply`;
				// The Trash tab lists both; the lane restores ONE of them through the store (as another writer would).
				await C.showTab(page, 'trash');
				await C.showOne(page, `lane-${RUN}-batch`);
				await rowButton(UI.select(batch[0])).waitFor({ timeout: 15000 });
				const other = await store.tool(fixture, 'restore', { object_ids: [C.objectId(batch[0])] });
				if (!other.success) return `the store refused the lane's own restore: ${JSON.stringify(other)}`;
				// The grid is stale: both rows still shown. Select both, Restore selected: one moves, one already had.
				since = capture.frames.length;
				await page.getByRole('button', { name: UI.selectAllShown }).filter({ visible: true }).first().click();
				await page
					.getByRole('button', { name: UI.restoreSelected, exact: true })
					.filter({ visible: true })
					.first()
					.click();
				const exchange = await C.waitForExchange(capture, 'restore', { since, timeout: 60000 });
				await page.waitForTimeout(1500);
				const answered = exchange.result || {};
				note({ answered: { matched_chunks: answered.matched_chunks, moved_chunks: answered.moved_chunks } });
				for (const name of batch)
					if ((await stateOf(name)) !== 'active') return `${name} is not active after Restore selected`;
				// moved_chunks is what moved (one document's chunks); matched_chunks counts both documents' chunks.
				if (typeof answered.moved_chunks !== 'number') return 'the restore answer carries no moved_chunks';
				if (typeof answered.matched_chunks === 'number' && !(answered.moved_chunks < answered.matched_chunks))
					return `moved_chunks ${answered.moved_chunks} is not below ${answered.matched_chunks} matched`;
				const line = await writeSentence();
				note({ line });
				if (UI.nothingMoved.test(line)) return `the line says nothing moved although a document moved: ${line}`;
				if (!new RegExp(`${answered.moved_chunks} chunks? moved`).test(line))
					return `the line does not say ${answered.moved_chunks} chunks moved: ${line}`;
				// A second time over the same stale selection moves nothing: the sentence says so.
				since = capture.frames.length;
				await store.tool(fixture, 'soft_delete', { object_ids: batch.map(C.objectId) });
				await C.showTab(page, 'trash');
				await C.showOne(page, `lane-${RUN}-batch`);
				await rowButton(UI.select(batch[0])).waitFor({ timeout: 15000 });
				await store.tool(fixture, 'restore', { object_ids: batch.map(C.objectId) });
				await page.getByRole('button', { name: UI.selectAllShown }).filter({ visible: true }).first().click();
				await page
					.getByRole('button', { name: UI.restoreSelected, exact: true })
					.filter({ visible: true })
					.first()
					.click();
				await C.waitForExchange(capture, 'restore', { since, timeout: 60000 });
				await page.waitForTimeout(1500);
				const nothing = await writeSentence();
				note({ nothing });
				return UI.nothingMoved.test(nothing) && /already restored/.test(nothing)
					? true
					: `no "Nothing moved ... already restored" line: ${nothing}`;
			}
		);

		// A bulk write that fails after part of it ran (more documents than one batch holds). The lane's own page
		// script closes the socket on the SECOND soft_delete request, so the failure falls between batches.
		await step(
			page,
			'a bulk move that fails after its first batch says how far it got and leaves the rest staged',
			async (note) => {
				if (fixtureKey !== 'qdrant')
					return 'NOT RUN: the 150-document bulk needs the Qdrant pager fixture; run with FIXTURE=qdrant';
				const pager = E.FIXTURES.qdrant_pager;
				await C.openConnection(page, pager);
				await C.showTab(page, 'documents');
				await page
					.waitForFunction(() => !/Loading documents…/.test(document.body.innerText), null, {
						timeout: 120000,
					})
					.catch(() => {});
				const pagerStore = C.storeClient(base);
				try {
					const before = await pagerStore.tool(pager, 'stats', { mode: 'full' });
					// Close the socket instead of sending the second soft_delete batch.
					// This callback runs in the page, not in Node, so Node's WebSocket support does not apply.
					/* eslint-disable n/no-unsupported-features/node-builtins */
					await page.evaluate(() => {
						const send = WebSocket.prototype.send;
						let seen = 0;
						WebSocket.prototype.send = function (data) {
							try {
								if (typeof data === 'string' && /"tool":\s*"soft_delete"/.test(data) && ++seen === 2) {
									this.close();
									return;
								}
							} catch {
								// a frame that is not JSON is sent as it is
							}
							return send.call(this, data);
						};
					});
					/* eslint-enable n/no-unsupported-features/node-builtins */
					// Stage up to 150 documents: the rows in view are enough to need a second batch.
					const boxes = page.getByRole('checkbox', { name: /^Stage .* to move to the trash$/ });
					const count = Math.min(150, await boxes.count());
					if (count < 20) return `only ${count} rows are in view to stage: scroll the grid first`;
					for (let i = 0; i < count; i += 1) await boxes.nth(i).check();
					await bar().getByRole('button', { name: UI.apply }).click();
					const group = C.inlineConfirm(page);
					await group.waitFor({ timeout: 15000 });
					// A bulk move opens its confirmation on Cancel; Confirm is still pressed explicitly.
					await C.answerConfirm(page, { action: 'trash' });
					await page.waitForTimeout(5000);
					const line = await writeSentence();
					const stopped = UI.stoppedAfter.exec(line);
					note({ line });
					const after = await pagerStore.tool(pager, 'stats', { mode: 'full' });
					if (!stopped) return `the line does not say where the write stopped: ${line}`;
					if (!(after.deleted_documents > (before.deleted_documents || 0)))
						return 'no document reached the trash before the failure';
					return Number(stopped[1]) < Number(stopped[2]) &&
						(await bar()
							.isVisible()
							.catch(() => false))
						? true
						: 'the batches or the staged rest are not as stopped';
				} finally {
					// Put the fixture right through the store: everything the lane moved is restored.
					const trash = await pagerStore
						.tool(pager, 'list_documents', { deleted: 'deleted', limit: 200 })
						.catch(() => null);
					const ids = trash && trash.success ? trash.items.map((i) => i.objectId) : [];
					if (ids.length)
						await pagerStore.tool(pager, 'restore', { object_ids: ids.slice(0, 100) }).catch(() => {});
					if (ids.length > 100)
						await pagerStore.tool(pager, 'restore', { object_ids: ids.slice(100) }).catch(() => {});
				}
			}
		);

		await step(page, 'the 1,500-document store loads to completion without reshuffling', async (note) => {
			// The whole load can take under a second, too fast to poll: record every change of the progress
			// line and of the first row from before the connection opens.
			await page.evaluate(watchLoading);
			await C.openConnection(page, E.FIXTURES.qdrant_pager);
			await C.showTab(page, 'documents');
			await page
				.waitForFunction(() => !/Loading documents…/.test(document.body.innerText), null, { timeout: 120000 })
				.catch(() => {});
			const seen = await page.evaluate(() => window.__vxLoading || null);
			const m = UI.directoryCount.exec(await C.bodyText(page));
			const n = m ? Number(m[1].replace(/,/g, '')) : null;
			const verdict = loadVerdict(Array.isArray(seen) ? seen : [], n, E.PAGER_DOCUMENTS);
			note({ seen, n });
			return verdict;
		});

		await step(page, 'sign-out leaves no task token in the page storage', async () => {
			const tokens = (await store.runningTasks()).map((t) => t.token).filter(Boolean);
			const menu = page.locator('[aria-haspopup="menu"]').last();
			await menu.click();
			await page.getByText(UI.logout).first().click();
			await page.waitForTimeout(1500);
			// This callback runs in the page, not in Node, so Node's localStorage support does not apply.
			// eslint-disable-next-line n/no-unsupported-features/node-builtins
			const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
			if (!tokens.length) return 'no running tasks to check against';
			if (typeof stored !== 'string' || !stored.startsWith('{')) return 'the page storage could not be read';
			const leaked = tokens.filter((t) => stored.includes(t));
			return leaked.length === 0 && UI.signIn.test(await C.bodyText(page))
				? true
				: `${leaked.length} task tokens left in storage`;
		});

		await step(page, 'privacy: no full-dimension vectors outside vectors and embed answers', async (note) => {
			if (!capture.frames.length) return 'no WebSocket frames were captured';
			const dimension = await store.dimension(fixture);
			note({ dimension, frames: capture.frames.length });
			const violations = C.privacyViolations(capture.frames, dimension);
			return violations.length === 0 ? true : violations.slice(0, 3).join('; ');
		});
	} finally {
		// Clean up the lane's own documents through the store (never the demo ones).
		try {
			const ids = Object.values(own)
				.filter((n) => /\.(md|pdf)$/.test(n))
				.map(C.objectId);
			await store.tool(fixture, 'delete', { object_ids: ids });
		} catch {
			// best effort
		}
		await browser.close().catch(() => {});
		await store.close();
		fs.rmSync(work, { recursive: true, force: true });
		write('lane_vector.json');
	}
}

/**
 * The argv of a per-backend child: this process's own Node options first (e.g. a -r preload or
 * --inspect given to the runner), then the script and its arguments.
 */
function childArgv(execArgv, script, args) {
	return [...execArgv, script, ...args];
}

/**
 * A vector-ui:e2e-live run: the lane once per backend, each in its own process and folder, then
 * every row (with its browser and backend) in <out>/lane_vector.json.
 *
 * @param {ReturnType<typeof laneArgs>} args - The arguments (browser set).
 * @returns {number} The exit code: 0 only when every row passed.
 */
function runForE2e(args) {
	const { spawnSync } = require('child_process');
	const rows = [];
	for (const key of args.fixtures) {
		if (args.browser !== 'chrome') {
			rows.push({
				browser: args.browser,
				backend: key,
				fixture: key,
				name: 'lane',
				status: 'FAIL',
				detail: `the console lane drives Google Chrome only, not ${args.browser}`,
			});
			continue;
		}
		const sub = path.join(args.out, key);
		const file = path.join(sub, 'lane_vector.json');
		fs.rmSync(file, { force: true });
		const run = spawnSync(process.execPath, childArgv(process.execArgv, __filename, [args.base, sub, key]), {
			stdio: 'inherit',
			env: process.env,
		});
		let data = null;
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			data = null;
		}
		if (!Array.isArray(data))
			data = [
				{ fixture: key, name: 'lane', status: 'FAIL', detail: `the lane wrote no result (exit ${run.status})` },
			];
		for (const row of data) rows.push({ browser: args.browser, backend: key, ...row });
	}
	fs.mkdirSync(args.out, { recursive: true });
	fs.writeFileSync(path.join(args.out, 'lane_vector.json'), JSON.stringify(rows, null, 2));
	const failed = rows.filter((r) => r.status !== 'PASS').length;
	console.log(`${rows.length - failed} of ${rows.length} steps passed over ${args.fixtures.join(', ')}`);
	return failed || rows.length === 0 ? 1 : 0;
}

if (require.main === module && ARGS.browser !== null) {
	process.exitCode = runForE2e(ARGS);
} else if (require.main === module) {
	main()
		.then(() => {
			const data = JSON.parse(fs.readFileSync(path.join(out, 'lane_vector.json'), 'utf8'));
			const failed = data.filter((r) => r.status !== 'PASS').length;
			console.log(`${data.length - failed} of ${data.length} steps passed`);
			process.exitCode = failed ? 1 : 0;
		})
		.catch((e) => {
			console.error(e);
			const file = path.join(out, 'lane_vector.json');
			if (!fs.existsSync(file)) {
				fs.mkdirSync(out, { recursive: true });
				fs.writeFileSync(
					file,
					JSON.stringify(
						[
							{
								fixture: fixtureKey,
								name: 'lane',
								status: 'FAIL',
								detail: String(e && e.message ? e.message : e),
							},
						],
						null,
						2
					)
				);
			}
			process.exitCode = 1;
		});
}

module.exports = { reshuffled, loadVerdict, sentWrites, laneArgs, childArgv };

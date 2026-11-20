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
	const uploadFiles = (files) =>
		page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(files);
	const uploadFolder = (dir) => page.locator('input[type="file"][webkitdirectory]').first().setInputFiles(dir);
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

		// The directory's own controls: a row's button by its exact name and the dialog in front.
		const rowButton = (name) => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
		const dialog = page.getByRole('dialog').filter({ visible: true }).first();
		const dialogButton = (name) => dialog.getByRole('button', { name }).first();
		const showView = (which) => C.showDirectoryView(page, which);
		const trashCount = () => C.trashCount(page);
		// The directory renders only the rows in view: filter it to one document so its row is there.
		const filterTo = async (name) => {
			await page.getByPlaceholder(UI.filterPaths).filter({ visible: true }).first().fill(name);
			await page.waitForTimeout(500);
		};

		await step(
			page,
			'trash: Cancel focused and sending nothing, Move to trash moves exactly that document to the trash',
			async (note) => {
				// The chat step's "open" left a document tab in front: back to this connection's console.
				await C.openConnection(page, fixture);
				const shown = await statsDocuments();
				const trashBefore = await trashCount();
				await filterTo(own.single);
				const trash = rowButton(UI.trash(own.single));
				const confirm = dialogButton(UI.trashConfirm);
				const since = capture.frames.length;
				await trash.click();
				await confirm.waitFor({ timeout: 15000 });
				const focused = (await C.focusedText(page)).trim();
				if (focused !== UI.cancel) return `focus is on ${JSON.stringify(focused)}, not Cancel`;
				await dialogButton(UI.cancel).click();
				await page.waitForTimeout(1000);
				if (capture.sockets === 0) return 'the page opened no WebSocket';
				const cancelled = sentWrites(capture.frames.slice(since));
				if (cancelled.length) return `the page sent ${cancelled.join(', ')} although Cancel was chosen`;
				const kept = await stateOf(own.single);
				if (kept !== 'active') return `after Cancel the document is ${kept}`;
				const sinceConfirm = capture.frames.length;
				await trash.click();
				await confirm.waitFor({ timeout: 15000 });
				// A move to the trash can be undone: nothing to type, a shared rocketride_vector table included.
				if (await dialog.getByRole('textbox').count()) return 'the move to the trash asks for something typed';
				if (await confirm.isDisabled()) return 'Move to trash is disabled';
				await confirm.click();
				await C.waitForExchange(capture, 'soft_delete', { since: sinceConfirm, timeout: 60000 });
				await page.waitForTimeout(1500);
				const sent = sentWrites(capture.frames.slice(sinceConfirm));
				const asked = askedIds(capture, 'soft_delete', sinceConfirm);
				const single = await stateOf(own.single);
				const nested = await stateOf(own.nested);
				note({ sent, asked, single, nested, trashBefore });
				if (JSON.stringify(sent) !== JSON.stringify(['soft_delete']))
					return `Move to trash sent ${JSON.stringify(sent)}, not one soft_delete`;
				if (JSON.stringify(asked) !== JSON.stringify([C.objectId(own.single)]))
					return `soft_delete asked for ${JSON.stringify(asked)}, not the document's own objectId`;
				if (single !== 'trash') return `after Move to trash the document is ${single}, not in the trash`;
				if (nested !== 'active') return `Move to trash touched another document (it is ${nested})`;
				if (shown !== null) await C.waitForStatsFigure(page, 'documents', 30000, shown - 1).catch(() => {});
				const after = await statsDocuments();
				if (shown === null || after !== shown - 1) return `stats ${shown} -> ${after}`;
				// "Trash (N)" is the store's count; a store that gives none shows plain "Trash" before and after.
				const trashAfter = await trashCount();
				note({ trashAfter });
				return trashBefore === null || trashAfter === trashBefore + 1
					? true
					: `the Trash switch counts ${trashAfter}, ${trashBefore} before`;
			}
		);

		await step(
			page,
			'trash view: Restore brings the document back; Delete permanently, typed on a shared table, deletes it',
			async (note) => {
				const id = C.objectId(own.single);
				const start = await stateOf(own.single);
				if (start !== 'trash') return `the document is ${start} before the Trash view, not in the trash`;
				const shown = await statsDocuments();
				let since = capture.frames.length;
				await showView('trash');
				// The Trash view lists the store's trash.
				const listing = await C.waitForExchange(capture, 'list_documents', {
					since,
					timeout: 30000,
					where: (x) => x.input.deleted === 'deleted',
				});
				await filterTo(own.single);
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
				if (shown !== null) await C.waitForStatsFigure(page, 'documents', 30000, shown + 1).catch(() => {});
				const restoredStats = await statsDocuments();
				if (shown === null || restoredStats !== shown + 1)
					return `after Restore the stats show ${restoredStats}, ${shown} before`;
				// To the trash again, then delete it permanently from the Trash view.
				await showView('active');
				await filterTo(own.single);
				since = capture.frames.length;
				await rowButton(UI.trash(own.single)).click();
				await dialogButton(UI.trashConfirm).click();
				await C.waitForExchange(capture, 'soft_delete', { since, timeout: 60000 });
				await page.waitForTimeout(1000);
				const again = await stateOf(own.single);
				if (again !== 'trash') return `moved to the trash again, the document is ${again}`;
				await showView('trash');
				await filterTo(own.single);
				since = capture.frames.length;
				await rowButton(UI.deletePermanently(own.single)).click();
				const confirm = dialogButton(UI.deleteConfirm);
				await confirm.waitFor({ timeout: 15000 });
				const focused = (await C.focusedText(page)).trim();
				if (focused !== UI.cancel) return `focus is on ${JSON.stringify(focused)}, not Cancel`;
				// A shared rocketride_vector table asks for its name typed first; the delete stays disabled until then.
				const typed = UI.typedConfirm.exec(await C.textOf(dialog));
				note({ typed: typed ? typed[1] : null });
				if (fixtureKey === 'rocketride_vector' && !typed)
					return 'the shared table asked for no typed table name';
				if (typed) {
					if (!(await confirm.isDisabled()))
						return 'Delete permanently is enabled before the table name is typed';
					await dialog.getByRole('textbox', { name: UI.typedConfirm }).first().fill(typed[1]);
				} else if (await dialog.getByRole('textbox').count()) {
					return 'deleting one document of a store that is not shared asks for something typed';
				}
				await confirm.click();
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

		await step(page, 'the 1,500-document store loads to completion without reshuffling', async (note) => {
			// The whole load can take under a second, too fast to poll: record every change of the progress
			// line and of the first row from before the connection opens.
			await page.evaluate(watchLoading);
			await C.openConnection(page, E.FIXTURES.qdrant_pager);
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

/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Dropper widget: drag-drop upload to the pk_-tokenized upload_url from the
 * run_dropper_pipe tool result. The POST is synchronous — its response is the
 * standard engine envelope {status: 'OK', data: DataResult} (or
 * {status: 'Error', error}), where DataResult is
 * {objectsRequested, objectsCompleted, resultTypes, objects}.
 * XHR (not fetch) for upload-progress events. Requires csp.connectDomains to
 * include the engine origin (stamped by apps.py at list time).
 */
import { App } from '@modelcontextprotocol/ext-apps';

import { mountBrandHeader } from '../shared/brand';
import '../shared/theme.css';

interface DropperInfo {
	upload_url: string;
	dropper_url: string;
	task_token: string;
}

interface DataResult {
	objectsRequested: number;
	objectsCompleted: number;
	resultTypes: Record<string, unknown>;
	objects: Record<string, unknown>;
}

interface Envelope {
	status?: 'OK' | 'Error';
	data?: DataResult;
	error?: Record<string, unknown>;
}

const app = new App({ name: 'RocketRide dropper', version: '0.1.0' });
const root = document.getElementById('root') as HTMLElement;
let info: DropperInfo | null = null;

function parseInfo(result: unknown): DropperInfo | null {
	if (result === null || typeof result !== 'object') return null;
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	const text = content.find((c) => c.type === 'text')?.text;
	if (!text) return null;
	try {
		const payload = JSON.parse(text) as Partial<DropperInfo> & { ok?: boolean };
		return payload.ok && payload.upload_url ? (payload as DropperInfo) : null;
	} catch {
		return null;
	}
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** Tab routing mirrors dropper-ui (ResultsTabs + parseDropperResults):
 * each result field is routed by its declared type in resultTypes into a
 * typed tab; raw JSON gets its own tab instead of sprawling inline. */
const TABS = ['Text', 'Tables', 'Images', 'Audio', 'Video', 'Documents', 'Questions', 'Answers'] as const;
type Tab = (typeof TABS)[number] | 'JSON';

const TYPE_TO_TAB: Record<string, Tab> = {
	text: 'Text',
	table: 'Tables',
	tables: 'Tables',
	image: 'Images',
	images: 'Images',
	audio: 'Audio',
	audios: 'Audio',
	video: 'Video',
	videos: 'Video',
	document: 'Documents',
	documents: 'Documents',
	question: 'Questions',
	questions: 'Questions',
	answer: 'Answers',
	answers: 'Answers',
};

const MEDIA_LANE: Partial<Record<Tab, string>> = { Images: 'image', Audio: 'audio', Video: 'video' };

interface Block {
	objectKey: string;
	fieldName: string;
	tab: Tab;
	value: unknown;
}

/** Media entries arrive as {mime_type, <lane>} where the base64 payload sits
 * under the lane name (dropper-ui's processMediaData), or as bare data URLs. */
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

function mediaUrls(value: unknown, lane: string): string[] {
	const fromEntry = (item: unknown): string | null => {
		if (item !== null && typeof item === 'object') {
			const record = item as Record<string, unknown>;
			if (typeof record.mime_type === 'string' && typeof record[lane] === 'string') {
				// Pipeline output is untrusted: reject malformed mime strings so
				// they can't corrupt the data URL.
				if (!MIME_RE.test(record.mime_type)) return null;
				return `data:${record.mime_type};base64,${record[lane]}`;
			}
			return null;
		}
		// Bare strings must already be data: URLs — the MCP Apps MVP forbids
		// external URLs, and a remote src would leak the render to a third party.
		return typeof item === 'string' && item.startsWith('data:') ? item : null;
	};
	return (Array.isArray(value) ? value : [value]).map(fromEntry).filter((url): url is string => url !== null);
}

function renderBlock(block: Block): HTMLElement {
	const card = el('div', 'result-object');
	card.appendChild(el('h3', undefined, `${block.objectKey} — ${block.fieldName}`));
	const lane = MEDIA_LANE[block.tab];
	if (lane) {
		for (const url of mediaUrls(block.value, lane)) {
			if (block.tab === 'Images') {
				const img = el('img');
				img.src = url;
				card.appendChild(img);
			} else {
				const media = el(block.tab === 'Audio' ? 'audio' : 'video');
				media.controls = true;
				media.src = url;
				card.appendChild(media);
			}
		}
		return card;
	}
	const values = Array.isArray(block.value) ? block.value : [block.value];
	for (const value of values) {
		card.appendChild(el('pre', undefined, typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
	}
	return card;
}

function collectBlocks(data: DataResult): Block[] {
	const blocks: Block[] = [];
	for (const [objectKey, objectValue] of Object.entries(data.objects ?? {})) {
		if (objectValue === null || typeof objectValue !== 'object') continue;
		for (const [fieldName, value] of Object.entries(objectValue as Record<string, unknown>)) {
			if (fieldName === 'status' || value === null || value === undefined) continue;
			const tab = TYPE_TO_TAB[String((data.resultTypes ?? {})[fieldName] ?? '')];
			if (tab) blocks.push({ objectKey, fieldName, tab, value });
		}
	}
	return blocks;
}

function renderResults(data: DataResult): void {
	const blocks = collectBlocks(data);
	const wrap = el('div');
	wrap.appendChild(el('p', undefined, `${data.objectsCompleted}/${data.objectsRequested} objects processed`));

	// Failed objects carry a formatted exception instead of a pipe result.
	for (const [objectKey, objectValue] of Object.entries(data.objects ?? {})) {
		const status = (objectValue as Record<string, unknown> | null)?.status;
		if (status !== 'OK') {
			const card = el('div', 'result-object error');
			card.appendChild(el('h3', undefined, `${objectKey} — failed`));
			card.appendChild(el('pre', undefined, JSON.stringify(objectValue, null, 2)));
			wrap.appendChild(card);
		}
	}

	const nav = el('div', 'tab-nav');
	const panel = el('div');
	const buttons = new Map<Tab, HTMLButtonElement>();

	const show = (tab: Tab): void => {
		buttons.forEach((btn, key) => btn.classList.toggle('active', key === tab));
		if (tab === 'JSON') {
			const card = el('div', 'result-object');
			card.appendChild(el('pre', undefined, JSON.stringify(data, null, 2)));
			panel.replaceChildren(card);
			return;
		}
		panel.replaceChildren(...blocks.filter((b) => b.tab === tab).map(renderBlock));
	};

	const addTab = (tab: Tab, count?: number): void => {
		const btn = el('button', 'tab-btn', tab) as HTMLButtonElement;
		btn.type = 'button';
		if (count !== undefined) btn.appendChild(el('span', 'tab-badge', String(count)));
		btn.onclick = () => show(tab);
		buttons.set(tab, btn);
		nav.appendChild(btn);
	};

	for (const tab of TABS) {
		const count = blocks.filter((b) => b.tab === tab).length;
		if (count > 0) addTab(tab, count);
	}
	addTab('JSON');

	const first = TABS.find((tab) => blocks.some((b) => b.tab === tab)) ?? 'JSON';
	show(first);

	wrap.appendChild(nav);
	wrap.appendChild(panel);
	root.replaceChildren(wrap, buildDropzone('Drop more files'));
}

function upload(files: FileList | File[]): void {
	if (!info) return;
	const form = new FormData();
	Array.from(files).forEach((f, i) => form.append(`file_${i}`, f, f.name));
	const bar = el('div', 'bar');
	const fill = el('div', 'fill');
	bar.appendChild(fill);
	const label = el('p', undefined, 'Uploading…');
	root.replaceChildren(label, bar);

	const xhr = new XMLHttpRequest();
	xhr.open('POST', info.upload_url);
	xhr.upload.onprogress = (e) => {
		if (e.lengthComputable) fill.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
	};
	xhr.upload.onload = () => {
		label.textContent = 'Processing… (the pipeline is running; this can take a while)';
	};
	xhr.onload = () => {
		let envelope: Envelope | null = null;
		try {
			envelope = JSON.parse(xhr.responseText) as Envelope;
		} catch {
			envelope = null;
		}
		if (envelope?.status === 'OK' && envelope.data) {
			renderResults(envelope.data);
			return;
		}
		const message = envelope?.status === 'Error' ? `Pipeline error: ${JSON.stringify(envelope.error ?? {})}` : `Unexpected response (HTTP ${xhr.status})`;
		root.replaceChildren(el('p', 'empty', message), buildDropzone('Try again'));
	};
	xhr.onerror = () => {
		root.replaceChildren(el('p', 'empty', 'Upload failed — network/CSP error. Check the engine is reachable.'), buildDropzone('Try again'));
	};
	// A stalled connection fires neither onerror nor onload — without a
	// timeout the widget would sit on "Processing…" forever with no dropzone.
	xhr.timeout = 30 * 60 * 1000;
	xhr.ontimeout = () => {
		root.replaceChildren(el('p', 'empty', 'Upload timed out. The pipeline may still be running.'), buildDropzone('Try again'));
	};
	xhr.send(form);
}

function buildDropzone(prompt: string): HTMLElement {
	const zone = el('div', 'dropzone', prompt);
	// Keyboard accessibility: the zone is a div acting as a button, so give
	// it button semantics, a tab stop, and Enter/Space activation.
	zone.setAttribute('role', 'button');
	zone.tabIndex = 0;
	const picker = el('input') as HTMLInputElement;
	picker.type = 'file';
	picker.multiple = true;
	picker.style.display = 'none';
	picker.onchange = () => picker.files && upload(picker.files);
	// picker is a child of zone: the synthetic click from zone.onclick bubbles
	// back to zone and would call picker.click() again (re-entrant loop /
	// double-opened file dialog). Block it.
	picker.onclick = (e) => e.stopPropagation();
	zone.appendChild(picker);
	zone.onclick = () => picker.click();
	zone.onkeydown = (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			picker.click();
		}
	};
	zone.ondragover = (e) => {
		e.preventDefault();
		zone.classList.add('drag');
	};
	zone.ondragleave = (e) => {
		// dragleave bubbles from children; only clear when leaving the zone.
		if (!(e.relatedTarget instanceof Node) || !zone.contains(e.relatedTarget)) {
			zone.classList.remove('drag');
		}
	};
	zone.ondrop = (e) => {
		e.preventDefault();
		zone.classList.remove('drag');
		if (e.dataTransfer?.files.length) upload(e.dataTransfer.files);
	};
	return zone;
}

mountBrandHeader('RocketRide Dropper');

app.ontoolresult = (result) => {
	info = parseInfo(result);
	root.classList.remove('empty');
	if (!info) {
		root.textContent = 'run_dropper_pipe did not return an upload URL.';
		return;
	}
	root.replaceChildren(buildDropzone('Drop files here, or click to choose'));
};
app.connect().catch(() => {
	root.classList.remove('empty');
	root.replaceChildren(el('p', 'empty', 'Could not connect to the MCP host.'));
});

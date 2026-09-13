import { SCORER_KINDS, type EvaluationCase, type EvaluationSpec } from './types';

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? '';
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(',')}}`;
	return JSON.stringify(value) ?? 'null';
}
export const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

export function pipelineSources(pipeline: Record<string, unknown>): { id: string; name: string }[] {
	return (Array.isArray(pipeline.components) ? pipeline.components : [])
		.filter(isRecord)
		.filter((item) => isRecord(item.config) && item.config.mode === 'Source')
		.map((item) => ({ id: typeof item.id === 'string' ? item.id : '', name: String(item.name || item.id || '') }))
		.filter((item) => item.id)
		.sort((a, b) => a.name.localeCompare(b.name));
}
export function newSpec(project: Record<string, unknown>, name: string): EvaluationSpec {
	return {
		schemaVersion: 1,
		name: `${name || 'Pipeline'} evaluation`,
		projectId: typeof project.project_id === 'string' ? project.project_id : '',
		pipeline: clone(project),
		source: pipelineSources(project)[0]?.id ?? '',
		inputMode: 'chat',
		environment: 'development',
		datasetName: 'Reviewed cases',
		cases: [],
		scorers: [{ id: crypto.randomUUID(), name: 'Reference match', kind: 'contains' }],
		repetitions: 1,
		passCriteria: { minimumPassRate: 1, maxRegressions: 0 },
	};
}

/** Reject unknown evaluation fields instead of silently dropping or inventing contract extensions. */
export function validateSpec(value: unknown): string[] {
	const errors: string[] = [];
	const object = (item: unknown, allowed: string[], path: string): item is Record<string, unknown> => {
		if (!isRecord(item)) {
			errors.push(`${path} must be an object.`);
			return false;
		}
		for (const key of Object.keys(item)) if (!allowed.includes(key)) errors.push(`${path}.${key} is not a supported field.`);
		return true;
	};
	const text = (item: unknown, path: string, nonempty = true, limit = 256): void => {
		if (typeof item !== 'string' || (nonempty && !item.trim()) || item.length > limit) errors.push(`${path} must be ${nonempty ? 'a nonempty' : 'a'} string of at most ${limit} characters.`);
	};
	const pipeline = (item: unknown, path: string, source?: unknown): void => {
		if (!isRecord(item)) {
			errors.push(`${path} must be a pipeline object.`);
			return;
		}
		if ('pipeline' in item || !Array.isArray(item.components) || item.components.length < 1 || item.components.length > 500) {
			errors.push(`${path} must be a flat snapshot with 1 to 500 components.`);
			return;
		}
		const ids = item.components.map((component) => (isRecord(component) ? component.id : undefined));
		if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) errors.push(`${path} needs unique, nonempty component IDs.`);
		if (source !== undefined && !ids.includes(source)) errors.push(`${path} does not contain the selected source.`);
	};
	if (!object(value, ['schemaVersion', 'name', 'projectId', 'pipeline', 'source', 'inputMode', 'environment', 'datasetName', 'cases', 'scorers', 'repetitions', 'passCriteria'], 'spec')) return errors;
	if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
	const finite = (item: unknown): boolean => (typeof item === 'number' ? Number.isFinite(item) : Array.isArray(item) ? item.every(finite) : isRecord(item) ? Object.values(item).every(finite) : true);
	if (!finite(value)) errors.push('The spec must contain only finite JSON numbers.');
	if (new TextEncoder().encode(JSON.stringify(value)).length > 1048576) errors.push('The spec exceeds one MiB.');
	for (const key of ['name', 'projectId', 'source', 'datasetName']) text(value[key], key);
	pipeline(value.pipeline, 'pipeline', value.source);
	if (isRecord(value.pipeline) && value.pipeline.project_id !== value.projectId) errors.push('pipeline.project_id must match projectId.');
	if (!['chat', 'text'].includes(String(value.inputMode))) errors.push('inputMode must be chat or text.');
	if (!['development', 'staging'].includes(String(value.environment))) errors.push('environment must be development or staging.');
	if (!Number.isInteger(value.repetitions) || Number(value.repetitions) < 1 || Number(value.repetitions) > 10) errors.push('repetitions must be an integer from 1 to 10.');
	if (object(value.passCriteria, ['minimumPassRate', 'maxRegressions'], 'passCriteria')) {
		const rate = value.passCriteria.minimumPassRate;
		if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) errors.push('minimumPassRate must be between 0 and 1.');
		if (!Number.isInteger(value.passCriteria.maxRegressions) || Number(value.passCriteria.maxRegressions) < 0) errors.push('maxRegressions must be a nonnegative integer.');
	}
	const checkIds = (items: unknown[], path: string): void => {
		const ids = new Set<string>();
		items.forEach((item, index) => {
			if (!isRecord(item)) return;
			text(item.id, `${path}[${index + 1}].id`);
			if (typeof item.id === 'string') {
				if (ids.has(item.id)) errors.push(`${path}: duplicate id ${item.id}.`);
				ids.add(item.id);
			}
		});
	};
	if (!Array.isArray(value.cases)) errors.push('cases must be an array.');
	else {
		if (value.cases.length > 200) errors.push('A dataset can contain at most 200 cases.');
		if (value.cases.length * Number(value.repetitions) > 1000) errors.push('A run can contain at most 1000 case trials.');
		checkIds(value.cases, 'cases');
		value.cases.forEach((item, index) => {
			const path = `cases[${index + 1}]`;
			if (!object(item, ['id', 'name', 'input', 'reference', 'approved', 'tags', 'provenance'], path)) return;
			text(item.name, `${path}.name`);
			text(item.input, `${path}.input`, false, 65536);
			if (item.reference !== undefined) text(item.reference, `${path}.reference`, false, 65536);
			if (typeof item.approved !== 'boolean') errors.push(`${path}.approved must be a boolean.`);
			if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 50 || item.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 256))) errors.push(`${path}.tags must be an array of at most 50 nonempty strings (256 characters each).`);
			if (item.provenance !== undefined && object(item.provenance, ['kind', 'trace'], `${path}.provenance`)) {
				text(item.provenance.kind, `${path}.provenance.kind`);
				const trace = item.provenance.trace;
				if (trace !== undefined && object(trace, ['projectId', 'source', 'runKind', 'traceId', 'chapter', 'environment'], `${path}.provenance.trace`)) {
					text(trace.projectId, `${path}.trace.projectId`);
					text(trace.source, `${path}.trace.source`);
					if (trace.runKind !== undefined) text(trace.runKind, `${path}.trace.runKind`);
					if (trace.traceId !== undefined && (!Number.isSafeInteger(trace.traceId) || Number(trace.traceId) < 1)) errors.push(`${path}.trace.traceId must be an actual positive numeric log sequence.`);
					if (trace.chapter !== undefined && (!Number.isSafeInteger(trace.chapter) || Number(trace.chapter) < 0)) errors.push(`${path}.trace.chapter must be a nonnegative integer.`);
					if (trace.environment !== undefined && trace.environment !== 'development' && trace.environment !== 'staging') errors.push(`${path}.trace.environment must be development or staging.`);
				}
			}
		});
	}
	if (!Array.isArray(value.scorers)) errors.push('scorers must be an array.');
	else {
		if (value.scorers.length > 20) errors.push('An evaluation can contain at most 20 scorers.');
		checkIds(value.scorers, 'scorers');
		value.scorers.forEach((item, index) => {
			const path = `scorers[${index + 1}]`;
			if (!object(item, ['id', 'name', 'kind', 'expected', 'path', 'threshold', 'rubric', 'judgePipeline'], path)) return;
			text(item.name, `${path}.name`);
			if (!(SCORER_KINDS as readonly unknown[]).includes(item.kind)) errors.push(`${path}.kind is unsupported.`);
			for (const key of ['expected', 'path', 'rubric']) if (item[key] !== undefined) text(item[key], `${path}.${key}`, key === 'rubric', 65536);
			if (item.threshold !== undefined && (typeof item.threshold !== 'number' || !Number.isFinite(item.threshold) || item.threshold < 0 || item.threshold > (item.kind === 'latency' ? 3600000 : 1))) errors.push(`${path}.threshold must be between 0 and ${item.kind === 'latency' ? 3600000 : 1}.`);
			if (item.judgePipeline !== undefined) {
				pipeline(item.judgePipeline, `${path}.judgePipeline`, isRecord(item.judgePipeline) ? item.judgePipeline.source : undefined);
				if (isRecord(item.judgePipeline)) text(item.judgePipeline.source, `${path}.judgePipeline.source`);
			}
		});
	}
	return errors;
}

/** Imported/proposed changes cannot acquire review authority. Unchanged reviewed cases retain it. */
export function retainReviews(next: EvaluationSpec, previous: EvaluationSpec): EvaluationSpec {
	const old = new Map(previous.cases.map((item) => [item.id, item]));
	return {
		...next,
		cases: next.cases.map((item) => {
			const before = old.get(item.id);
			return { ...item, approved: Boolean(before?.approved && item.approved && same({ ...before, approved: false }, { ...item, approved: false })) };
		}),
	};
}

export function parseSpec(text: string, previous: EvaluationSpec): EvaluationSpec {
	const value: unknown = JSON.parse(text);
	const errors = validateSpec(value);
	if (errors.length) throw new Error(errors.join('\n'));
	const next = value as EvaluationSpec;
	if (next.projectId !== previous.projectId || !same(next.pipeline, previous.pipeline)) throw new Error('The target pipeline is read-only here. Use “Use current canvas snapshot” to update it.');
	return retainReviews(next, previous);
}

/** RFC 4180 quoting, embedded newlines and escaped quotes; reject malformed input atomically. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let closed = false;
	const source = text.replace(/^\uFEFF/, '');
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (quoted) {
			if (c === '"') {
				if (source[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
					closed = true;
				}
			} else field += c;
		} else if (c === ',') {
			row.push(field);
			field = '';
			closed = false;
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && source[i + 1] === '\n') i++;
			row.push(field);
			if (row.some((cell) => cell.length)) rows.push(row);
			row = [];
			field = '';
			closed = false;
		} else if (c === '"' && field === '' && !closed) quoted = true;
		else {
			if (closed || c === '"') throw new Error('Malformed CSV quoting.');
			field += c;
		}
	}
	if (quoted) throw new Error('CSV has an unclosed quoted field.');
	row.push(field);
	if (row.some((cell) => cell.length)) rows.push(row);
	return rows;
}

export function importCases(text: string, format: 'json' | 'csv', existing: EvaluationCase[]): EvaluationCase[] {
	let values: unknown;
	if (format === 'json') values = JSON.parse(text);
	else {
		const [headers, ...rows] = parseCsv(text);
		if (!headers || !headers.includes('input')) throw new Error('CSV requires an input header; optional columns: id, name, reference, tags.');
		if (new Set(headers).size !== headers.length || headers.some((key) => !['id', 'name', 'input', 'reference', 'tags', 'approved', 'provenance'].includes(key))) throw new Error('CSV has duplicate or unsupported headers.');
		values = rows.map((row) => {
			if (row.length !== headers.length) throw new Error('Every CSV row must match the header length.');
			return Object.fromEntries(
				headers.map((key, i) => [
					key,
					key === 'tags'
						? row[i]
								.split(';')
								.map((tag) => tag.trim())
								.filter(Boolean)
						: key === 'provenance'
							? JSON.parse(row[i])
							: row[i],
				])
			);
		});
	}
	if (!Array.isArray(values) || !values.length) throw new Error('Import a nonempty JSON array of cases or a CSV file.');
	const ids = new Set(existing.map((item) => item.id));
	const imported = values.map((value, index) => {
		if (!isRecord(value) || Object.keys(value).some((key) => !['id', 'name', 'input', 'reference', 'approved', 'tags', 'provenance'].includes(key))) throw new Error(`Imported case ${index + 1} has unsupported fields.`);
		const item = value as Record<string, unknown>;
		const id = item.id === undefined || item.id === '' ? crypto.randomUUID() : item.id;
		if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new Error(`Imported case ${index + 1} needs a unique id. Existing cases are never overwritten.`);
		ids.add(id);
		if (typeof item.input !== 'string' || (item.reference !== undefined && typeof item.reference !== 'string')) throw new Error(`Imported case ${index + 1}: input and reference must be strings.`);
		if (item.name !== undefined && typeof item.name !== 'string') throw new Error(`Imported case ${index + 1}: name must be a string.`);
		if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string'))) throw new Error(`Imported case ${index + 1}: tags must be strings (CSV: separate with semicolons).`);
		return { id, name: (item.name as string) || `Imported case ${index + 1}`, input: item.input, ...(item.reference === undefined ? {} : { reference: item.reference as string }), approved: false, tags: (item.tags as string[]) ?? [], provenance: item.provenance === undefined ? { kind: 'import' } : (item.provenance as EvaluationCase['provenance']) };
	});
	// Validate imported evidence atomically before appending any row.
	const check = newSpec({ project_id: 'validation', components: [{ id: 'input', config: { mode: 'Source' } }] }, 'Import validation');
	const errors = validateSpec({ ...check, cases: [...existing, ...imported] });
	if (errors.length) throw new Error(errors.join('\n'));
	return imported;
}

export function specChanges(before: EvaluationSpec, after: EvaluationSpec): { field: string; before: unknown; after: unknown }[] {
	const changes: { field: string; before: unknown; after: unknown }[] = [];
	for (const key of Object.keys(after) as (keyof EvaluationSpec)[]) {
		if (key === 'cases' || key === 'scorers') {
			const previous = new Map(before[key].map((item) => [item.id, item]));
			for (const item of after[key]) {
				if (!same(previous.get(item.id), item)) changes.push({ field: `${key} / ${item.id}`, before: previous.get(item.id), after: item });
				previous.delete(item.id);
			}
			for (const [id, item] of previous) changes.push({ field: `${key} / ${id}`, before: item, after: undefined });
		} else if (!same(before[key], after[key])) changes.push({ field: key, before: before[key], after: after[key] });
	}
	return changes;
}

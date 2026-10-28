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
// SCENARIOS: load the data, and refuse what is broken before anything runs
// =============================================================================

/**
 * Loads the scenarios, references and inputs under `data/`, and validates all
 * of them up front. A scenario is invalid when its file breaks the format,
 * when its reference or an input is not there, when a check is of an unknown
 * kind or misses a field its kind needs, or when its reference solution fails
 * one of its own static checks. The runner reports every invalid scenario by
 * name and runs nothing.
 *
 * References are stored as JSON maps of workspace path to text.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './catalog';
import { RUN_KINDS, STATIC_KINDS, staticCheck } from './score';
import type { Scenario } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

const VARIABLE = /^ROCKETRIDE_[A-Z0-9_]+$/;

/** The fields each check kind needs besides id and kind. */
const NEEDS: Record<string, string[]> = {
	pipe_static_valid: ['path'],
	engine_validate: ['path'],
	providers_present: ['path'],
	providers_absent: ['path', 'providers'],
	reaches: ['path', 'from', 'to'],
	control: ['path', 'provider', 'classType', 'invoker'],
	config_value: ['path', 'provider', 'pointer'],
	any_config_matches: ['path', 'matches'],
	extract_fields: ['path', 'columns'],
	only_changed: ['globs'],
	outcome: ['equals'],
	canary_absent: ['surfaces'],
	run_output: ['path', 'send', 'expect'],
};

/** The surfaces canary_absent can scan. */
export const SURFACES = new Set(['model_questions', 'thinking', 'final_text', 'session_json', 'catalog', 'workspace_files']);

// =============================================================================
// LOADING
// =============================================================================

/** A workspace tree: path to text. */
export type Tree = Record<string, string>;

/**
 * The workspace a correct solution leaves: `references/<id>.json`.
 *
 * @param id - The scenario id.
 * @returns The files, or null when there is no reference.
 */
export function referenceTree(id: string): Tree | null {
	const file = path.join(DATA_DIR, 'references', `${id}.json`);
	if (!fs.existsSync(file)) return null;
	return (JSON.parse(fs.readFileSync(file, 'utf8')) as { files?: Tree }).files ?? null;
}

/** Every scenario file's id, sorted. */
export function scenarioIds(): string[] {
	return fs
		.readdirSync(path.join(DATA_DIR, 'scenarios'))
		.filter((f) => f.endsWith('.json'))
		.map((f) => f.slice(0, -5))
		.sort();
}

/**
 * Reads one scenario file as it stands (validate it before use).
 *
 * @param id - The scenario id.
 * @returns The scenario.
 */
export function loadScenario(id: string): Scenario {
	return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scenarios', `${id}.json`), 'utf8')) as Scenario;
}

/** An input file the runner sends to a saved pipeline. */
export function inputPath(file: string): string {
	return path.join(DATA_DIR, file);
}

// =============================================================================
// VALIDATION
// =============================================================================

/** One scenario's problems; empty when it is valid. */
export interface Validation {
	id: string;
	problems: string[];
	/** The reference's static checks: passed of counted. */
	reference: { passed: number; counted: number } | null;
}

/** The files a check's `send` reads. */
function sendFiles(send: unknown): string[] {
	if (!send || typeof send !== 'object') return [];
	return Object.values(send as Record<string, unknown>)
		.map((v) => (v && typeof v === 'object' ? (v as { file?: unknown }).file : undefined))
		.filter((f): f is string => typeof f === 'string');
}

/**
 * Checks one scenario against the format and its own reference.
 *
 * @param id - The scenario id (its file name).
 * @returns Its problems.
 */
export function validateScenario(id: string): Validation {
	const problems: string[] = [];
	let s: Scenario;
	try {
		s = loadScenario(id);
	} catch (err) {
		return { id, problems: [`does not parse: ${err instanceof Error ? err.message : String(err)}`], reference: null };
	}
	const need = (ok: unknown, what: string) => {
		if (!ok) problems.push(what);
	};
	need(s.id === id, `id ${JSON.stringify(s.id)} does not match the file name`);
	need(typeof s.prompt === 'string' && s.prompt.trim() !== '', 'prompt is empty');
	need(typeof s.followup?.text === 'string' && s.followup.text !== '' && Number.isInteger(s.followup.max) && s.followup.max >= 0, 'followup needs text and a max of 0 or more');
	need(Array.isArray(s.variables) && s.variables.every((v) => VARIABLE.test(v)), 'variables must be ROCKETRIDE_* names');

	// step: the checks
	need(Array.isArray(s.checks) && s.checks.length > 0, 'checks is empty');
	const ids = new Set<string>();
	for (const ck of s.checks ?? []) {
		const label = `check ${ck.id ?? '(no id)'}`;
		need(typeof ck.id === 'string' && ck.id !== '', `a check has no id`);
		need(!ids.has(ck.id), `${label} is listed twice`);
		ids.add(ck.id);
		if (!STATIC_KINDS.has(ck.kind) && !RUN_KINDS.has(ck.kind)) {
			problems.push(`${label} has unknown kind ${JSON.stringify(ck.kind)}`);
			continue;
		}
		for (const field of NEEDS[ck.kind] ?? []) need(ck[field] !== undefined && ck[field] !== null, `${label} (${ck.kind}) needs ${field}`);
		if (ck.kind === 'canary_absent') for (const surface of (ck.surfaces as string[]) ?? []) need(SURFACES.has(surface), `${label} names unknown surface ${surface}`);
		if (ck.kind === 'run_output') for (const file of sendFiles(ck.send)) need(fs.existsSync(inputPath(file)), `${label} sends ${file}, which does not exist`);
		for (const key of ['regex', 'matches']) {
			if (typeof ck[key] !== 'string') continue;
			try {
				new RegExp(String(ck[key]).replace(/^\(\?[imsx]+\)/, ''));
			} catch {
				problems.push(`${label} ${key} is not a valid regex`);
			}
		}
	}

	// step: the reference must pass its own static checks
	let reference: Validation['reference'] = null;
	const final = referenceTree(id);
	if (!final) problems.push(`references/${id}.json does not exist`);
	else {
		const statics = (s.checks ?? []).filter((ck) => STATIC_KINDS.has(ck.kind));
		let passed = 0;
		for (const ck of statics) {
			const v = staticCheck(ck, final);
			if (v.ok) passed++;
			else problems.push(`reference fails its check ${ck.id}${v.msg ? ` (${v.msg.slice(0, 160)})` : ''}`);
		}
		reference = { passed, counted: statics.length };
	}
	return { id, problems, reference };
}

/**
 * Validates every scenario.
 *
 * @returns One validation per scenario file, sorted by id.
 */
export function validateAll(): Validation[] {
	return scenarioIds().map(validateScenario);
}

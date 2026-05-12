/**
 * Manages coverage-exclusions.json: nodes the harness deliberately doesn't
 * exercise, each with a reason.
 *
 * Validator rules:
 *   - node must exist in /services (rejects stale)
 *   - reason must be >= 3 words (rejects placeholders)
 *   - entries older than 90 days emit a warning (not failure)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

export type ExclusionEntry = {
	node: string;
	reason: string;
	owner?: string;
	added?: string; // ISO date
};

export type ExclusionsFile = {
	version: 1;
	exclusions: ExclusionEntry[];
};

export type ExclusionWarning = {
	node: string;
	message: string;
};

export type ExclusionValidationResult = {
	excluded: Map<string, ExclusionEntry>;
	stale: string[];
	thinReason: string[];
	staleWarnings: ExclusionWarning[];
};

const STALE_THRESHOLD_DAYS = 90;
const MIN_REASON_WORDS = 3;

export function loadExclusions(filePath: string): ExclusionsFile {
	if (!existsSync(filePath)) {
		return { version: 1, exclusions: [] };
	}
	const raw = readFileSync(filePath, 'utf8');
	const parsed = JSON.parse(raw) as ExclusionsFile;
	if (parsed.version !== 1) {
		throw new Error(`Unsupported exclusions version: ${parsed.version}`);
	}
	if (!Array.isArray(parsed.exclusions)) {
		throw new Error('exclusions field must be an array');
	}
	return parsed;
}

export function validateExclusions(
	file: ExclusionsFile,
	knownNodes: Set<string>,
	now: Date = new Date(),
): ExclusionValidationResult {
	const excluded = new Map<string, ExclusionEntry>();
	const stale: string[] = [];
	const thinReason: string[] = [];
	const staleWarnings: ExclusionWarning[] = [];

	for (const entry of file.exclusions) {
		if (!knownNodes.has(entry.node)) {
			stale.push(entry.node);
			continue;
		}
		const reasonWords = (entry.reason ?? '').trim().split(/\s+/).filter(Boolean);
		if (reasonWords.length < MIN_REASON_WORDS) {
			thinReason.push(entry.node);
			continue;
		}
		excluded.set(entry.node, entry);

		if (entry.added) {
			const added = new Date(entry.added);
			if (!Number.isNaN(added.getTime())) {
				const ageMs = now.getTime() - added.getTime();
				const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
				if (ageDays > STALE_THRESHOLD_DAYS) {
					staleWarnings.push({
						node: entry.node,
						message: `excluded ${ageDays} days ago (added ${entry.added}); review whether still needed`,
					});
				}
			}
		}
	}

	return { excluded, stale, thinReason, staleWarnings };
}

export function writeStarterExclusions(filePath: string, knownNodes: Set<string>, owner: string): void {
	const today = new Date().toISOString().slice(0, 10);
	const entries: ExclusionEntry[] = Array.from(knownNodes)
		.sort()
		.map((node) => ({
			node,
			reason: 'TODO: explain why this node cannot be exercised by the harness.',
			owner,
			added: today,
		}));

	const file: ExclusionsFile = { version: 1, exclusions: entries };
	writeFileSync(filePath, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

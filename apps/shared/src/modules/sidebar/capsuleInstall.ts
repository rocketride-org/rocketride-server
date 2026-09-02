// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// Installing a capsule, as a sequence the UI can show.
//
// A capsule is Python the engine will import, so the install is not one opaque
// call: it is read, inspected, shown to a person, and only then written. Each
// stage is reported as it happens, so a host can render what is going on and
// say what failed when something does — rather than a spinner that ends in
// silence either way.
//
// Host-agnostic on purpose: the caller supplies the two engine calls and the
// confirmation, so the same sequence drives the web sidebar and the VS Code
// one, and can be tested without either.
// =============================================================================

/** What `rrext_node_dev inspect` reports about a capsule. */
export interface ICapsuleReport {
	name: string;
	protocol: string;
	version?: string;
	declares?: string[];
	sizeBytes?: number;
	totalBytes?: number;
	files?: { path: string; bytes: number }[];
	binaryFiles?: string[];
	/** False when the node would not register — the engine could not load it. */
	ok?: boolean;
	errors?: string[];
	warnings?: string[];
}

/** The stages an install passes through, in order. */
export type CapsuleStageId = 'read' | 'inspect' | 'confirm' | 'install';

export type CapsuleStageState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface ICapsuleStage {
	id: CapsuleStageId;
	label: string;
	state: CapsuleStageState;
	/** Populated on failure, or with a short summary on success. */
	detail?: string;
}

export interface ICapsuleInstallResult {
	/** 'installed' | 'cancelled' | 'rejected' (would not load) | 'failed'. */
	outcome: 'installed' | 'cancelled' | 'rejected' | 'failed';
	report?: ICapsuleReport;
	error?: string;
	stages: ICapsuleStage[];
}

export interface ICapsuleInstallIO {
	/** Calls `rrext_node_dev inspect` — must not write anything. */
	inspect: (capsuleBase64: string) => Promise<ICapsuleReport>;
	/** Calls `rrext_node_dev install`. */
	install: (capsuleBase64: string) => Promise<unknown>;
	/** Shows the report and returns whether the person accepted it. */
	confirm: (report: ICapsuleReport) => Promise<boolean>;
	/** Called after every stage change so the host can re-render. */
	onProgress?: (stages: ICapsuleStage[]) => void;
}

const STAGE_LABELS: Record<CapsuleStageId, string> = {
	read: 'Reading capsule',
	inspect: 'Checking contents',
	confirm: 'Awaiting confirmation',
	install: 'Installing',
};

const STAGE_ORDER: CapsuleStageId[] = ['read', 'inspect', 'confirm', 'install'];

/** A fresh stage list, everything pending. */
export function initialStages(): ICapsuleStage[] {
	return STAGE_ORDER.map((id) => ({ id, label: STAGE_LABELS[id], state: 'pending' as CapsuleStageState }));
}

/**
 * Read, inspect, confirm and install a capsule, reporting each stage.
 *
 * Nothing is written until the report has been shown and accepted, and a
 * capsule the engine could not load is refused outright — installing one only
 * leaves a node in the store that never registers.
 *
 * @param io - the engine calls, the confirmation, and the progress sink.
 * @param capsuleBase64 - the `.rrc` bytes, base64-encoded.
 * @returns the outcome, the report when one was obtained, and the final stages.
 */
export async function installCapsule(io: ICapsuleInstallIO, capsuleBase64: string): Promise<ICapsuleInstallResult> {
	const stages = initialStages();
	const at = (id: CapsuleStageId) => stages[STAGE_ORDER.indexOf(id)]!;
	const emit = () => io.onProgress?.(stages.map((stage) => ({ ...stage })));
	const set = (id: CapsuleStageId, state: CapsuleStageState, detail?: string) => {
		const stage = at(id);
		stage.state = state;
		if (detail !== undefined) stage.detail = detail;
		emit();
	};
	const finish = (outcome: ICapsuleInstallResult['outcome'], extra: Partial<ICapsuleInstallResult> = {}) => {
		for (const stage of stages) if (stage.state === 'pending') stage.state = 'skipped';
		emit();
		return { outcome, stages: stages.map((stage) => ({ ...stage })), ...extra };
	};

	set('read', 'active');
	if (!capsuleBase64) {
		set('read', 'failed', 'no capsule was provided');
		return finish('failed', { error: 'no capsule was provided' });
	}
	set('read', 'done', `${formatBytes(base64Bytes(capsuleBase64))} read`);

	set('inspect', 'active');
	let report: ICapsuleReport;
	try {
		report = await io.inspect(capsuleBase64);
	} catch (err) {
		const message = errorText(err);
		set('inspect', 'failed', message);
		return finish('failed', { error: message });
	}

	const fileCount = report.files?.length ?? 0;
	if (report.ok === false) {
		const why = report.errors?.join('; ') || 'the node would not load';
		set('inspect', 'failed', why);
		return finish('rejected', { report, error: why });
	}
	set('inspect', 'done', `${report.name} · ${fileCount} file${fileCount === 1 ? '' : 's'}`);

	set('confirm', 'active');
	let accepted = false;
	try {
		accepted = await io.confirm(report);
	} catch (err) {
		const message = errorText(err);
		set('confirm', 'failed', message);
		return finish('failed', { report, error: message });
	}
	if (!accepted) {
		set('confirm', 'skipped', 'cancelled');
		return finish('cancelled', { report });
	}
	set('confirm', 'done');

	set('install', 'active');
	try {
		await io.install(capsuleBase64);
	} catch (err) {
		const message = errorText(err);
		set('install', 'failed', message);
		return finish('failed', { report, error: message });
	}
	set('install', 'done', `${report.name} is in the palette`);
	return finish('installed', { report });
}

/** Decoded size of a base64 payload, without decoding it. */
export function base64Bytes(value: string): number {
	const clean = value.replace(/=+$/, '');
	return Math.floor((clean.length * 3) / 4);
}

/** Bytes as a short human string: 812 B, 3.2 KB, 1.4 MB. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

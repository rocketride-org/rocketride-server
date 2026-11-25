// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * What an agent's sources are and what they take, from the contract read
 * (`client.interfaces(address)`): its `sources` say, by each source's own
 * address, what the source's service declares about it — its kind, how a
 * request reaches it, its title and the lanes it declares on `_source`.
 *
 * A source's KIND is its service's `sourceKind` (the server reads a service
 * that declares none as a scan); only a `request` source is ever sent to.
 * What a source TAKES is a stand-in until the server works it out from how
 * the pipeline is wired (Playground plan v2, section 3): the lanes its
 * service declares on `_source`.
 *
 * Pure functions over plain data, so node:test drives them directly.
 */

import type { AgentSource, SourceEntry, SourceKind, TypedLane } from './model';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Typed-input lanes, in the order typed text prefers them. */
const TYPED_LANES: TypedLane[] = ['questions', 'text', 'json'];

/** The lanes that carry files. `tags` takes any file (the parser reads it). */
const FILE_LANES = ['tags', 'image', 'audio', 'video'];

/** The MIME type that selects each typed lane at the server's door. */
export const TYPED_MIME: Record<TypedLane, string> = {
	questions: 'application/rocketride-question',
	text: 'text/plain',
	json: 'application/json',
};

// =============================================================================
// INPUT SHAPES
// =============================================================================

/** One source of the contract read's `sources`, as the server describes it. */
export interface SourceLike {
	nodeId: string;
	name: string;
	title: string;
	kind: SourceKind;
	entry: SourceEntry;
	lanes: string[];
}

/** The contract read's `sources`: source address → its description. */
export type SourceMap = Record<string, SourceLike | null | undefined>;

// =============================================================================
// SOURCES
// =============================================================================

/**
 * Every source of an agent, in the order the contract read lists them.
 *
 * @param sources - The contract read's `sources` (absent from a server that predates it: no sources).
 * @returns The sources.
 */
export function describeSources(sources: SourceMap | undefined): AgentSource[] {
	const out: AgentSource[] = [];
	for (const [address, source] of Object.entries(sources ?? {})) {
		if (!source || typeof source.nodeId !== 'string') continue;
		const lanes = Array.isArray(source.lanes) ? source.lanes : [];
		out.push({
			address,
			nodeId: source.nodeId,
			name: source.name || source.nodeId,
			title: source.title || source.name || source.nodeId,
			kind: source.kind,
			entry: source.entry,
			lanes,
			typed: TYPED_LANES.find((l) => lanes.includes(l)) ?? null,
			fileLanes: FILE_LANES.filter((l) => lanes.includes(l)),
		});
	}
	return out;
}

/**
 * The source a connection talks to: the one the address names, else the
 * pipe's default source, else the first source that takes data requests,
 * else the first source (whose page then says it works on its own).
 *
 * @param sources - The agent's sources.
 * @param address - The address the connection was opened with.
 * @param defaultSource - The listing's default source id, if known.
 * @returns The source, or null for an agent with none.
 */
export function pickSource(sources: AgentSource[], address: string, defaultSource?: string): AgentSource | null {
	const named = sources.find((s) => s.address === address);
	if (named) return named;
	if (defaultSource) {
		const byDefault = sources.find((s) => s.nodeId === defaultSource || s.address.endsWith(`.${defaultSource}`));
		if (byDefault) return byDefault;
	}
	return sources.find((s) => s.kind === 'request' && s.entry === 'data') ?? sources[0] ?? null;
}

/**
 * The other sources a caller can send to, for "use it another way".
 *
 * @param sources - The agent's sources.
 * @param current - The connection's source.
 * @returns The request sources entered by data, other than `current`.
 */
export function otherWaysIn(sources: AgentSource[], current: AgentSource | null): AgentSource[] {
	return sources.filter((s) => s !== current && s.kind === 'request' && s.entry === 'data');
}

// =============================================================================
// WHAT A SOURCE TAKES
// =============================================================================

/**
 * Whether the source takes files at all.
 *
 * @param source - The source.
 * @returns True when it declares a file lane.
 */
export function takesFiles(source: AgentSource): boolean {
	return source.fileLanes.length > 0;
}

/**
 * Whether the source takes this file: any file when it declares `tags` (the
 * parser reads it), else only a file whose MIME type names a declared media
 * lane (`image/…` on `image`).
 *
 * @param source - The source.
 * @param mime - The file's MIME type ('' when the browser could not tell).
 * @returns True when the file is taken.
 */
export function takesFile(source: AgentSource, mime: string): boolean {
	if (source.fileLanes.includes('tags')) return true;
	const family = mime.split('/')[0];
	return ['image', 'audio', 'video'].includes(family) && source.fileLanes.includes(family);
}

/**
 * The media words for what a media-only source takes ("images", "images and
 * audio").
 *
 * @param source - The source.
 * @returns The words, or '' when it takes any file.
 */
export function mediaWords(source: AgentSource): string {
	if (source.fileLanes.includes('tags')) return '';
	const words = source.fileLanes.map((l) => (l === 'image' ? 'images' : l === 'audio' ? 'audio' : 'videos'));
	return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The one-line "Takes …" hint under the bottom bar.
 *
 * @param source - The source.
 * @returns The hint.
 */
export function takesHint(source: AgentSource): string {
	const files = takesFiles(source);
	const media = mediaWords(source);
	const fileWords = media ? media : 'any file';
	if (source.typed && files) return `Takes questions and ${fileWords}.`;
	if (files) return media ? `Takes ${media}. You can drop several at once.` : 'Takes any file. You can drop several at once.';
	return '';
}

/**
 * The noun for what a media-only source takes, for a refusal ("isn't an
 * image").
 *
 * @param source - The source.
 * @returns The phrase.
 */
export function mediaNoun(source: AgentSource): string {
	const lanes = source.fileLanes;
	if (lanes.length === 1) return lanes[0] === 'image' ? 'an image' : lanes[0] === 'audio' ? 'audio' : 'a video';
	return 'a file it takes';
}

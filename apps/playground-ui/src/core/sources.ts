// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * What an agent's sources are and what they take, from two reads the client
 * already has: the contract read (`client.interfaces(address)`, each source
 * under its own address with the catalog classTypes it carries) and the
 * services catalog (each service's classTypes and declared lanes).
 *
 * Two facts here are stand-ins until the server reports them (Playground
 * plan v2, section 3): a source's KIND, which its service will declare as
 * `sourceKind`, and what it TAKES, which the server will work out from how
 * the pipeline is wired. Until then a source is a request source only when
 * it carries a classType of the webhook node's request services (the safe
 * default: anything else is never sent to), and it takes what its service
 * declares on `_source`.
 *
 * Pure functions over plain data, so node:test drives them directly.
 */

import type { AgentSource, SourceEntry, SourceKind, TypedLane } from './model';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The classTypes of the services whose every unit of work is a caller's request. */
const REQUEST_CLASS_TYPES = ['chat', 'dropper', 'webhook', 'tools'];

/** The classType of a source entered by tool calls. */
const TOOL_CLASS_TYPE = 'tools';

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

/** One node of the contract read's interface map. */
export interface InterfaceNode {
	nodeId: string;
	name: string;
}

/** The contract read's interface map: address → classType → nodes. */
export type InterfaceMap = Record<string, Record<string, ReadonlyArray<InterfaceNode | null | undefined> | undefined>>;

/** The part of a service summary this module reads. */
export interface ServiceLike {
	title: string;
	classType: string[];
	lanes?: Record<string, string[]>;
}

// =============================================================================
// SOURCES
// =============================================================================

/**
 * The service a source's classTypes name, when exactly one service carries
 * that classType set; otherwise undefined (several services share `source`
 * alone, and the Playground never guesses between them).
 *
 * @param classTypes - The source's classTypes.
 * @param services - The services catalog, by name.
 * @returns The matching service, or undefined.
 */
export function serviceFor(classTypes: string[], services: Record<string, ServiceLike>): ServiceLike | undefined {
	const key = [...classTypes].sort().join('|');
	const matches = Object.values(services).filter((s) => [...(s.classType ?? [])].sort().join('|') === key);
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Every source of an agent, in the order the interface map lists them.
 *
 * @param interfaces - The contract read's interface map.
 * @param services - The services catalog, by name.
 * @returns The sources.
 */
export function describeSources(interfaces: InterfaceMap, services: Record<string, ServiceLike>): AgentSource[] {
	const out: AgentSource[] = [];
	for (const [address, byClass] of Object.entries(interfaces ?? {})) {
		// step: a source sits under its own address with the `source` classType
		const node = (byClass?.source ?? []).find((n): n is InterfaceNode => !!n && typeof n.nodeId === 'string');
		if (!node) continue;
		const classTypes = Object.keys(byClass ?? {});

		// step: its service's declared lanes and title, when one service matches
		const service = serviceFor(classTypes, services);
		const lanes = service?.lanes?._source ?? [];
		const kind: SourceKind = classTypes.some((c) => REQUEST_CLASS_TYPES.includes(c)) ? 'request' : 'onItsOwn';
		const entry: SourceEntry = classTypes.includes(TOOL_CLASS_TYPE) ? 'tool' : 'data';

		out.push({
			address,
			nodeId: node.nodeId,
			name: node.name || node.nodeId,
			title: service?.title || node.name || node.nodeId,
			classTypes,
			kind,
			entry,
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

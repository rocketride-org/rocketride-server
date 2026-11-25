// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.

// SOURCE ENDPOINT — the endpoint info of a PUBLISHED source (the Catalog)
//
// A running source tells its endpoint in a status note (see
// `IEndpointInfo`). A published pipe is not running: the Catalog knows a
// source from `client.interfaces()` alone, by its address, its component id
// and the interfaces it carries (`webhook`, `chat`, `dropper`). This module
// says what the endpoint dialog shows for such a source, in the note's own
// shape, so the one dialog serves both.
//
// Pure: tested without React.

import type { IEndpointInfo } from './PipelineActions';
import { OPEN_TOOL_LABELS } from './openTool';

/** The front end of each source interface that has one: the Playground fronts both. */
const SOURCE_TOOLS: Readonly<Record<string, string>> = {
	chat: 'rocketride.playground',
	dropper: 'rocketride.playground',
};

/** A published source as the Catalog knows it. */
export interface IPublishedSource {
	/** The source's own address, `developerId.pipeId.source`. */
	address: string;
	/** The source's component id. */
	nodeId: string;
	/** The interfaces the source carries besides `source`. */
	interfaces: readonly string[];
}

/**
 * The endpoint info of a published source.
 *
 * A webhook has a data door, `{host}/webhook/<address>` (the one path form
 * the door accepts); a chat or dropper source has no URL, only the front end
 * that talks to it by address. Any other source (a tools host, a custom
 * source) has no endpoint to show.
 *
 * @param source - The source.
 * @returns The info for the endpoint dialog, or null when the source has none.
 */
export function publishedSourceEndpoint(source: IPublishedSource): IEndpointInfo | null {
	if (source.interfaces.includes('webhook')) {
		return { 'url-text': 'Endpoint URL', 'url-link': `{host}/webhook/${source.address}`, address: source.address };
	}
	for (const name of source.interfaces) {
		const appId = SOURCE_TOOLS[name];
		if (appId) return { 'button-text': OPEN_TOOL_LABELS[appId], 'open-tool': appId, nodeId: source.nodeId, address: source.address };
	}
	return null;
}

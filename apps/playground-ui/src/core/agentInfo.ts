// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Reading one agent: the contract read for its sources (what each source's
 * service declares about it) and settings, and the pipe catalog for its
 * listing (name, tagline, icon, README, default source). Two reads the
 * client already has; nothing here starts an engine.
 */

import type { RocketRideClient } from 'shell';
import type { AgentInfo, AgentListing, AgentParameter } from './model';
import { nameFromAddress } from './friendly';
import { describeSources, pickSource } from './sources';

// =============================================================================
// TYPES
// =============================================================================

/** One pipe catalog row, as `rrext_public_catalog {kind: 'pipe'}` returns it. */
interface CatalogRow {
	id?: string;
	name?: string;
	tagline?: string;
	description?: string;
	icon?: string;
	readme?: string;
	defaultSource?: string;
	publisher?: string;
}

/** One catalog page. */
interface CatalogPage {
	apps?: CatalogRow[];
}

// =============================================================================
// CACHES
// =============================================================================

/** Listings already found, by pipe address. */
const listings = new Map<string, AgentListing | null>();

// =============================================================================
// READS
// =============================================================================

/**
 * A catalog row as a listing.
 *
 * @param row - The row.
 * @param pipe - The pipe address (the name's fallback).
 * @returns The listing.
 */
function listingOf(row: CatalogRow, pipe: string): AgentListing {
	return {
		name: row.name || nameFromAddress(pipe),
		tagline: row.tagline || row.description || undefined,
		icon: row.icon || undefined,
		readme: row.readme || undefined,
		defaultSource: row.defaultSource || undefined,
		publisher: row.publisher || undefined,
	};
}

/**
 * An agent's listing: the caller's own-org publications first, then a store
 * search by its pipeline id. Null for an unlisted agent (a Play run, or a
 * version whose store block is not listed).
 *
 * @param client - The realm's client.
 * @param pipe - The pipe address (`developerId.pipelineId`).
 * @returns The listing, or null.
 */
export async function findListing(client: RocketRideClient, pipe: string): Promise<AgentListing | null> {
	if (listings.has(pipe)) return listings.get(pipe) ?? null;

	// step: the caller's own organization's publications
	const own = await client.call<CatalogPage>('rrext_public_catalog', { kind: 'pipe', offset: 0, limit: 100 });
	let row = own?.apps?.find((r) => r.id === pipe);

	// step: else the store, searched by the pipeline id
	if (!row) {
		const pipeId = pipe.split('.')[1];
		if (pipeId) {
			const found = await client.call<CatalogPage>('rrext_public_catalog', { kind: 'pipe', search: pipeId, offset: 0, limit: 20 });
			row = found?.apps?.find((r) => r.id === pipe);
		}
	}

	const listing = row ? listingOf(row, pipe) : null;
	listings.set(pipe, listing);
	return listing;
}

/**
 * Everything the Playground needs about one agent.
 *
 * @param client - The realm's client.
 * @param address - The address the connection was opened with (bare or naming a source).
 * @returns The agent.
 */
export async function loadAgent(client: RocketRideClient, address: string): Promise<AgentInfo> {
	// step: the contract read resolves the address for this caller
	const answer = await client.interfaces(address);

	// step: the listing (a failed read never hides the agent)
	const listing = await findListing(client, answer.address).catch(() => null);

	const sources = describeSources(answer.sources);
	return {
		pipe: answer.address,
		listing: listing ?? { name: nameFromAddress(answer.address) },
		rung: answer.rung,
		version: answer.version,
		teamId: answer.teamId,
		sources,
		source: pickSource(sources, address, listing?.defaultSource),
		parameters: (answer.parameters ?? []) as AgentParameter[],
	};
}

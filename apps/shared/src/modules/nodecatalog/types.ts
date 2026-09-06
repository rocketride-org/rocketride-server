// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// Node catalog — the shapes the engine hands back and the host must supply.
//
// Deliberately the same anatomy as an app store entry (title, description,
// publisher, categories, icon, price), because the catalog is the app store's
// sibling and should read like it. What differs is what an entry *is*: an app
// is opened, a node is installed into your own workspace and then appears in
// the pipeline palette.
// =============================================================================

/** One node as the catalog lists it — the card's data. */
export interface INodeCatalogEntry {
	/** Node name; also its frozen protocol id. */
	name: string;
	/** Display title, from the node's own services.json. */
	title: string;
	description: string;
	/** From the node's classType — the store category. */
	categories: string[];
	/** Inline SVG the node ships, or '' when it has none. */
	icon: string;
	author: { id?: string; name?: string; email?: string };
	/** 0 is free. Recorded by the registry; charging is the billing layer's job. */
	priceCents: number;
	state: 'published' | 'removed' | string;
	/** Latest version number, and the author's label for it. */
	latest?: number;
	versionLabel?: string;
	sizeBytes?: number;
	publishedAt?: number;
}

/** The detail view adds the version history. */
export interface INodeCatalogDetail extends INodeCatalogEntry {
	versions?: {
		version: number;
		label?: string;
		sha256: string;
		sizeBytes?: number;
		publishedAt?: number;
		publishedBy?: { name?: string };
	}[];
}

/** What the host wires up: the engine calls and the install action. */
export interface INodeCatalogHost {
	/** `rrext_node_catalog list`. */
	list: (search?: string) => Promise<INodeCatalogEntry[]>;
	/** `rrext_node_catalog get`. */
	get: (name: string) => Promise<INodeCatalogDetail>;
	/**
	 * Install a catalog node into this user's own store.
	 *
	 * Fetches the capsule and runs it through the staged install, so the caller
	 * sees the same reported sequence as importing a file by hand.
	 */
	install: (entry: INodeCatalogEntry) => Promise<void>;
	/** Names already installed in this user's store, so cards can say so. */
	installed: string[];
}

/** Free, or a price the card can print. */
export function priceLabel(priceCents: number): string {
	if (!priceCents) return 'Free';
	const units = priceCents / 100;
	return units % 1 === 0 ? `$${units}` : `$${units.toFixed(2)}`;
}

/** Category key to the title a person reads, matching the app store's casing. */
export function categoryLabel(key: string): string {
	if (!key) return 'Other';
	return key.charAt(0).toUpperCase() + key.slice(1).replace(/[_-]+/g, ' ');
}

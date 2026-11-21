// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The canvas gate — what the DESIGN view shows in the canvas's place while no
 * node catalog has loaded.
 *
 * The canvas draws a pipeline's lanes, edges, palette and config forms from
 * the server's node definitions. Without them it shows bare boxes, and an
 * edit made there is written back without the parts it could not draw. So
 * until the editor has held a catalog the view says why it is missing and
 * what fixes it: sign in, connect, wait, or look at the engine. Once a
 * catalog has loaded the editor keeps it (a later empty reply never takes the
 * canvas away), so the gate opens once per editor.
 *
 * Everything that DECIDES lives here so it is testable without a canvas or a
 * connection; the editor frame gathers the facts and ProjectView renders the
 * result as the shell's EmptyState.
 */

import { catalogueDiagnostic } from '../../utils/catalogueDiagnostic';
import type { CataloguePayload } from '../../utils/catalogueDiagnostic';

// =============================================================================
// Types
// =============================================================================

/** The connection facts the gate reads (a slice of the shell's ConnectionStatus). */
export interface IGateConnection {
	/** A client can reach the server. */
	connected: boolean;
	/** A connection attempt is under way. */
	connecting: boolean;
	/** A connection target and credentials are configured. */
	hasCredentials: boolean;
	/** The last unrecovered failure, latched across later transitions. */
	failure?: {
		/** `auth`: the credentials were refused or expired; `network`: the transport failed. */
		kind: 'network' | 'auth';
		/** The failure's message, when one was given. */
		lastError?: string;
	};
}

/** What the DESIGN view shows instead of the canvas. */
export interface ICatalogGate {
	/** The heading. */
	title: string;
	/** Why the canvas is not shown, and what opens it. */
	description: string;
	/** Offer the host's connection settings (where the fix is a sign-in or a connection). */
	offerSettings: boolean;
}

// =============================================================================
// The decision
// =============================================================================

/** The message a failure carries, trimmed of a trailing period; '' for none. */
function errorText(failure: IGateConnection['failure']): string {
	return (failure?.lastError ?? '').trim().replace(/\.+$/, '');
}

/**
 * Decides whether the canvas shows, and what stands in for it when it does not.
 *
 * @param catalogCount - How many node definitions the editor holds.
 * @param connection - The connection's state.
 * @param catalogue - The last catalog reply the editor saw, or null while none
 *        has arrived (a request still in flight).
 * @returns Null when the canvas shows; otherwise what the view says instead.
 */
export function catalogGate(catalogCount: number, connection: IGateConnection, catalogue: CataloguePayload | null): ICatalogGate | null {
	// Step 1: a catalog is held: the canvas shows
	if (catalogCount > 0) return null;

	// Step 2: no server to ask. A refused sign-in first: it is the one failure
	// a retry never fixes
	if (!connection.connected) {
		const error = errorText(connection.failure);
		if (connection.failure?.kind === 'auth') {
			return {
				title: 'Sign-in required',
				description: `The server refused the saved credentials${error ? ` (${error})` : ''}. The canvas opens once you sign in again and the node definitions load.`,
				offerSettings: true,
			};
		}
		if (connection.connecting) {
			return {
				title: 'Connecting to the server',
				description: `The canvas opens once the node definitions load.${error ? ` The last attempt failed: ${error}.` : ''}`,
				offerSettings: Boolean(connection.failure),
			};
		}
		if (!connection.hasCredentials) {
			return {
				title: 'Not connected',
				description: 'The canvas needs the node definitions from a RocketRide server, and no connection is set up yet.',
				offerSettings: true,
			};
		}
		return {
			title: 'Not connected',
			description: `The canvas needs the node definitions from a RocketRide server.${error ? ` The last attempt failed: ${error}.` : ''}`,
			offerSettings: true,
		};
	}

	// Step 3: the server answered without a catalog: say what it said
	const diagnostic = catalogue ? catalogueDiagnostic(catalogue) : null;
	if (diagnostic) {
		return { title: 'The canvas cannot open', description: diagnostic.cause, offerSettings: diagnostic.level === 'error' };
	}

	// Step 4: asked, not answered yet
	return { title: 'Loading the node definitions', description: 'The canvas opens as soon as the server sends them.', offerSettings: false };
}

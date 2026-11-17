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

/**
 * The endpoint modal's key minter (mockup 3.5, plan §2.4).
 *
 * A machine caller of a webhook holds the OWNER's scoped account key in the
 * Authorization header: `task.data` only, this one endpoint address, the
 * owner's home team frozen at mint. The modal mints that key itself — one
 * button, shown once, listed in Settings › Account › API Keys where it is
 * revoked. Both hosts (rocket-ui holding the client; VS Code answering the
 * `host.pipeline.createEndpointKey` op on the extension side) call this one
 * function, so the key's shape has one home.
 */

import type { ConnectResult, CreateKeyParams } from 'rocketride';

// =============================================================================
// Types
// =============================================================================

/** What the minter answers: the raw key (shown once) and how it is listed. */
export interface IMintedEndpointKey {
	/** The full `rr_` key. Never stored client-side; the modal shows it once. */
	key: string;
	/** The key's name as the API Keys list shows it. */
	name: string;
	/** The team the key is frozen to (null = no team: the key follows the owner's team order). */
	teamId: string | null;
}

/** The host seam the modal calls: mint the scoped key for one address. */
export type EndpointKeyMinter = (address: string) => Promise<IMintedEndpointKey>;

/** The slice of the SDK client the minter needs. */
export interface IEndpointKeyClient {
	/** The account info the connection authenticated with. */
	getAccountInfo(): ConnectResult | undefined;
	account: {
		/** Mints an API key; answers the raw key once. */
		createKey(params: CreateKeyParams): Promise<{ key: string }>;
	};
}

// =============================================================================
// Helpers
// =============================================================================

/** The permission a webhook caller needs: send data, nothing else. */
export const ENDPOINT_KEY_PERMISSIONS: readonly string[] = ['task.data'];

/**
 * Names the key after its endpoint so the API Keys list reads as the mockup
 * draws it ("docBrain webhook_1 key"): the pipe's short id and the source.
 *
 * @param address - The endpoint address, `developerId.pipeId.source`.
 * @returns The key's display name.
 */
export function endpointKeyName(address: string): string {
	const segments = address.split('.');
	const pipe = segments[1] ?? segments[0] ?? address;
	const source = segments[2];
	return source ? `${pipe} ${source} key` : `${pipe} key`;
}

/**
 * The team a minted endpoint key is frozen to: the owner's HOME team (the
 * first of the team order; plan §2.4 says the mint UI offers it), or none
 * when the account carries no team.
 *
 * @param info - The connection's account info.
 * @returns The home team id, or null.
 */
export function endpointKeyTeam(info: ConnectResult | undefined): string | null {
	const home = info?.devTeam || info?.teamOrder?.[0];
	return home ? home : null;
}

/**
 * Mints the scoped key for one endpoint address.
 *
 * @param client - The SDK client slice (the connection's own account).
 * @param address - The endpoint address the key may send to, and nothing else.
 * @returns The raw key plus how it is listed.
 */
export async function mintEndpointKey(client: IEndpointKeyClient, address: string): Promise<IMintedEndpointKey> {
	const name = endpointKeyName(address);
	const teamId = endpointKeyTeam(client.getAccountInfo());
	const params: CreateKeyParams = {
		name,
		permissions: [...ENDPOINT_KEY_PERMISSIONS],
		endpoints: [address],
		...(teamId ? { teamId } : {}),
	};
	const { key } = await client.account.createKey(params);
	return { key, name, teamId };
}

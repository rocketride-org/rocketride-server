/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { createHash } from 'node:crypto';
import { RocketRideClient } from 'rocketride';
import type { Identity, IdentityResolver } from './types';

const CACHE_TTL_MS = 60_000;

/**
 * Validates a credential by logging in to the engine/ALB — the exact same
 * `Account.authenticate` path the panel token already flows through (design.md
 * §security). Caches by token hash for 60s so per-request proxy auth is cheap.
 */
export class EngineIdentityResolver implements IdentityResolver {
	private cache = new Map<string, { identity: Identity; expires: number }>();

	constructor(private uri: string) {}

	async resolve(credential: string): Promise<Identity> {
		const key = createHash('sha256').update(credential).digest('hex');
		const hit = this.cache.get(key);
		if (hit && hit.expires > Date.now()) return hit.identity;
		const client = new RocketRideClient({ uri: this.uri, module: 'rocket-agent', env: {} });
		try {
			const result = await client.login(credential);
			const identity: Identity = {
				ownerId: result.userId,
				tenantId: result.organization?.id ?? result.userId,
			};
			this.cache.set(key, { identity, expires: Date.now() + CACHE_TTL_MS });
			return identity;
		} finally {
			await client.logout().catch(() => undefined);
			await client.disconnect().catch(() => undefined);
		}
	}
}

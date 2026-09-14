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

import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import type { KeyResolver, ProviderKeys } from './types';

/**
 * Fernet decrypt (spec: version 0x80 | ts(8) | iv(16) | ciphertext | hmac(32);
 * key = urlsafe-b64 of signing(16) + encryption(16); AES-128-CBC + HMAC-SHA256).
 * Matches extension/src/extension/saas/crypto.py (Python `cryptography.fernet`).
 */
export function fernetDecrypt(token: string, key: string): Buffer {
	const keyBytes = Buffer.from(key, 'base64url');
	if (keyBytes.length !== 32) throw new Error('RR_ENCRYPTION_KEY must decode to 32 bytes');
	const signingKey = keyBytes.subarray(0, 16);
	const encKey = keyBytes.subarray(16);
	const data = Buffer.from(token, 'base64url');
	if (data.length < 57) throw new Error('fernet token too short');
	if (data[0] !== 0x80) throw new Error('unsupported fernet version');
	const signed = data.subarray(0, data.length - 32);
	const hmac = data.subarray(data.length - 32);
	const expected = createHmac('sha256', signingKey).update(signed).digest();
	if (!timingSafeEqual(hmac, expected)) throw new Error('fernet HMAC mismatch');
	const iv = data.subarray(9, 25);
	const ciphertext = data.subarray(25, data.length - 32);
	const decipher = createDecipheriv('aes-128-cbc', encKey, iv);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * SaaS resolver: fetch the user-scope encrypted agent-keys blob from the internal
 * ALB route (Task 3.4 adds `GET /agent/keys/blob`) and decrypt HERE — the vault
 * route never sees plaintext, rocket-agent never sees the DB.
 */
export class SaasVaultKeyResolver implements KeyResolver {
	constructor(private vaultUrl: string, private encryptionKey: string) {}

	async resolve(credential: string): Promise<ProviderKeys> {
		const res = await fetch(`${this.vaultUrl}/agent/keys/blob`, {
			headers: { authorization: `Bearer ${credential}` },
		});
		if (res.status === 404) return {};
		if (!res.ok) throw new Error(`vault blob fetch failed: ${res.status}`);
		const body = (await res.json()) as { encrypted: string | null };
		if (!body.encrypted) return {};
		const blob = JSON.parse(fernetDecrypt(body.encrypted, this.encryptionKey).toString('utf8')) as Record<string, string>;
		return { anthropic: blob.AGENT_ANTHROPIC_KEY, openai: blob.AGENT_OPENAI_KEY };
	}
}

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

/**
 * How `rocketride login` describes the expiry of the API key it mints.
 *
 * The key is minted over the sign-in connection, whose credential is a
 * session key, and a key minted that way expires no later than that session
 * (the server caps it; it reports the granted expiry as `record.expiresAt`).
 * So the CLI prints the real expiry instead of claiming the key never expires.
 *
 * Kept free of imports so it can be tested on its own.
 *
 * @param expiresAt - The granted expiry from `account.createKey()`: an ISO
 *   timestamp, null when the key does not expire, or undefined when the
 *   server did not report it (an older server).
 * @returns A sentence to append to the "minted API key" line ('' when unknown).
 */
export function describeLoginKeyExpiry(expiresAt: string | null | undefined): string {
	if (expiresAt === undefined) return '';
	if (expiresAt === null) return ' It does not expire.';
	return ` It expires on ${utcDay(expiresAt)} (bounded by your sign-in session); run \`rocketride login\` again before then.`;
}

/**
 * The UTC calendar day of a server timestamp. The server sends naive UTC
 * (`2027-02-03T10:00:00.123456`, no offset), which \`new Date()\` would read as
 * LOCAL time, so a value without an offset is taken as UTC.
 *
 * @param iso - The server's ISO timestamp.
 * @returns `YYYY-MM-DD` (UTC), or the input unchanged when it cannot be read.
 */
export function utcDay(iso: string): string {
	const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(iso);
	const when = new Date(hasOffset ? iso : `${iso}Z`);
	return Number.isNaN(when.getTime()) ? iso : when.toISOString().slice(0, 10);
}

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
 * Task 5.2c — centralized, redacting logger.
 *
 * Phase 3 never centralized logging (every module called `console.log`/`console.error`
 * directly) — this module becomes that center: every call site in `src/` is migrated to
 * `log.info`/`log.warn`/`log.error` (see the sibling modules) so there is exactly ONE place
 * secrets could ever reach stdout/stderr through, and exactly one place that guarantees they
 * don't. `tests/redaction.test.ts`'s grep-level check enforces the migration stays complete —
 * a stray raw `console.*` call anywhere in `src/` fails that test.
 *
 * Two independent redaction layers, because a secret can leak two different ways:
 *
 * 1. VALUE shape — a string argument (or a string nested anywhere inside an object/array
 *    argument) that LOOKS LIKE one of the known secret formats gets scrubbed regardless of
 *    which field it came from. This is what protects `buildChildEnv()`'s AGENT_ANTHROPIC_KEY
 *    (`sk-ant-...`) even though that field name doesn't itself look dangerous.
 * 2. KEY name — any object property whose KEY matches `SENSITIVE_KEY_RE` is replaced with
 *    `[redacted]` outright, regardless of what its value looks like. This is what protects a
 *    field like `RR_AGENT_SERVICE_TOKEN` or a `Authorization` object property whose value
 *    doesn't happen to match one of the known VALUE patterns above.
 */

/** Known secret value shapes, applied as independent sequential passes (order-independent — each pass only ever replaces text a later pass wouldn't otherwise touch). */
const SECRET_VALUE_PATTERNS: RegExp[] = [
	/sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API key
	/sk-[A-Za-z0-9]{16,}/g, // OpenAI (and OpenAI-shaped) API key
	/rr_[0-9a-f]{32}/g, // RocketRide rr_ vault-exchange key
	// Authorization: Bearer <token> header/value — deliberately requires a TOKEN-SHAPED
	// continuation (>=16 chars of base64url-ish charset, optional `=` padding), not just any
	// non-whitespace run. A bare `\S+` also matches ordinary prose like "Bearer token
	// required" (src/index.ts's 401 body, 4 sites) — greedily eating "token" and mangling a
	// normal message the moment anything ever logs it. Real bearer credentials (JWTs, opaque
	// service tokens) are always well past 16 chars; "token"/"required" are 5-8. The other
	// patterns above (sk-ant-/sk-/rr_/gAAAAA) already independently catch those shapes even
	// when they appear after "Bearer " — this pattern's remaining job is JWTs and other
	// opaque tokens that don't match any of those.
	/Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g,
	/gAAAAA[A-Za-z0-9_=-]+/g, // Fernet ciphertext blob (python `cryptography.fernet` prefix)
];

/** Property keys that are ALWAYS redacted outright, independent of the value's shape — catches secret-carrying fields whose value doesn't match a known format (e.g. opaque service tokens, session passwords named `*_TOKEN`/`*_SECRET`). */
export const SENSITIVE_KEY_RE = /(APIKEY|API_KEY|AUTH|TOKEN|SECRET)/i;

/**
 * Scrubs every known secret value shape out of a plain string. Normal text is returned
 * byte-for-byte unchanged — only substrings that actually match one of the patterns above are
 * replaced with the literal `[redacted]`.
 */
export function redactSecrets(input: string): string {
	let out = input;
	for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, '[redacted]');
	return out;
}

/**
 * Deep-redacts a value before it is handed to `console.*`: strings are scrubbed via
 * `redactSecrets`, object keys matching `SENSITIVE_KEY_RE` are replaced outright, and both
 * rules apply recursively through arrays/nested objects. `Error` instances are special-cased
 * (message + stack scrubbed, everything else preserved) so a caught error can still be logged
 * with a real stack trace. `seen` guards against a circular object hanging the logger.
 */
function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
	if (typeof value === 'string') return redactSecrets(value);
	if (value instanceof Error) {
		const clone = Object.create(Object.getPrototypeOf(value)) as Error & Record<string, unknown>;
		Object.assign(clone, value);
		clone.message = redactSecrets(value.message);
		if (value.stack) clone.stack = redactSecrets(value.stack);
		return clone;
	}
	if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
	if (value && typeof value === 'object') {
		if (seen.has(value)) return '[circular]';
		seen.add(value);
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redactValue(val, seen);
		}
		return out;
	}
	return value;
}

/**
 * Drop-in replacement for `console.log`/`console.warn`/`console.error` — every argument is
 * deep-redacted (see `redactValue`) before it reaches the real console. This is the ONLY
 * logging surface `src/` is allowed to call; a raw `console.*` call anywhere else in `src/`
 * is a redaction gap (enforced by `tests/redaction.test.ts`'s grep-level check).
 */
export const log = {
	info(...args: unknown[]): void {
		console.log(...args.map((a) => redactValue(a)));
	},
	warn(...args: unknown[]): void {
		console.warn(...args.map((a) => redactValue(a)));
	},
	error(...args: unknown[]): void {
		console.error(...args.map((a) => redactValue(a)));
	},
};

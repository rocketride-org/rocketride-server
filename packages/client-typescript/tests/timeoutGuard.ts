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

export function makeTimeoutRejector(
	ms: number,
	context: string
): { promise: Promise<never>; clear: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${context} timeout ${ms}ms`)), ms);
	});
	return {
		promise,
		clear: () => {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

export async function withTimeoutGuard<T>(
	operation: Promise<T>,
	ms: number,
	context: string
): Promise<T> {
	const guard = makeTimeoutRejector(ms, context);
	try {
		return await Promise.race([operation, guard.promise]);
	} finally {
		guard.clear();
	}
}

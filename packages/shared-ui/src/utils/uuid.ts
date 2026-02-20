// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Generates a pseudo-random UUID v4 string. Uses a combination of the current
 * timestamp and `Math.random()` for entropy. Suitable for client-side unique
 * identifiers (e.g., node IDs on the canvas) but not cryptographically secure.
 *
 * @returns A UUID string in the format `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.
 */
export const uuid = () => {
	// Seed with current timestamp for additional entropy beyond Math.random()
	let d = new Date().getTime();
	// Replace each 'x' and 'y' placeholder in the UUID v4 template with a hex digit
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		// Combine timestamp bits with a random value, then extract the low nibble
		const random = (d + Math.random() * 16) % 16 | 0;
		// Consume timestamp bits progressively so each position gets different entropy
		d = Math.floor(d / 16);
		// For 'y' positions, force the top two bits to '10' per UUID v4 variant spec
		return (c === 'x' ? random : (random & 0x3) | 0x8).toString(16);
	});
};

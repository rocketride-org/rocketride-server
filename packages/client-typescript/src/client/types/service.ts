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
 * Protocol capability flags for service drivers.
 *
 * Each flag is a single bit in a uint32 bitmask describing what a service
 * driver supports. Values are returned by the engine in the `capabilities`
 * field of a service definition and can be tested with bitwise AND.
 *
 * @example
 * ```typescript
 * const services = await client.getServices();
 * const svc = services['my_driver'];
 * if (svc.capabilities & PROTOCOL_CAPS.GPU) {
 *   console.log('Driver requires a GPU');
 * }
 * ```
 */
export enum PROTOCOL_CAPS {
	/** No capabilities */
	NONE = 0,

	/** Supports the file permissions interface */
	SECURITY = 1 << 0,

	/** Is a filesystem interface */
	FILESYSTEM = 1 << 1,

	/** Supports the substream interface */
	SUBSTREAM = 1 << 2,

	/** Uses a network interface */
	NETWORK = 1 << 3,

	/** Uses datanet or streamnet interfaces */
	DATANET = 1 << 4,

	/** Uses delta queries to track changes */
	SYNC = 1 << 5,

	/** Internal — will not be returned in services.json */
	INTERNAL = 1 << 6,

	/** Supports data catalog operations */
	CATALOG = 1 << 7,

	/** Do not monitor for excessive failures */
	NOMONITOR = 1 << 8,

	/** Source endpoint does not use include */
	NOINCLUDE = 1 << 9,

	/** Driver supports the invoke function */
	INVOKE = 1 << 10,

	/** Driver supports remoting execution */
	REMOTING = 1 << 11,

	/** Driver requires a GPU */
	GPU = 1 << 12,

	/** Driver is not SaaS compatible */
	NOSAAS = 1 << 13,

	/** Focus on this driver */
	FOCUS = 1 << 14,

	/** Driver is deprecated */
	DEPRECATED = 1 << 15,

	/** Driver is experimental */
	EXPERIMENTAL = 1 << 16,
}

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

// ============================================================================
// SERVICE DEFINITION TYPES
// ============================================================================

/**
 * JSON Schema / UI schema pair for a single configuration section of a
 * service driver (e.g. "Pipe", "Source", "Global").
 */
export interface ServiceSection {
	/** JSON Schema describing the section's configurable properties. */
	schema: Record<string, unknown>;
	/** UI schema hints for rendering the section in the pipeline editor. */
	ui: Record<string, unknown>;
}

/**
 * Invoke slot descriptor for a service that supports control-plane invoke.
 * Each key in the invoke map names a slot (e.g. 'llm', 'tool', 'memory').
 */
export interface ServiceInvokeSlot {
	/** Human-readable description of what this slot expects. */
	description: string;
	/** Minimum number of connections required (0 = optional). */
	min: number;
	/** Maximum number of connections allowed (omitted = unlimited). */
	max?: number;
}

/**
 * Describes one input lane and its possible output lanes.
 */
export interface ServiceInputLane {
	/** The input lane name. */
	lane: string;
	/** Output lanes this input can produce. */
	output?: Array<{ lane: string }>;
}

/**
 * A service definition as returned by the engine via `rrext_services`.
 *
 * Each definition describes a driver/connector that can be used as a
 * component in a pipeline. The object contains known fixed fields plus
 * dynamic section keys (e.g. "Pipe", "Source", "Global") that each hold
 * a {@link ServiceSection} with `schema` and `ui`.
 *
 * @example
 * ```typescript
 * const services = await client.getServices();
 * const ocr = services['ocr'];
 * console.log(ocr.title, ocr.classType);
 * ```
 */
export interface ServiceDefinition {
	/** Human-readable display name. */
	title: string;
	/** Protocol URI scheme (e.g. "filesys://", "agent_rocketride://"). */
	protocol: string;
	/** URL prefix used for default URL mapping. */
	prefix: string;
	/** Account plans this driver is available for (null = all plans). */
	plans: string[] | null;
	/** Bitmask of {@link PROTOCOL_CAPS} flags. */
	capabilities: number;
	/** Categorisation tags (e.g. ["source"], ["agent", "tool"]). */
	classType: string[];
	/** Bitmask of supported UI actions (deletion, export, download). */
	actions: number;
	/** Human-readable description of the driver. */
	description?: string;
	/** Lane mapping: input lane name -> array of output lane names. */
	lanes?: Record<string, string[]>;
	/** Structured input/output lane definitions. */
	input?: ServiceInputLane[];
	/** Control-plane invoke slot definitions. */
	invoke?: Record<string, ServiceInvokeSlot>;
	/** Tile/card rendering hint for the pipeline editor. */
	tile?: Record<string, unknown>;
	/** Icon filename or identifier. */
	icon?: string;
	/** External documentation URL. */
	documentation?: string;
	/** Dynamic configuration sections (e.g. "Pipe", "Source", "Global"). */
	[section: string]: unknown;
}

/**
 * Response from `getServices()`: a map of logical type names to their
 * service definitions, plus a version field.
 */
export interface ServicesResponse {
	/** Map of logical type name (e.g. "ocr", "filesys") to its definition. */
	services: Record<string, ServiceDefinition>;
}

// ============================================================================
// VALIDATION TYPES
// ============================================================================

/**
 * A single validation error or warning from pipeline validation.
 */
export interface ValidationError {
	/** Human-readable error/warning message. */
	message: string;
	/** Component ID that caused the issue (if applicable). */
	id?: string;
}

/**
 * Result of a pipeline validation via `validate()`.
 *
 * The engine validates structure, component compatibility, and connection
 * integrity. The result contains any errors and warnings found.
 */
export interface ValidationResult {
	/** Validation errors — pipeline will not execute with these. */
	errors: ValidationError[];
	/** Validation warnings — pipeline may still execute. */
	warnings: ValidationError[];
	/** Additional fields from the engine response. */
	[key: string]: unknown;
}

// ============================================================================
// PROTOCOL CAPABILITY FLAGS
// ============================================================================

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
 * const svc = services.services['my_driver'];
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

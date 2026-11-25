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

import type { PipeStoreBlock } from '../pipe-store.js';

/**
 * Data flow connection between pipeline components.
 */
export interface PipelineInputConnection {
	/** Data lane/channel name (e.g., 'text', 'data', 'image') */
	lane: string;

	/** Source component ID providing the data */
	from: string;
}

/**
 * Invoke (control-flow) connection from one component to another.
 */
export interface PipelineControlConnection {
	/** Class type of the invoke channel (e.g., 'llm', 'tool', 'memory') */
	classType: string;

	/** Source component ID providing the invocation */
	from: string;
}

/**
 * Pipeline component that processes data.
 *
 * Each component has a unique ID, a provider type that determines its behavior,
 * and provider-specific configuration. Components receive data through input
 * connections from other components.
 */
export interface PipelineComponent {
	/** Unique identifier for this component within the pipeline */
	id: string;

	/** Component type/provider (e.g., 'webhook', 'response', 'ai_chat') */
	provider: string;

	/** Human-readable component name */
	name?: string;

	/** Component description for documentation */
	description?: string;

	/** Component-specific configuration parameters */
	config: Record<string, unknown>;

	/** UI-specific configuration for visual editors */
	ui?: Record<string, unknown>;

	/** Input connections from other components */
	input?: PipelineInputConnection[];

	/** Invoke (control-flow) connections from other components */
	control?: PipelineControlConnection[];
}

/**
 * Pipeline configuration for RocketRide data processing workflows.
 *
 * Defines a complete pipeline with components, data flow connections,
 * and execution parameters. Pipelines process data through a series
 * of connected components that transform, analyze, or route information.
 */
export interface PipelineConfig {
	/** Human-readable pipeline name — the registry's pipelineName renders it
	    on every deploy surface, and publish requires it. */
	name?: string;

	/** Pipeline description */
	description?: string;

	/** Pipeline version number */
	version?: number;

	/** Array of pipeline components that process data */
	components: PipelineComponent[];

	/** ID of the component that serves as the pipeline entry point */
	source?: string;

	/** Project identifier for organization and permissions */
	project_id?: string;

	/** The store listing (tagline, categories, tags, icon, readme, links,
	    mode, billing). A pipeline carries one when it is deployed: the
	    packers and the deploy door add the default block to a pipe that has
	    none (a version stored by an earlier release can lack it). The engine
	    never sees it. */
	store?: PipeStoreBlock;

	/** Per-call params: public name -> `nodeId.configKey` */
	parameters?: Record<string, string>;

	/** The storage roots beyond its run's anchor this pipeline's nodes reach
	    through `self.files` (`'@Development/kb'`, `'=team/<tid>/kb'`,
	    `'@org/shared'`). Resolved through the run's owner when it starts: a
	    root the owner cannot reach refuses the start. A pipeline that
	    declares roots cannot be published to `@public`. */
	roots?: string[];

	/** UI viewport settings for visual editors */
	viewport?: { x: number; y: number; zoom: number };

	/** Editor document revision counter for change tracking (undo/redo, echo detection). */
	docRevision?: number;

	/** Whether the canvas is locked from editing */
	isLocked?: boolean;

	/** Whether node snapping to grid is enabled */
	snapToGrid?: boolean;

	/** Grid size for snapping [x, y] */
	snapGridSize?: [number, number];

	/** Active editor mode (e.g. 'design', 'status', 'flow') */
	editorMode?: string;
}

/**
 * How much of a request's flow the engine records and sends as FLOW events,
 * from nothing to every node's input and output: `use()` and `submit()` take
 * it, and so does a DataPipe for its own transaction.
 */
export type PipelineTraceLevel = 'none' | 'metadata' | 'summary' | 'full';

/**
 * What `submit()` returns: the pipe `close` body plus the resolution stamps.
 *
 * The close body's own fields (`result_types`, `objects` ...) ride beside these.
 */
export interface SUBMIT_RESULT {
	/**
	 * The control id that answered: an opaque transient handle, valid for the
	 * life of the control, that every data and control verb takes. Never
	 * persist it: it dies with the control and a restart mints a new one.
	 */
	token: string;

	/** The address that answered: `developerId.pipelineId.source` (the stable identity, beside the id) */
	address?: string;

	/** The rung that answered (`'@org'` is the org rung, plan 3.2) */
	resolved: '@spec' | '@me' | '@team' | '@org' | '@public';

	/** On `@team`: the answering team */
	team?: string;

	/** The artifact version (absent on `@spec`) */
	version?: number;

	/** The engine the request ran on (shape key, owner-qualified) */
	engineKey: string;

	/** `'none'` when an existing control answered, `'started'` when this call created one */
	converged: 'none' | 'started';

	/** Server-controlled arguments a name call passed (threads/args/env/ttl) */
	ignored: string[];

	/** The close body's fields */
	[key: string]: unknown;
}

// ============================================================================
// INTERFACES — what a published pipe offers a front end (plan 3.6)
// ============================================================================

/** One callable node of an interface: the id to call and a name to show. */
export interface PipeInterfaceNode {
	/** The component id — what `tool()` takes as `nodeId`. */
	nodeId: string;
	/** The author's display name, else the node id; always present. */
	name: string;
}

/**
 * The interface map: address → catalog classType → nodes.
 *
 * A source component sits under its own address (`acme.docBrain.chat`) with
 * its classTypes (`source`, `chat`); every other component sits under the
 * PIPE address (`acme.docBrain`, the default source) under each classType it
 * carries (`database`, `tool`, `llm`, ...).
 */
export type PipeInterfaceMap = Record<string, Record<string, PipeInterfaceNode[]>>;

/**
 * One source of a pipeline, as its service declares it.
 *
 * The classType words cannot tell sources apart (a Telegram bot and the local
 * file system both carry `source` alone); this is what the source IS.
 */
export interface PipeSource {
	/** The component id. */
	nodeId: string;
	/** The author's display name, else the node id. */
	name: string;
	/** The service's title (`Chat`, `Telegram Bot`), else the display name. */
	title: string;
	/**
	 * How work reaches it, as its service declares `sourceKind`: every unit
	 * arrives as a caller's `request`, it is a `listener` on an outside
	 * channel, or it is a `scan` that reads a store on its own (a service
	 * that declares none, or a node the catalog does not know).
	 */
	kind: 'request' | 'listener' | 'scan';
	/** How a request reaches it: by `tool` call (it hosts tools, or is one), else as `data`. */
	entry: 'data' | 'tool';
	/** The lanes its service declares on `_source`, in its order. */
	lanes: string[];
}

/** What each source is, by the source's own address (the address the interface map gives it). */
export type PipeSourceMap = Record<string, PipeSource>;

/**
 * One per-call parameter of a pipeline, as a caller sees it: the public name
 * a call sets in `params`, what the value must be, and what a call gets when
 * it omits it. The node and field behind the name are not told.
 */
export interface PipeParameter {
	/** The public name (the key of `params`). */
	name: string;
	/** The value a call gets when it omits the parameter: the publisher's configured value, else the node's default. */
	default: unknown;
	/** The value's type (`string`, `integer`, `number`, `boolean`, ...). */
	type?: string;
	/** Display title. */
	title?: string;
	/** Description. */
	description?: string;
	/** Allowed values, when the parameter is an enum. */
	enum?: unknown[];
	/** Lower bound, when one is declared. */
	minimum?: number;
	/** Upper bound, when one is declared. */
	maximum?: number;
}

/** The `interfaces()` answer: which publication would answer, and what it offers. */
export interface PipeInterfaces {
	/** The pipe address (`developerId.pipelineId`). */
	address: string;
	/** The rung that answers you: `spec` (your own live control, no publication), `me`, `team`, `org` or `public`. */
	rung: 'spec' | 'me' | 'team' | 'org' | 'public';
	/** The registry version that publication points at; null when your own `spec` control answered (it has none). */
	version: number | null;
	/** The answering team on the `team` rung. */
	teamId?: string;
	/** The map. */
	interfaces: PipeInterfaceMap;
	/** What each source is, by its address; absent on a server that predates it. */
	sources?: PipeSourceMap;
	/** The pipeline's per-call parameters, in the map's order; absent on a server that predates them. */
	parameters?: PipeParameter[];
}

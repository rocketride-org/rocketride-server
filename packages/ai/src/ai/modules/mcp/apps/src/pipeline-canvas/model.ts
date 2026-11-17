/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Turns a view_pipeline tool result into what the canvas draws. Pure: no
 * DOM, no React, so it runs under the widget's node-environment tests.
 *
 * The tool sends two payloads. The model reads the summary (`content` and
 * `structuredContent`). The widget reads the result's `_meta`, key
 * `rocketride/canvas`: the cleaned pipeline, the catalog entries for its
 * providers and their icons. A host that drops `_meta` still gets a drawing,
 * built from the summary with plain nodes.
 */
import type { Edge } from '@xyflow/react';

import { getEdgesFromNodes, getNodesFromProject } from '@app-shared/tools/pipelines/panels/design/canvas/util/graph';
import { INodeType } from '@app-shared/tools/pipelines/panels/design/canvas/types';
import type { INode, IProject, IProjectComponent, IService, IServiceCatalog } from '@app-shared/tools/pipelines/panels/design/canvas/types';
import { IServiceCapabilities } from 'shell';

import { layoutPipeline, type LayoutFrame, type LayoutSize } from './layout';

/** The `_meta` key the tool puts the drawing payload under. */
export const CANVAS_META_KEY = 'rocketride/canvas';

/** Icon id the catalog never holds, so `<Icon>` draws its fallback icon. */
export const UNKNOWN_ICON = 'rocketride-unknown-provider';

/** Size used to lay out a node before the browser has measured it. */
export const ESTIMATED_NODE_SIZE: LayoutSize = { width: 180, height: 90 };

/** Size of a saved group with no recorded size. */
export const DEFAULT_GROUP_SIZE: LayoutSize = { width: 320, height: 200 };

/** The frame a layout aims at before the widget knows its real size. */
export const DEFAULT_FRAME: LayoutFrame = { width: 740, height: 420 };

export interface SummaryNode {
	id: string;
	provider: string;
	title?: string;
}

export interface SummaryConnection {
	from: string;
	to: string;
	lane?: string;
	control?: string;
}

/** The model-visible result (`structuredContent`). */
export interface ViewPipelineSummary {
	ok: boolean;
	path?: string;
	workspace?: string;
	name?: string;
	description?: string;
	node_count?: number;
	truncated?: boolean;
	nodes?: SummaryNode[];
	connections?: SummaryConnection[];
	error_type?: string;
	message?: string;
	hint?: string | null;
	/** File size in bytes, on a PipelineTooLarge error. */
	size?: number;
}

/** The widget-only payload under `_meta['rocketride/canvas']`. */
export interface CanvasPayload {
	pipeline: IProject;
	services?: IServiceCatalog;
	icons?: Record<string, string>;
}

/** Just the parts of a CallToolResult this module reads. */
export interface ToolResultLike {
	content?: Array<{ type?: string; text?: string }>;
	structuredContent?: unknown;
	_meta?: Record<string, unknown>;
	isError?: boolean;
}

export type CanvasModel =
	| { kind: 'error'; message: string; hint?: string }
	| { kind: 'empty'; summary: ViewPipelineSummary }
	| {
			kind: 'graph';
			summary: ViewPipelineSummary;
			nodes: INode[];
			edges: Edge[];
			services: IServiceCatalog;
			icons: Record<string, string>;
			/** True when no node had a saved position and the widget placed them. */
			laidOut: boolean;
			/** True when the drawing came from the summary because `_meta` was missing. */
			summaryOnly: boolean;
			/** Providers in the file that this engine's catalog does not have. */
			missingProviders: string[];
	  };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The summary from `structuredContent`, else from the JSON text block. */
export function readSummary(result: ToolResultLike): ViewPipelineSummary | null {
	if (isObject(result.structuredContent)) return result.structuredContent as unknown as ViewPipelineSummary;
	const text = result.content?.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text;
	if (!text) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return isObject(parsed) ? (parsed as unknown as ViewPipelineSummary) : null;
	} catch {
		return null;
	}
}

/** The drawing payload from the result's `_meta`, else from `fallbackMeta`. */
export function readPayload(result: ToolResultLike, fallbackMeta?: unknown): CanvasPayload | null {
	for (const meta of [result._meta, fallbackMeta]) {
		const payload = isObject(meta) ? meta[CANVAS_META_KEY] : undefined;
		if (isObject(payload) && isObject(payload.pipeline) && Array.isArray(payload.pipeline.components)) {
			return payload as unknown as CanvasPayload;
		}
	}
	return null;
}

/** Rebuilds a pipeline from the summary, for a host that dropped `_meta`. */
export function pipelineFromSummary(summary: ViewPipelineSummary): IProject {
	const components = new Map<string, IProjectComponent>();
	for (const node of summary.nodes ?? []) {
		if (!node?.id || components.has(node.id)) continue;
		components.set(node.id, { id: node.id, provider: node.provider, name: node.title ?? '', config: {}, input: [], control: [] } as unknown as IProjectComponent);
	}
	for (const connection of summary.connections ?? []) {
		const target = components.get(connection?.to);
		if (!target || !connection.from) continue;
		if (connection.control) target.control!.push({ classType: connection.control, from: connection.from });
		else if (connection.lane) target.input!.push({ lane: connection.lane, from: connection.from });
	}
	return { components: [...components.values()] } as unknown as IProject;
}

/**
 * Catalog entries the drawing needs so that every connection in the file has
 * handles to attach to. A provider the catalog does not know (a node removed
 * from this engine, or a summary-only drawing) gets an entry made from its
 * node's own connections, with the builder's fallback icon and the provider
 * name as its title. A known provider keeps its entry, plus any lane or
 * invoke channel the file uses and the catalog does not declare, so a
 * connection the builder would silently leave out is still drawn.
 */
export function fillMissingServices(nodes: INode[], services: IServiceCatalog): IServiceCatalog {
	const catalog: IServiceCatalog = { ...services };
	const used = new Map<string, { inputs: Set<string>; outputs: Set<string>; invokes: Set<string>; invoked: boolean }>();
	const usage = (provider: string) => {
		if (!used.has(provider)) used.set(provider, { inputs: new Set(), outputs: new Set(), invokes: new Set(), invoked: false });
		return used.get(provider)!;
	};
	const providerOf = new Map(nodes.map((node) => [node.id, node.data.provider]));
	for (const node of nodes) {
		if (node.type !== INodeType.Default) continue;
		const own = usage(node.data.provider);
		for (const input of node.data.input ?? []) {
			own.inputs.add(input.lane);
			const from = providerOf.get(input.from);
			if (from) usage(from).outputs.add(input.lane);
		}
		for (const control of node.data.control ?? []) {
			own.invoked = true;
			const from = providerOf.get(control.from);
			if (from) usage(from).invokes.add(control.classType);
		}
	}

	for (const [provider, use] of used) {
		const known = catalog[provider] as (IService & Record<string, unknown>) | undefined;
		const lanes: Record<string, unknown[]> = { ...((known?.lanes as Record<string, unknown[]>) ?? {}) };
		const declaredOutputs = new Set(Object.values(lanes).flatMap((entries) => (entries ?? []).map((entry) => (typeof entry === 'string' ? entry : (entry as { type: string }).type))));
		const missingInputs = [...use.inputs].filter((lane) => !(lane in lanes)).sort();
		const missingOutputs = [...use.outputs].filter((lane) => !declaredOutputs.has(lane)).sort();
		const invoke: Record<string, unknown> = { ...((known?.invoke as Record<string, unknown>) ?? {}) };
		const missingInvokes = [...use.invokes].filter((classType) => !(classType in invoke)).sort();
		const capabilities = Number(known?.capabilities ?? 0);
		const needsInvokeTarget = use.invoked && (capabilities & IServiceCapabilities.Invoke) !== IServiceCapabilities.Invoke;
		if (known && !missingInputs.length && !missingOutputs.length && !missingInvokes.length && !needsInvokeTarget) continue;

		for (const lane of missingInputs) lanes[lane] = [];
		// A hidden input (leading '_') carries outputs no declared input lists.
		if (missingOutputs.length) lanes._extra = [...((lanes._extra as unknown[]) ?? []), ...missingOutputs];
		for (const classType of missingInvokes) invoke[classType] = {};
		catalog[provider] = {
			...(known ?? { title: provider, icon: UNKNOWN_ICON }),
			lanes,
			invoke,
			capabilities: needsInvokeTarget ? capabilities | IServiceCapabilities.Invoke : capabilities,
		} as unknown as IService;
	}
	return catalog;
}

/** Orders nodes so a group always comes before its children (React Flow needs it). */
export function parentsFirst(nodes: INode[]): INode[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const out: INode[] = [];
	const seen = new Set<string>();
	const visit = (node: INode, depth: number) => {
		if (seen.has(node.id)) return;
		const parent = node.parentId ? byId.get(node.parentId) : undefined;
		if (parent && depth < nodes.length) visit(parent, depth + 1);
		seen.add(node.id);
		out.push(node);
	};
	nodes.forEach((node) => visit(node, 0));
	return out;
}

/**
 * Places every node with `layoutPipeline` when the saved pipeline has no
 * positions at all. A pipeline with any saved position is drawn as saved.
 * Without positions there is no saved grouping either, so a child is drawn
 * at the top level instead of inside a group at 0,0.
 */
export function placeNodes(
	nodes: INode[],
	edges: Edge[],
	hadPositions: boolean,
	sizeOf: (id: string) => LayoutSize = () => ESTIMATED_NODE_SIZE,
	frame: LayoutFrame = DEFAULT_FRAME
): INode[] {
	if (hadPositions) return nodes;
	const positions = layoutPipeline(
		nodes.map((node) => node.id),
		edges.map((edge) => ({ source: edge.source, target: edge.target, control: !!edge.sourceHandle?.startsWith('invoke-source') })),
		sizeOf,
		frame
	);
	return nodes.map((node) => ({ ...node, parentId: undefined, position: positions[node.id] ?? { x: 0, y: 0 } }));
}

/**
 * React Flow measures each node in the browser. The builder's graph code
 * presets a size from the file (or 150x36), which would make React Flow
 * report the nodes as measured before they are. Drop it, except for a group:
 * a group's box is its saved size, so it becomes the group's width and height.
 */
export function sizeForReactFlow(node: INode): INode {
	const { measured, ...rest } = node;
	if (node.type !== INodeType.Group) return rest as INode;
	const width = measured?.width && measured.width > 40 ? measured.width : DEFAULT_GROUP_SIZE.width;
	const height = measured?.height && measured.height > 40 ? measured.height : DEFAULT_GROUP_SIZE.height;
	return { ...rest, width, height } as INode;
}

/** A note with no text would show the builder's "Double-click to add content" prompt, an edit the widget cannot do. */
function isEmptyNote(node: INode): boolean {
	return node.type === INodeType.Annotation && !String(node.data.config?.content ?? '').trim();
}

function anyPosition(components: unknown[] = [], depth = 0): boolean {
	return components.some((component) => {
		if (!isObject(component)) return false;
		const ui = component.ui;
		if (isObject(ui) && isObject(ui.position)) return true;
		const config = component.config;
		const inner = isObject(config) && isObject(config.pipeline) ? config.pipeline.components : undefined;
		return depth < 8 && Array.isArray(inner) && anyPosition(inner, depth + 1);
	});
}

/** Makes every node and edge inert: nothing can be dragged, selected, focused or deleted. */
function readOnly<T extends object>(item: T): T {
	return { ...item, draggable: false, selectable: false, deletable: false, connectable: false, focusable: false };
}

/**
 * The person reads paths the way the builder shows them, without the team id
 * inside a team path (`@/Team/=<id>/.projects/x.pipe` reads `.projects/x.pipe`).
 * The model keeps the full path in the tool result.
 */
export function withoutTeamIds(text: string): string {
	return text.replace(/@\/Team\/=[A-Za-z0-9][A-Za-z0-9_.-]*\/\.projects/g, '.projects');
}

/** A byte count as the person reads it: 2.1 MB, 640 KB. */
export function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, '')} MB`;
	if (bytes >= 1_000) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} bytes`;
}

/**
 * The person's view of a tool error. The tool's own message and hint are
 * written for the model (they name tools such as store_list); the widget
 * says what happened and what the person can ask for instead.
 */
export function errorFor(summary: ViewPipelineSummary): Extract<CanvasModel, { kind: 'error' }> {
	const file = displayPath(summary.path, summary.workspace) || 'that path';
	switch (summary.error_type) {
		case 'InvalidPath':
			return { kind: 'error', message: 'Only pipeline files (.pipe or .pipe.json) in your workspace can be shown.', hint: 'Ask to see your saved pipelines.' };
		case 'NotFound':
			return { kind: 'error', message: `There is no pipeline at ${file}.`, hint: 'Ask to see your saved pipelines.' };
		case 'AccessDenied':
			return { kind: 'error', message: `You don't have access to ${file}.`, hint: 'Ask to see the pipelines you can open.' };
		case 'PipelineTooLarge':
			return { kind: 'error', message: `${file} is too large to show here${typeof summary.size === 'number' ? ` (${formatBytes(summary.size)})` : ''}. The limit is 2 MB.`, hint: 'Open it in the builder instead.' };
		case 'InvalidPipeline':
			return { kind: 'error', message: `${file} isn't a pipeline the canvas can read.`, hint: 'Ask to see your saved pipelines.' };
		default:
			return { kind: 'error', message: withoutTeamIds(summary.message || 'The pipeline could not be opened.') };
	}
}

/** Builds the canvas model for one tool result. */
export function buildCanvasModel(result: ToolResultLike, fallbackMeta?: unknown): CanvasModel {
	const summary = readSummary(result);
	if (!summary) return { kind: 'error', message: 'The tool result could not be read.' };
	if (!summary.ok) return errorFor(summary);

	const payload = readPayload(result, fallbackMeta);
	const pipeline = payload?.pipeline ?? pipelineFromSummary(summary);
	if (!pipeline.components?.length) return { kind: 'empty', summary };

	const projectNodes = parentsFirst(getNodesFromProject(pipeline) as INode[]).filter((node) => !isEmptyNote(node));
	const edges = getEdgesFromNodes(projectNodes).map(readOnly);
	const hadPositions = anyPosition(pipeline.components as unknown[]);
	const nodes = placeNodes(projectNodes, edges, hadPositions).map(sizeForReactFlow).map(readOnly);
	if (!nodes.length) return { kind: 'empty', summary };

	return {
		kind: 'graph',
		summary,
		nodes,
		edges,
		services: fillMissingServices(nodes, payload?.services ?? {}),
		icons: payload?.icons ?? {},
		laidOut: !hadPositions,
		summaryOnly: !payload,
		missingProviders: payload
			? [...new Set(nodes.filter((node) => node.type === INodeType.Default && !payload.services?.[node.data.provider]).map((node) => node.data.provider))].sort()
			: [],
	};
}

/** The file's path inside the workspace (what the builder's file tree shows), else the full path. */
export function displayPath(path?: string, workspace?: string): string {
	if (!path) return '';
	for (const root of [workspace, '.projects'].filter(Boolean) as string[]) {
		if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
	}
	const team = /^@\/Team\/=[^/]+\/\.projects\//.exec(path);
	return team ? path.slice(team[0].length) : path;
}

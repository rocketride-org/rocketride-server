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

import { layoutPipeline, type LayoutSize } from './layout';

/** The `_meta` key the tool puts the drawing payload under. */
export const CANVAS_META_KEY = 'rocketride/canvas';

/** Icon id the catalog never holds, so `<Icon>` draws its fallback icon. */
export const UNKNOWN_ICON = 'rocketride-unknown-provider';

/** Size used to lay out a node before the browser has measured it. */
export const ESTIMATED_NODE_SIZE: LayoutSize = { width: 180, height: 90 };

/** Size of a saved group with no recorded size. */
export const DEFAULT_GROUP_SIZE: LayoutSize = { width: 320, height: 200 };

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
 * Catalog entries for providers the catalog does not know (a node removed
 * from this engine, or a summary-only drawing). The entry is made from the
 * node's own connections, so its lanes and invoke diamonds exist and its
 * edges have handles to attach to. Its icon is the builder's fallback icon
 * and its title is the provider name.
 */
export function fillMissingServices(nodes: INode[], services: IServiceCatalog): IServiceCatalog {
	const catalog: IServiceCatalog = { ...services };
	const missing = nodes.filter((node) => node.type === INodeType.Default && !catalog[node.data.provider]);
	if (!missing.length) return catalog;

	const outputsOf = new Map<string, Set<string>>();
	const invokesOf = new Map<string, Set<string>>();
	for (const node of nodes) {
		for (const input of node.data.input ?? []) {
			if (!outputsOf.has(input.from)) outputsOf.set(input.from, new Set());
			outputsOf.get(input.from)!.add(input.lane);
		}
		for (const control of node.data.control ?? []) {
			if (!invokesOf.has(control.from)) invokesOf.set(control.from, new Set());
			invokesOf.get(control.from)!.add(control.classType);
		}
	}

	const byProvider = new Map<string, INode[]>();
	for (const node of missing) {
		if (!byProvider.has(node.data.provider)) byProvider.set(node.data.provider, []);
		byProvider.get(node.data.provider)!.push(node);
	}
	for (const [provider, group] of byProvider) {
		const inputs = new Set<string>();
		const outputs = new Set<string>();
		const invokes = new Set<string>();
		let invocable = false;
		for (const node of group) {
			for (const input of node.data.input ?? []) inputs.add(input.lane);
			for (const lane of outputsOf.get(node.id) ?? []) outputs.add(lane);
			for (const classType of invokesOf.get(node.id) ?? []) invokes.add(classType);
			if (node.data.control?.length) invocable = true;
		}
		const outputList = [...outputs].sort();
		const lanes: Record<string, string[]> = {};
		for (const lane of [...inputs].sort()) lanes[lane] = outputList;
		// A hidden input (leading '_') carries the outputs of a node with none.
		if (!inputs.size && outputList.length) lanes._out = outputList;
		catalog[provider] = {
			title: provider,
			icon: UNKNOWN_ICON,
			lanes,
			invoke: Object.fromEntries([...invokes].sort().map((classType) => [classType, {}])),
			capabilities: invocable ? IServiceCapabilities.Invoke : 0,
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
export function placeNodes(nodes: INode[], edges: Edge[], hadPositions: boolean, sizeOf: (id: string) => LayoutSize = () => ESTIMATED_NODE_SIZE): INode[] {
	if (hadPositions) return nodes;
	const positions = layoutPipeline(
		nodes.map((node) => node.id),
		edges.map((edge) => ({ source: edge.source, target: edge.target, control: !!edge.sourceHandle?.startsWith('invoke-source') })),
		sizeOf
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

/** Builds the canvas model for one tool result. */
export function buildCanvasModel(result: ToolResultLike, fallbackMeta?: unknown): CanvasModel {
	const summary = readSummary(result);
	if (!summary) return { kind: 'error', message: 'The tool result could not be read.' };
	if (!summary.ok) {
		return { kind: 'error', message: withoutTeamIds(summary.message || 'The pipeline could not be opened.'), hint: summary.hint ? withoutTeamIds(summary.hint) : undefined };
	}

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

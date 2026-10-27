// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// VECTOR-UI — CONTRACT TYPES (frozen; the seam between the console, map and chat/ingest code)
// =============================================================================
//
// Two halves:
//
//   1. WIRE TYPES — the JSON every vector store tool answers with, exactly as
//      docs/development/nodes/vector-tool-contract.md section 4 defines it. The
//      node is the source of truth; these types are what the app may rely on.
//      Keys the node may omit (older nodes, legacy answers) are optional.
//   2. APP TYPES — what the console hands its panels and the map: the
//      connection model, the role channels, the shared selection, and the props
//      of every component one part of the app renders for another.
//
// TYPES AND CONSTANTS ONLY: this module imports nothing at run time, so every
// node:test suite can import it. Raw vectors appear in exactly two wire types
// (IVectorItem.values and IEmbedResult.vectors); nothing under src/map ever
// receives either.
//
// A change to anything exported here is a lead decision broadcast to every
// lane the same day. Exception: the props of components rendered only inside
// another component of the same lane (marked "lane-internal") may be extended
// by that lane with optional fields.
// =============================================================================

import type { IExplorerEndpoint, IRoleChannel } from 'shared/explorer';
import type { WorkbenchTab } from '../vector/workbench';

// =============================================================================
// 1. WIRE TYPES
// =============================================================================

// -----------------------------------------------------------------------------
// Vocabularies (mirror packages/ai/src/ai/common/store/vx_types.py)
// -----------------------------------------------------------------------------

/** Every `code` a failure envelope may carry. */
export const TOOL_CODES = [
	'INVALID_INPUT',
	'UNSUPPORTED',
	'NOT_FOUND',
	// chunks / get: every chunk of the document is in the trash (restore it to read it).
	'IN_TRASH',
	'RESERVED_ID',
	'COLLECTION_MISSING',
	'STORE_ERROR',
	'DIMENSION_MISMATCH',
	'MODEL_MISMATCH',
	'NO_EMBEDDER',
	'LIMIT_EXCEEDED',
	'SAMPLE_EXPIRED',
	'BUSY',
	'TIMEOUT',
	'RATE_LIMITED',
	'WRITES_DISABLED',
	'WRITES_SOURCE',
	'WRITES_PUBLIC',
	'WRITES_BROADCAST',
	'WRITES_UNKNOWN_CALLER',
	'READS_PUBLIC',
] as const;

/** A documented failure code. */
export type ToolCode = (typeof TOOL_CODES)[number];

/** Every caveat a tool answer may carry. */
export const CAVEATS = [
	'brute_force_search',
	'no_filtered_count',
	'biased_sample',
	'score_scale_raw',
	'score_scale_inverted_fixed',
	'shared_org_table',
	'experimental',
	'cloud_only_unverified',
	'extras_not_stored',
	'documents_by_first_chunk',
	'document_count_capped',
	'documents_unsorted',
	'documents_paging_unsupported',
	'model_mismatch',
	'meta_column_pending',
	'filtered_search_may_underfill',
	// Additive extensions (contract section 4.4).
	'listing_truncated',
	'documents_filter_partial',
	'documents_filter_client',
	// The trash (contract section 4.5).
	'trash_scan_cut',
] as const;

/** A documented caveat. */
export type Caveat = (typeof CAVEATS)[number];

/** Boolean keys of `dialect.capabilities`. */
export const CAPABILITY_KEYS = [
	'describe',
	'count',
	'count_documents',
	'documents',
	'documents_distinct',
	'documents_sorted',
	'chunks',
	'vectors',
	'sample',
	'sample_light',
	'sample_stratified_native',
	'knn_native',
	'project',
	'neighbors',
	'search_vector',
	'search_keyword',
	'remove',
	'remove_count',
	'soft_delete',
	'embed_node',
	// Additive extensions (contract section 4.4): absent or false until the node offers them.
	'clusters',
	'documents_filter',
	'recommend_best_score',
] as const;

/** A boolean capability key. */
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Tools on a vector store node (bare names; the app always passes the node id). */
export const VECTOR_STORE_TOOLS = [
	'dialect',
	'stats',
	'list_documents',
	'chunks',
	'vectors',
	'sample',
	'project',
	'neighbors',
	'search',
	// The writes: delete is the only permanent delete; soft_delete and restore move documents into and out of the trash.
	'delete',
	'soft_delete',
	'restore',
	'upsert',
	'get',
	'objdir',
	// Additive extensions (contract section 4.4): answered by nodes that have them.
	'recommend',
	'similarity_matrix',
] as const;

/** A vector store tool name. */
export type VectorStoreTool = (typeof VECTOR_STORE_TOOLS)[number];

/** The tool on the embedding node (embed_1). */
export const EMBED_TOOL = 'embed';

/** objectId of the collection's control record: never listed, never removable. */
export const CONTROL_OBJECT_ID = 'schema';

/** `(objectId, chunkId)` — the logical key of a chunk on every backend. */
export type VectorKey = readonly [objectId: string, chunkId: number];

/** Which rows a listing covers. */
export type Deleted = 'active' | 'deleted' | 'all';

/** Similarity metric of a store. */
export type VectorMetric = 'cosine' | 'l2' | 'ip';

/** Backend family reported by `dialect.backend`. */
export type VectorBackend = 'pgvector' | 'qdrant' | 'chroma' | 'milvus' | 'weaviate' | 'pinecone' | 'astra' | 'atlas';

/** Support level reported by `dialect.support`. */
export type SupportLevel = 'supported' | 'experimental';

/** Sampling strategies (`sample.strategy`, `sample.strategy_used`). */
export type SampleStrategy = 'random' | 'stratified' | 'first';

/** Sample density: detailed (snippets, k ≤ 30, ≤ 2,000 points) or light (no text, k ≤ 10, ≤ 5,000 points). */
export type SampleMode = 'detailed' | 'light';

/** Who computed a kNN graph. */
export type KnnSource = 'native' | 'node';

// -----------------------------------------------------------------------------
// Envelope
// -----------------------------------------------------------------------------

/**
 * The failure envelope every tool answers with instead of raising. Extra keys
 * ride along for some codes (for example `retry_after_s` with RATE_LIMITED).
 * Older nodes answer legacy failures without `code`.
 */
export interface IToolFailure {
	success: false;
	/** A documented code; absent on legacy answers. */
	code?: ToolCode | string;
	/** A plain sentence. */
	error: string;
	detail?: string;
	/** Seconds until an embed call may be retried (RATE_LIMITED). */
	retry_after_s?: number;
	[extra: string]: unknown;
}

// -----------------------------------------------------------------------------
// dialect (the probe)
// -----------------------------------------------------------------------------

/** `dialect.capabilities`: the boolean keys plus the projections the node can compute. */
export type IVectorCapabilities = { [K in CapabilityKey]?: boolean } & {
	/** Projections the node computes (v1: ['pca']). */
	projection?: string[];
};

/** `dialect.limits`, enforced on the node; the app copies them for UX only. */
export interface IVectorLimits {
	documents_page: number;
	chunks_page: number;
	vectors_keys_max: number;
	sample_default: number;
	sample_max: number;
	sample_max_light: number;
	snippet_chars: number;
	knn_k_max: number;
	neighbors_k_max: number;
	project_keys_max: number;
	scope_keys_max: number;
	top_k_max: number;
	write_ids_max: number;
	sample_budget_ms: number;
	/** pgvector's statement deadline; null on backends without one. */
	statement_timeout_ms: number | null;
	counts_cached_s: number;
	/** Example keys per side of a `recommend` call (contract section 4.4-D); absent on older nodes. */
	recommend_examples_max?: number;
	/** Keys of a `similarity_matrix` call (section 4.4-E); absent on older nodes. */
	matrix_keys_max?: number;
	/** Clusters a `sample` answer keeps; the rest are noise (section 4.4-C); absent on older nodes. */
	max_components?: number;
}

/** How a store computes `score`. */
export interface IScoreInfo {
	/** Human formula, e.g. '1 - cosine_distance'; 'unknown' when the driver does not say. */
	formula: string;
	range?: [number, number];
	higher_is_better: boolean;
	/** The driver's own floor: search drops rows below it unless asked not to. */
	floor: number;
	/** The node's configured score threshold. */
	threshold: number | null;
}

/** `dialect.health`. */
export interface IVectorHealth {
	collection_exists: boolean;
	/** False means "Repair needed"; null when the collection does not exist. */
	control_record: boolean | null;
	/** True when the node's embedding model differs from the one the collection was built with; null when not checked. */
	model_mismatch: boolean | null;
	/** pgvector: false while the metadata column is pending; null elsewhere. */
	meta_column: boolean | null;
}

/** `dialect` answer. Never carries a host, port, DSN or database name. */
export interface IDialectResult {
	success: true;
	dialect: 'vector';
	/** Contract revision, 'vector/1'. */
	contract: string;
	/** Component provider of the node, e.g. 'postgres', 'qdrant', 'rocketride_vector'. */
	provider: string;
	backend: VectorBackend | string;
	backend_version: string | null;
	collection: string | null;
	metric: VectorMetric | null;
	model: string | null;
	dimension: number | null;
	index: { type: string; params?: Record<string, unknown> } | null;
	score: IScoreInfo;
	support: SupportLevel;
	/** Whether a DAP caller (this app) may write; agents have no switch of their own (the node's allow_write decides). */
	allow_writes: boolean;
	/** v1: 'tools_source' (external writes are honoured only from a Tools source). */
	writes_scope: string;
	write_tools: string[];
	capabilities: IVectorCapabilities;
	limits: IVectorLimits;
	health: IVectorHealth;
	caveats: Array<Caveat | string>;
	/** Bytes the collection takes on the store (pgvector: the table's total relation size); null or absent when unknown. */
	size_bytes?: number | null;
	/** What a keyword search matches on this store (section 4.4-G); null or absent when it does not say. */
	keyword_match?: KeywordMatch | null;
}

/** `dialect.keyword_match`: text fragments (pgvector ILIKE, Chroma $contains) or whole words (Qdrant's text index). */
export type KeywordMatch = 'substring' | 'token';

// -----------------------------------------------------------------------------
// stats
// -----------------------------------------------------------------------------

/** `stats` input. */
export interface IStatsInput {
	/** 'full' (default) recomputes filtered counts; 'quick' returns the raw count plus cached figures. */
	mode?: 'full' | 'quick';
}

/**
 * `stats` answer. `count`, `model` and `vector_size` are the legacy keys (an
 * older node answers only those); the extended keys are null where the store
 * cannot count. A missing collection answers `count: 0, model: '', vector_size: 0,
 * collection_exists: false` with the extended keys null.
 */
export interface IStatsResult {
	success: true;
	/** Legacy semantics (raw rows incl. the control record); shown only in a tooltip. */
	count: number;
	model: string;
	vector_size: number;
	collection_exists?: boolean;
	documents?: number | null;
	documents_without_first_chunk?: number | null;
	chunks?: number | null;
	deleted_chunks?: number | null;
	/** Documents with at least one chunk in the trash (the Trash listing's size); null where the store cannot count. */
	deleted_documents?: number | null;
	raw_count?: number | null;
	tables?: number | null;
	avg_chunks_per_document?: number | null;
	dimension?: number | null;
	metric?: VectorMetric | string | null;
	/** UTC ISO-8601 of this answer. */
	computed_at?: string | null;
	/** UTC ISO-8601 of the cached filtered counts. */
	counts_as_of?: string | null;
	caveats?: Array<Caveat | string>;
}

// -----------------------------------------------------------------------------
// documents
// -----------------------------------------------------------------------------

/**
 * `documents.filter` (contract section 4.4-A). Every key is optional; null or
 * absent means "not filtered by it". A node refuses an unknown key, a date that
 * is not ISO-8601, text over 1,024 characters and `min_chunks > max_chunks`
 * with INVALID_INPUT.
 */
export interface IDocumentsFilter {
	/** The path starts with this text (case-sensitive). */
	path_prefix?: string | null;
	/** Extensions without the dot, e.g. ['md', 'pdf']. */
	file_types?: string[] | null;
	/** UTC ISO-8601: ingested at or after. */
	ingested_after?: string | null;
	/** UTC ISO-8601: ingested before. */
	ingested_before?: string | null;
	min_chunks?: number | null;
	max_chunks?: number | null;
	/** true: has chunk 0; false: has none. */
	has_first_chunk?: boolean | null;
	/** true: at least one table chunk; false: none. */
	has_tables?: boolean | null;
	/** The path contains this text, ignoring case (the directory's path box). */
	path_contains?: string | null;
}

/** The keys of {@link IDocumentsFilter}, in documentation order (mirror vx_types.DOC_LIST_FILTER_KEYS). */
export const DOCUMENTS_FILTER_KEYS = ['path_prefix', 'file_types', 'ingested_after', 'ingested_before', 'min_chunks', 'max_chunks', 'has_first_chunk', 'has_tables', 'path_contains'] as const;

/** `documents.filter_applied`: the store applied every given key, some of them, or none (the app filters the loaded rows itself). */
export type FilterApplied = 'server' | 'partial' | 'none';

/**
 * `list_documents` input (the tool was `documents`). `deleted: 'deleted'` is the Trash view: documents with at
 * least one chunk in the trash. #2704's callers may also send `deleted: true | false` and an exact `parent`.
 */
export interface IDocumentsInput {
	cursor?: string | null;
	/** Clamped to `limits.documents_page` (answer then carries warnings ['limit_clamped']). */
	limit?: number;
	object_ids?: string[] | null;
	deleted?: Deleted | boolean;
	/** The exact stored path (#2704's filter); `total` is then null and a page can be short. */
	parent?: string;
	sort?: 'path';
	/** Section 4.4-A; an older node ignores it (the answer then carries no `filter_applied`). */
	filter?: IDocumentsFilter | null;
}

/** One document (one objectId). */
export interface IDocumentItem {
	objectId: string;
	path: string;
	/** null when the store cannot count chunks per document. */
	chunks: number | null;
	has_first_chunk: boolean;
	tables: number | null;
	deleted: boolean;
	nodeId: string | null;
	size: number | null;
	modifyTime: number | null;
	/** UTC ISO-8601. */
	ingestedAt: string | null;
	pointId: string | null;
	/** Highest chunk id the listing's `deleted` mode selects (section 4.4-F); null or absent when the store does not report it. */
	max_chunk_id?: number | null;
	/** The document's soft-deleted rows, whatever the listing's mode (section 4.4-F); null or absent when not reported. */
	deleted_chunks?: number | null;
}

/** `list_documents` answer (a list page, never a dict). */
export interface IDocumentsResult {
	success: true;
	items: IDocumentItem[];
	next_cursor: string | null;
	total: number | null;
	counts_exact: boolean;
	distinct: boolean;
	/** false: the client sorts loaded rows (caveat 'documents_unsorted'). */
	sorted: boolean;
	caveats: Array<Caveat | string>;
	warnings?: string[];
	/** With a `filter`: how much of it the store applied (section 4.4-A); absent without one or on an older node. */
	filter_applied?: FilterApplied;
	/** The given filter keys the store did not apply: some under 'partial', all of them under 'none'. */
	filter_ignored?: string[];
}

// -----------------------------------------------------------------------------
// chunks
// -----------------------------------------------------------------------------

/** `chunks` input. `{ object_id, limit: 1 }` is the app's existence probe. */
export interface IChunksInput {
	object_id: string;
	/** Default -1 (from the first chunk). */
	after_chunk?: number;
	limit?: number;
	deleted?: Deleted;
}

/** One chunk. Never carries a vector. */
export interface IChunkItem {
	chunkId: number;
	content: string;
	length: number;
	isTable: boolean;
	tableId: number;
	isDeleted: boolean;
	pointId: string | null;
	metadata: Record<string, unknown>;
}

/** `chunks` answer. NOT_FOUND for 'schema' or an unknown objectId. */
export interface IChunksResult {
	success: true;
	items: IChunkItem[];
	has_more: boolean;
	next_after: number;
	total: number | null;
}

// -----------------------------------------------------------------------------
// vectors (the only tool that returns stored vectors; ≤ 2 keys)
// -----------------------------------------------------------------------------

/** `vectors` input. */
export interface IVectorsInput {
	keys: VectorKey[];
}

/** One stored vector. */
export interface IVectorItem {
	key: VectorKey;
	pointId: string | null;
	dimension: number;
	norm: number;
	values: number[];
}

/** `vectors` answer. */
export interface IVectorsResult {
	success: true;
	items: IVectorItem[];
	model: string | null;
}

// -----------------------------------------------------------------------------
// sample
// -----------------------------------------------------------------------------

/** `sample` input. */
export interface ISampleInput {
	n?: number;
	seed?: number;
	strategy?: SampleStrategy;
	mode?: SampleMode;
	include_keys?: VectorKey[];
	filter?: { object_ids?: string[] | null };
	deleted?: Deleted;
	knn_k?: number;
	components?: 2 | 3;
	duplicate_threshold?: number;
	include_text?: boolean;
	/** Ask the node for clusters (section 4.4-C); refused with INVALID_INPUT by a node that does not know the method. */
	cluster?: ISampleClusterInput;
}

/** How a sample's clusters are computed (only 'knn-components'; 'label-propagation' is reserved). */
export type ClusterMethod = 'knn-components';

/** `sample.cluster`. */
export interface ISampleClusterInput {
	method: ClusterMethod;
	/** Label the largest clusters with their most frequent terms (default true). */
	labels?: boolean;
}

/** One document represented in a sample. `i` is its index in `docs`. */
export interface ISampleDoc {
	i: number;
	objectId: string;
	path: string;
	chunks: number | null;
	in_sample: number;
}

/** Sample points, columnar (index = point number). */
export interface ISamplePoints {
	/** Index into `docs`. */
	doc: number[];
	chunk: number[];
	/** PCA coordinates. */
	x: number[];
	y: number[];
	z?: number[];
	/** Chunk length in characters. */
	len: number[];
	/** Snippets (≤ snippet_chars); absent in light mode. */
	snip?: string[];
	/** 1 when the point was pinned by `include_keys`. */
	pinned: number[];
	/** 1 for a table chunk (section 4.4-C); absent on older nodes. */
	table?: number[];
}

/** kNN graph in Qdrant's offsets layout: row i's neighbours are cols[offsets_row[i]..offsets_row[i+1]). */
export interface IKnnBlock {
	k: number;
	offsets_row: number[];
	cols: number[];
	sims: number[];
}

/** A near-duplicate pair (point indices). */
export interface IDuplicatePair {
	a: number;
	b: number;
	sim: number;
}

/** `sample` answer. Positions are server-side PCA; no raw vectors. */
export interface ISampleResult {
	success: true;
	/** 's-<seed>-<8 hex>'; cached on the node for `expires_in_s`. */
	sample_id: string;
	expires_in_s: number;
	/** Points actually returned (may be < n_requested). */
	n: number;
	n_requested: number;
	mode: SampleMode;
	of: { chunks: number | null; documents: number | null };
	strategy_used: SampleStrategy;
	/** True when the sample is not uniform (a refill happened, or strategy 'first'). */
	biased: boolean;
	knn_source: KnnSource;
	metric: VectorMetric;
	dimension: number;
	docs: ISampleDoc[];
	points: ISamplePoints;
	knn: IKnnBlock;
	density: number[];
	outliers: number[];
	duplicates: IDuplicatePair[];
	pca: { explained: number[] };
	took_ms: number;
	caveats?: Array<Caveat | string>;
	/** Present when `cluster` was sent to a node that computes clusters (section 4.4-C). */
	clusters?: ISampleClusters;
	/** How the sampler's document listing ended (section 4.4-B); absent on older nodes. */
	listing?: ISampleListing;
}

/**
 * `sample.clusters`: connected groups of the sample's mutual kNN edges at or
 * above `edge_threshold` (the `percentile`-th percentile of the sample's edge
 * similarities, raised in steps of 10 while one group holds half the points).
 * Groups are numbered by size, largest first; `labels[i]` is point i's group
 * or -1 (noise). The node keeps every group of 2 or more points, up to
 * `limits.max_components`; the app folds groups below its own minimum size.
 */
export interface ISampleClusters {
	method: ClusterMethod;
	edge_threshold: number;
	percentile: number;
	/** Groups kept. */
	count: number;
	/** Points in no group. */
	noise: number;
	/** One group number per point (-1 = noise). */
	labels: number[];
	/** Points per group, by group number. */
	sizes: number[];
	/** Up to 5 terms per group, by group number ([] for an unlabelled group). */
	keywords: string[][];
	/** Groups labelled (the largest with at least 5 points, at most 50). */
	labelled: number;
	/** Where the terms come from: chunk text, path segments, or null when there is neither. */
	label_source: 'text' | 'paths' | null;
	/** Most chunks read per labelled group. */
	labelled_from: number;
	took_ms: { clusters: number; labels: number };
}

/** Why the sampler's document listing ended. */
export type ListingReason = 'complete' | 'cap' | 'stale' | 'pages' | 'budget';

/**
 * `sample.listing`: the documents the sampler listed to build its key space.
 * `truncated` is true when the listing still had pages left when it stopped;
 * the answer then carries the caveat 'listing_truncated'.
 */
export interface ISampleListing {
	documents: number;
	truncated: boolean;
	reason: ListingReason;
}

// -----------------------------------------------------------------------------
// project
// -----------------------------------------------------------------------------

/** `project` input: exactly one of `vector` (a query vector from `embed`) or `keys`. */
export type IProjectInput =
	| { sample_id: string; vector: number[]; keys?: never; m?: number; with_similarities?: boolean }
	| { sample_id: string; keys: VectorKey[]; vector?: never; m?: number; with_similarities?: boolean };

/** One projected item. */
export interface IProjectItem {
	/** null for a projected vector. */
	key: VectorKey | null;
	/** Point index when the key is in the sample, else null. */
	in_sample: number | null;
	/** Coordinates in the sample's PCA basis. */
	pca: number[];
	/** Nearest sample points. */
	neighbors: Array<{ i: number; sim: number }>;
}

/** `project` answer. SAMPLE_EXPIRED when the node no longer holds the sample. */
export interface IProjectResult {
	success: true;
	items: IProjectItem[];
	/** Similarity of the vector to every sample point (with_similarities). */
	similarities?: number[];
	dimension: number;
}

// -----------------------------------------------------------------------------
// neighbors
// -----------------------------------------------------------------------------

/** `neighbors` input: one of `key` or `vector`. */
export type INeighborsInput = ({ key: VectorKey; vector?: never } | { vector: number[]; key?: never }) & {
	k?: number;
	exclude_self?: boolean;
	filter?: { object_ids?: string[] | null };
	/** Score these keys instead of searching (≤ scope_keys_max). */
	scope_keys?: VectorKey[] | null;
};

/** One neighbour from the whole collection. */
export interface INeighborItem {
	key: VectorKey;
	/** Recomputed by the store's metric (one similarity for every visual). */
	sim: number;
	/** The driver's own score (see dialect.score). */
	score: number | null;
	below_floor: boolean;
	path: string;
	chunkId: number;
	preview: string;
}

/** `neighbors` answer (whole collection). */
export interface INeighborsResult {
	success: true;
	items: INeighborItem[];
	metric: VectorMetric;
	scope: 'collection';
	k_requested: number;
}

/** `neighbors` answer with `scope_keys`. */
export interface INeighborsScopeResult {
	success: true;
	scores: number[];
}

// -----------------------------------------------------------------------------
// recommend (section 4.4-D; keys only, the one vector it accepts is the query vector)
// -----------------------------------------------------------------------------

/** How `recommend` combines its examples. 'best_score' is native (Qdrant) and needs `capabilities.recommend_best_score`. */
export type RecommendStrategy = 'average_vector' | 'best_score';

/** `recommend` input: at most `limits.recommend_examples_max` keys per side. */
export interface IRecommendInput {
	positive?: VectorKey[];
	negative?: VectorKey[];
	/** The query vector `embed` returned (counted as a positive), or null. Never a stored vector. */
	vector?: number[] | null;
	k?: number;
	strategy?: RecommendStrategy;
	filter?: { object_ids?: string[] | null };
	/** Leave the examples themselves out of the results (default true). */
	exclude_examples?: boolean;
}

/** `recommend` answer: neighbour rows of the whole collection. */
export interface IRecommendResult {
	success: true;
	items: INeighborItem[];
	strategy_used: RecommendStrategy;
	/** True when the store ranked natively (Qdrant's recommend query). */
	native: boolean;
	metric: VectorMetric;
	k_requested: number;
	examples_resolved: { positive: number; negative: number };
	/** Example keys the store does not hold. */
	not_found: VectorKey[];
}

// -----------------------------------------------------------------------------
// similarity_matrix (section 4.4-E; keys only, scalars back)
// -----------------------------------------------------------------------------

/** `similarity_matrix` input: 2 to `limits.matrix_keys_max` keys. */
export interface ISimilarityMatrixInput {
	keys: VectorKey[];
}

/** Where the vectors of a matrix came from: the node's cached sample, the store, or both. */
export type MatrixSource = 'cache' | 'store' | 'mixed';

/** `similarity_matrix` answer over the keys it resolved (`n` of them, in `keys` order). */
export interface ISimilarityMatrixResult {
	success: true;
	n: number;
	keys: VectorKey[];
	metric: VectorMetric;
	/** Decimal places of every value. */
	dp: number;
	/** n × n similarities by the store's metric. */
	matrix: number[][];
	source: MatrixSource;
	/** Keys the store does not hold (left out of the matrix). */
	not_found: VectorKey[];
}

// -----------------------------------------------------------------------------
// search (legacy descriptor; additive DAP extension)
// -----------------------------------------------------------------------------

/** `search` input. `query` alone is the legacy agent call; `vector` is the DAP extension. */
export interface ISearchInput {
	query?: string;
	top_k?: number;
	vector?: number[];
	embedding_model?: string;
	mode?: 'auto' | 'semantic' | 'keyword';
	/** Legacy keys (objectId, nodeId, parent) or the extension keys (objectIds, isTable, minChunkId, maxChunkId). */
	filter?: {
		objectId?: string | string[];
		nodeId?: string;
		parent?: string;
		objectIds?: string[];
		isTable?: boolean;
		minChunkId?: number;
		maxChunkId?: number;
	};
	deleted?: Deleted;
	include_below_floor?: boolean;
	include_below_threshold?: boolean;
}

/** One search result. */
export interface ISearchItem {
	content: string;
	score: number;
	metadata: { objectId?: string; nodeId?: string; parent?: string; chunkId?: number; [key: string]: unknown };
	rank?: number;
	raw_score?: number;
	sim?: number;
	below_threshold?: boolean;
	below_floor?: boolean;
}

/** `search` answer. `warnings` e.g. ['keyword_fallback', '<semantic error>'], ['model_mismatch']. */
export interface ISearchResult {
	success?: true;
	results: ISearchItem[];
	total: number;
	warnings?: string[];
	mode_used?: 'semantic' | 'keyword';
}

// -----------------------------------------------------------------------------
// writes (gated on the node)
// -----------------------------------------------------------------------------

/** The audit block every write answer carries. Never content or vectors. */
export interface IWriteAudit {
	action: string;
	node: string;
	provider: string;
	collection: string | null;
	object_ids: string[];
	rows: number | null;
	caller: { auth: string; userId?: string | null; teamId?: string | null };
}

/** `soft_delete` and `restore` input (1..write_ids_max ids for the app). */
export interface ISoftDeleteInput {
	object_ids: string[];
}

/**
 * `soft_delete` (move to the trash) and `restore` (back out of it) answer. `matched_chunks` counts the chunks
 * the call moved (0 for a document already in that state), or null where the store cannot count; a restore of
 * a document that is not in the trash changes nothing for it. `audit.action` is `vector.soft_delete` or
 * `vector.restore`.
 */
export interface ISoftDeleteResult {
	success: true;
	/** The ids asked for, distinct, in request order. */
	object_ids: string[];
	matched_chunks: number | null;
	not_found: string[];
	audit: IWriteAudit;
}

/** `delete` input: the only permanent delete. `deleted_only` removes a document only when every chunk of it is in the trash. */
export interface IDeleteInput {
	object_ids: string[];
	deleted_only?: boolean;
}

/** `delete` answer. `kept_live`: with `deleted_only`, the documents left untouched because a chunk of them is live ([] otherwise). */
export interface IDeleteResult {
	success: true;
	deleted_count: number;
	removed_chunks?: number | null;
	not_found?: string[];
	kept_live?: string[];
	audit?: IWriteAudit;
}

/** `upsert` (legacy) input; the app never calls it. External callers may not supply embeddings. */
export interface IUpsertInput {
	documents: Array<{ content: string; object_id?: string; metadata?: Record<string, unknown> }>;
}

/** `upsert` (legacy) answer. */
export interface IUpsertResult {
	success: boolean;
	[key: string]: unknown;
}

// -----------------------------------------------------------------------------
// get / objdir (legacy descriptors; fixed)
// -----------------------------------------------------------------------------

/** `get` input. */
export interface IGetInput {
	object_id: string;
	offset?: number;
	limit?: number;
}

/** `get` answer. */
export interface IGetResult {
	success: true;
	chunks: Array<{ content: string; chunkId: number; metadata: Record<string, unknown> }>;
	total: number;
	has_more?: boolean;
}

/** `objdir` input. */
export interface IObjdirInput {
	parent?: string;
	offset?: number;
	limit?: number;
}

/** `objdir` answer: legacy `paths` (path -> objectId) plus `entries`. */
export interface IObjdirResult {
	success: true;
	paths: Record<string, string>;
	entries?: Array<{ path: string; objectId: string }>;
}

// -----------------------------------------------------------------------------
// embed (on the embedding node)
// -----------------------------------------------------------------------------

/** `embed` input: 1..8 texts, each ≤ 8,000 characters. */
export interface IEmbedInput {
	texts: string[];
	kind?: 'query' | 'document';
}

/** `embed` answer. RATE_LIMITED carries retry_after_s. */
export interface IEmbedResult {
	success: true;
	model: string;
	dimension: number;
	vectors: number[][];
	prefix_applied: string | null;
	ms: number;
}

// -----------------------------------------------------------------------------
// Typed tool map
// -----------------------------------------------------------------------------

/** Input and answer of every tool, for typed invoke helpers. */
export interface VectorToolMap {
	dialect: { input: Record<string, never>; result: IDialectResult };
	stats: { input: IStatsInput; result: IStatsResult };
	list_documents: { input: IDocumentsInput; result: IDocumentsResult };
	chunks: { input: IChunksInput; result: IChunksResult };
	vectors: { input: IVectorsInput; result: IVectorsResult };
	sample: { input: ISampleInput; result: ISampleResult };
	project: { input: IProjectInput; result: IProjectResult };
	neighbors: { input: INeighborsInput; result: INeighborsResult | INeighborsScopeResult };
	search: { input: ISearchInput; result: ISearchResult };
	delete: { input: IDeleteInput; result: IDeleteResult };
	soft_delete: { input: ISoftDeleteInput; result: ISoftDeleteResult };
	restore: { input: ISoftDeleteInput; result: ISoftDeleteResult };
	upsert: { input: IUpsertInput; result: IUpsertResult };
	get: { input: IGetInput; result: IGetResult };
	objdir: { input: IObjdirInput; result: IObjdirResult };
	embed: { input: IEmbedInput; result: IEmbedResult };
	recommend: { input: IRecommendInput; result: IRecommendResult };
	similarity_matrix: { input: ISimilarityMatrixInput; result: ISimilarityMatrixResult };
}

// -----------------------------------------------------------------------------
// Chat and upload (data lanes, not tools)
// -----------------------------------------------------------------------------

/** One document in a chat result's `documents` (from the pipeline's response_documents node). */
export interface IChatDocumentWire {
	type?: string;
	page_content: string;
	score?: number;
	metadata: { objectId?: string; chunkId?: number; parent?: string; nodeId?: string; [key: string]: unknown };
}

/** A chat answer as the chat source returns it. */
export interface IChatResultWire {
	answers?: unknown;
	documents?: IChatDocumentWire[];
	result_types?: Record<string, string>;
	[key: string]: unknown;
}

/** A cited source, parsed from a chat answer. */
export interface IChatSource {
	rank: number;
	key: VectorKey;
	objectId: string;
	chunkId: number;
	/** The document path (metadata.parent). */
	path: string;
	/** The driver's score, when present. */
	score: number | null;
	text: string;
}

/** An `apaevt_status_upload` event body (the SDK keys it by file name). */
export interface IUploadEvent {
	action: 'open' | 'write' | 'close' | 'complete' | 'error';
	filepath: string;
	bytes_sent: number;
	file_size: number;
	upload_time: number;
	result?: Record<string, unknown>;
	error?: string;
}

// =============================================================================
// 2. APP TYPES
// =============================================================================

/** A Vector Explorer connection: the shared library's endpoint plus its dialect probe answer. */
export interface VectorEndpoint {
	/** Token-free endpoint (from the shared library). */
	endpoint: IExplorerEndpoint;
	/** The probe's answer; null until it answered or when it failed. */
	dialect: IDialectResult | null;
}

/** Component ids of the nodes a connection uses. */
export interface VectorNodes {
	/** The store node (endpoint.nodeId). */
	store: string;
	/** The embedding node the Tools source reaches (embed_1), or null. */
	embed: string | null;
	/** The LLM node on the chat path, or null. */
	llm: string | null;
	/** The LLM node's display name (the only LLM detail the app shows). */
	llmName: string | null;
}

/** Whether an action is available, and if not, the sentence that says why. */
export interface Availability {
	enabled: boolean;
	/** Shown on the disabled control; null when enabled. */
	reason: string | null;
}

/** The role channels of a connection (shared library `IEndpointStore.channel`); null when the role is not bound. */
export interface VectorChannels {
	tools: IRoleChannel | null;
	chat: IRoleChannel | null;
	ingest: IRoleChannel | null;
}

/**
 * What the console knows about the open connection, handed read-only to every
 * panel and to the map. Rebuilt by the console; panels never mutate it.
 */
export interface ConsoleModel {
	/** endpoint.key — the identity every per-connection cache is keyed by. */
	connectionKey: string;
	connection: VectorEndpoint;
	nodes: VectorNodes;
	/** Collection name (dialect), or null. */
	collection: string | null;
	/** Last `stats` answer, or null before the first. */
	stats: IStatsResult | null;
	/** Limits from the dialect, else the documented defaults. */
	limits: IVectorLimits;
	/** Capabilities from the dialect, else all false. */
	capabilities: IVectorCapabilities;
	/** Write controls (Move to trash, Restore, Delete permanently, Empty trash). */
	writes: Availability;
	/** Drop zone / Add files. */
	ingest: Availability;
	/** Chat panel. */
	chat: Availability;
	/** Text queries on the map and "Why these?" (needs `embed` reachable). */
	embed: Availability;
	/** True when the connection is anchored on a Chat or Ingest source (no Tools source running). */
	readOnly: boolean;
	/** The directory's scope (folder, file type, dates...), shared with the map, search and chat; null or absent with none. */
	scope?: IScopeState | null;
}

/** Where a scope applies (the toggles beside its conditions). */
export interface IScopeTargets {
	documents: boolean;
	map: boolean;
	search: boolean;
	chat: boolean;
}

/**
 * The console's scope: a set of conditions over the documents, resolved to the
 * objectIds it covers. Kept in memory per connection and cleared on a change of
 * identity; never more than `limits.scope_keys_max` ids leave the browser.
 */
export interface IScopeState {
	/** The conditions, in the wire shape of `documents.filter`. */
	filter: IDocumentsFilter;
	/** Words for the conditions, e.g. 'folder is under C:/demo/handbooks/'. */
	label: string;
	/** The documents in scope (at most scope_keys_max), or null while unresolved or when there are more than that. */
	objectIds: readonly string[] | null;
	/** How many documents the scope covers when that is more than scope_keys_max (the map, search and chat are then off), else null. */
	overflow: number | null;
	applyTo: IScopeTargets;
}

/** A saved condition set (the 'saved filters' cache, per connection, in memory). */
export interface ISavedFilter {
	id: string;
	name: string;
	filter: IDocumentsFilter;
	/** Epoch ms. */
	savedAt: number;
}

/** The console's loaded directory rows, for views outside the console (the map's colouring and the duplicates queue's policies). */
export interface IDocumentRowsSource {
	/** The rows loaded so far, in the directory's order (a new array whenever they change). */
	getRows(): readonly IDocumentItem[];
	subscribe(listener: () => void): () => void;
}

/** A sample answer as the map holds it (never raw vectors). */
export interface ISampleModel {
	sampleId: string;
	seed: number;
	mode: SampleMode;
	/** Epoch ms when the answer arrived. */
	receivedAt: number;
	result: ISampleResult;
	/** Points added later through `project({ keys })` (answer sources outside the sample). */
	pinned: IProjectItem[];
	/** objectIds removed since the sample was drawn: their points are hidden, indices stay stable. */
	removed: readonly string[];
}

/** Why some keys are highlighted. */
export type HighlightSource = 'chat' | 'search' | 'neighbors' | 'lasso' | 'document';

/** The selection the console, the document tab and the map share (one per connection). */
export interface SelectionState {
	/** The connection this selection belongs to; null after a reset. */
	connectionKey: string | null;
	/** The document selected in the directory. */
	document: { objectId: string; path: string } | null;
	/** The focused chunk (inspector, chunk list). */
	chunk: VectorKey | null;
	/** Multi-selection (lasso, "Selection" tab). */
	keys: readonly VectorKey[];
	/** Highlighted keys and why (answer sources, query top-k, neighbours). */
	highlight: { source: HighlightSource; keys: readonly VectorKey[] } | null;
	/** The last query text run on the map, if any. */
	query: string | null;
	/** A second question to compare with `query` (Search's Compare: star B on the map), or null. */
	queryB: string | null;
	/** The current sample, if one was drawn. */
	sampleModel: ISampleModel | null;
}

/** The shared selection store (see bridge.ts). useSyncExternalStore-compatible. */
export interface SelectionStore {
	getState(): SelectionState;
	subscribe(listener: () => void): () => void;
	/** Forget everything and bind to `connectionKey` (connection change, sign-out with null). */
	reset(connectionKey: string | null): void;
	selectDocument(document: { objectId: string; path: string } | null): void;
	focusChunk(key: VectorKey | null): void;
	setKeys(keys: readonly VectorKey[]): void;
	setHighlight(highlight: SelectionState['highlight']): void;
	setQuery(query: string | null): void;
	/** Set the compared question (B), or clear it with null. */
	setQueryB(query: string | null): void;
	/** Clear the compared question (B). */
	clearQueryB(): void;
	setSampleModel(model: ISampleModel | null): void;
	/** Add projected points to the current sample model (no-op without one). */
	addPinned(items: readonly IProjectItem[]): void;
	/** After a removal: drop a document from the selection, highlight and sample model. */
	forgetDocument(objectId: string): void;
}

/** A document to stage for the trash: its path and chunk count where the caller knows them (the map's sample does). */
export interface IStageTarget {
	objectId: string;
	path?: string | null;
	chunks?: number | null;
}

/** What the map, document tab and panels ask the console to do (they never write on their own). */
export interface ConsoleActions {
	/** Open a document tab, optionally at a chunk. */
	openDocument(objectId: string, chunkId?: number): void;
	/** Switch to the Map tab and highlight these keys. */
	showOnMap(keys: readonly VectorKey[], source: HighlightSource): void;
	/** Ask to move documents to the trash: the console confirms (Cancel focused, nothing to type) and runs the gated soft_delete. */
	requestRemove(objectIds: readonly string[]): void;
	/**
	 * Stage documents to move to the trash; the console's pending bar applies them through requestRemove. A path or
	 * count the caller does not give is taken from the loaded rows. Absent where nothing can be staged (a dev-tool
	 * document frame): call requestRemove instead.
	 */
	stageRemove?(targets: readonly IStageTarget[]): void;
	/** Show one of the console's tabs (and bring the console to the front). Absent where the console is another frame's. */
	openTab?(tab: WorkbenchTab): void;
	/**
	 * "Use as query": hand this text to the Query tab's Search and show it. Absent where the console is another
	 * frame's (a dev-tool document frame, D9b).
	 */
	useAsQuery?(text: string): void;
	/** "Ask about these only": scope the next chat question to these documents, on the Query tab's Ask mode. */
	askAbout(objectIds: readonly string[]): void;
	/** After an upload completed or a document changed: refresh stats and the directory. */
	documentsChanged(objectIds: readonly string[]): void;
	/** Announce through the polite live region. */
	announce(message: string): void;
}

// -----------------------------------------------------------------------------
// Props of components rendered across lanes (frozen)
// -----------------------------------------------------------------------------

/** views/MapView.tsx — the second tab of a connection. */
export interface MapViewProps {
	model: ConsoleModel;
	channels: VectorChannels;
	selection: SelectionStore;
	actions: ConsoleActions;
	/** False while the tab is hidden: the canvas must not allocate or animate. */
	visible: boolean;
	/** The console's loaded directory rows (colour by document metadata, the duplicates queue's policies); absent: none. */
	documents?: IDocumentRowsSource | null;
	/** Which similarity edges the map starts with (default 'none'). */
	edges?: EdgeMode;
	/** Edges per point in 'neighbours' mode (default 5). */
	edgesM?: EdgesPerPoint;
	/** Drop to fewer edges when frames run slow (default true; the perf lane sets false). */
	edgesAutoDegrade?: boolean;
}

/** The map's similarity edges: none, each point's strongest kNN edges, or the maximum spanning tree. */
export type EdgeMode = 'none' | 'neighbours' | 'tree';

/** Edges per point in 'neighbours' mode. */
export type EdgesPerPoint = 3 | 5 | 10;

/** views/DocumentView.tsx — a document tab. */
export interface DocumentViewProps {
	model: ConsoleModel;
	channels: VectorChannels;
	selection: SelectionStore;
	actions: ConsoleActions;
	objectId: string;
	/** Known path, or null until loaded. */
	path: string | null;
	/** Chunk to scroll to on open. */
	chunkId?: number;
}

/** components/ChatPanel.tsx — the console's chat (R5). */
export interface ChatPanelProps {
	model: ConsoleModel;
	channels: VectorChannels;
	selection: SelectionStore;
	actions: ConsoleActions;
	/** objectIds the next question is restricted to ("Ask about these only"), or null. */
	scope: readonly string[] | null;
	/** Clear the scope. */
	onClearScope(): void;
}

/** components/IngestPanel.tsx — the console's drop zone and upload list (R4). */
export interface IngestPanelProps {
	model: ConsoleModel;
	channels: VectorChannels;
	actions: ConsoleActions;
	/** Names of other store nodes the ingest source also feeds ("This pipeline's ingest also reaches: …"). */
	alsoReaches: readonly string[];
}

/** components/HeatStrip.tsx — per-chunk similarity strip of one document for the active query. */
export interface HeatStripProps {
	/** Number of chunks in the document. */
	chunks: number;
	/** Similarity per chunk id that has one. */
	scores: ReadonlyArray<{ chunkId: number; sim: number }>;
	/** The chunk to outline, if any. */
	focused: number | null;
	onSelectChunk(chunkId: number): void;
	/** Accessible name, e.g. 'Similarity of each chunk to the query'. */
	label: string;
}

// -----------------------------------------------------------------------------
// Props of lane-internal components (the owning lane may add optional fields)
// -----------------------------------------------------------------------------

/** components/SourcesPanel.tsx (inside ChatPanel). */
export interface SourcesPanelProps {
	sources: readonly IChatSource[];
	score: IScoreInfo | null;
	onOpen(source: IChatSource): void;
	onShowOnMap(keys: readonly VectorKey[]): void;
}

/** components/RetrievalDebugger.tsx ("Why these?", inside ChatPanel). */
export interface RetrievalDebuggerProps {
	model: ConsoleModel;
	channels: VectorChannels;
	question: string;
	/** The answer's top-k (the debugger asks for k + 10). */
	topK: number;
	onClose(): void;
}

/** Layouts the map offers. */
export type MapLayout = 'pca' | 'neighbour-graph' | 'tsne';

/** Colour modes of the map ('cluster' needs `sample.clusters`). */
export type ColourBy = 'document' | 'folder' | 'type' | 'chunk-position' | 'query-similarity' | 'density' | 'cluster';

/** components/MapToolbar.tsx (inside MapView). */
export interface MapToolbarProps {
	limits: IVectorLimits;
	sample: ISampleModel | null;
	/** Busy label, e.g. 'Sampling…', 'Laying out…', or null. */
	busy: string | null;
	layout: MapLayout;
	colourBy: ColourBy;
	lasso: boolean;
	table: boolean;
	query: Availability;
	onSample(options: { n: number; mode: SampleMode; seed: number }): void;
	onLayout(layout: MapLayout): void;
	onCancel(): void;
	onColourBy(colourBy: ColourBy): void;
	onQuery(text: string): void;
	onToggleLasso(): void;
	onFit(): void;
	onToggleTable(): void;
}

/** components/PointCanvas.tsx (inside MapView). Positions are 2D or 3D layout coordinates, never vectors. */
export interface PointCanvasProps {
	sample: ISampleModel;
	/** Interleaved x,y(,z) per point from the current layout. */
	positions: Float32Array;
	dimensions: 2 | 3;
	/** One CSS colour per point. */
	colours: readonly string[];
	selection: SelectionStore;
	lasso: boolean;
	onHover(index: number | null): void;
	onPick(index: number | null): void;
	onLasso(indices: readonly number[]): void;
}

/** components/PointInspector.tsx (inside MapView). */
export interface PointInspectorProps {
	sample: ISampleModel;
	/** Point index, or null. */
	index: number | null;
	neighbours: INeighborsResult | null;
	/** Similarity to the active query, when there is one. */
	querySim: number | null;
	writes: Availability;
	onOpenDocument(objectId: string, chunkId: number): void;
	onFindSimilar(key: VectorKey): void;
	onRemoveDocument(objectId: string): void;
	/** With Tree edges drawn: the point's neighbours in the spanning tree; null or absent otherwise. */
	treeNeighbours?: readonly ITreeNeighbour[] | null;
	/** Add the point as a positive or negative example for Recommend; absent: no such buttons. */
	onAddExample?(key: VectorKey, polarity: ExamplePolarity): void;
	/** Show the chunk's full text (the map fetches it); absent: no such button. */
	onShowText?(key: VectorKey): void;
}

/** A neighbour of a point in the spanning tree: its point index and the edge's similarity. */
export interface ITreeNeighbour {
	i: number;
	sim: number;
}

/** Whether an example is one to find more like (positive) or less like (negative). */
export type ExamplePolarity = 'positive' | 'negative';

/** components/NeighbourList.tsx (inside PointInspector). */
export interface NeighbourListProps {
	items: readonly INeighborItem[];
	onSelect(key: VectorKey): void;
}

/** components/DuplicatesPanel.tsx (inside MapView). */
export interface DuplicatesPanelProps {
	sample: ISampleModel;
	writes: Availability;
	onSelect(indices: readonly number[]): void;
	onRemoveDocument(objectId: string): void;
	/** The connection (its 'reviewed documents' cache). */
	connectionKey?: string;
	/** The console's directory rows (paths, chunk counts, ingest times, sizes for the keep policies). */
	documents?: IDocumentRowsSource | null;
	/** Move several documents to the trash at once: the console confirms (nothing to type) and sends batches. */
	onRemoveDocuments?(objectIds: readonly string[]): void;
	onOpenDocument?(objectId: string, chunkId: number): void;
}

/** components/OutliersPanel.tsx (inside MapView). */
export interface OutliersPanelProps {
	sample: ISampleModel;
	onSelect(index: number): void;
	/** The connection (its 'reviewed documents' cache). */
	connectionKey?: string;
	writes?: Availability;
	/** Ask the console to remove the outlier's document (it confirms). */
	onRemoveDocument?(objectId: string): void;
	/** Show the point's neighbours (the Neighbours tab). */
	onShowNeighbours?(index: number): void;
}

/** components/PointsTable.tsx (the accessible alternative to the canvas). */
export interface PointsTableProps {
	sample: ISampleModel;
	/** Similarity to the active query per point, when there is one. */
	querySims: readonly number[] | null;
	selected: number | null;
	onSelect(index: number): void;
}

/** components/Legend.tsx (inside MapView). */
export interface LegendProps {
	sample: ISampleModel;
	colourBy: ColourBy;
	/** Point cap of the current mode (2,000 detailed / 5,000 light). */
	pointCap: number;
	/** Backend name for "neighbour graph computed by <backend>" when knn_source is 'native'. */
	backend: string | null;
}

// -----------------------------------------------------------------------------
// The additive features' components (contract section 4.4 and the enrichment
// backlog). Every one is mounted in its host from the start; until its feature
// is built it renders "Not built yet". Every one renders its root element with
// data-component="<ComponentName>" (built or not; the mount tests find it in
// its host), and a placeholder adds data-placeholder. Cross-lane props (a host
// of one lane renders it) are frozen: ExportMenuProps, SimilarityMatrixProps,
// RecommendPanelProps, SavedViewsMenuProps. The others are lane-internal (the
// owning lane may add optional fields).
// -----------------------------------------------------------------------------

/** The outcome of a call a panel asks its host to make (the host keeps what the panel must not hold, such as the query vector). */
export type ToolOutcome<T> = { ok: true; value: T } | { ok: false; code: string | undefined; message: string };

/** One cell of an exported row: words and numbers only, never a vector. */
export type ExportCell = string | number | boolean | null;

/** Rows to export, built only when the item is chosen. */
export interface IExportRows {
	/** Column names, in file order. */
	columns: readonly string[];
	rows: ReadonlyArray<Readonly<Record<string, ExportCell>>>;
}

/** What an export is of; part of the file name `vector-explorer_<collection>_<kind>_<yyyymmdd-hhmm>.<ext>`. */
export type ExportKind = 'points' | 'selection' | 'clusters' | 'duplicates' | 'outliers' | 'documents' | 'search' | 'retrieval' | 'matrix' | 'map';

/** One entry of an export menu. */
export interface IExportItem {
	/** Stable id (tests and the browser lanes pick by it), e.g. 'map-selection'. */
	id: string;
	/** The menu's words, e.g. 'Lasso selection (40 points)'. */
	label: string;
	kind: ExportKind;
	/** Why it cannot be exported now (e.g. 'Nothing selected'), or null. */
	disabled: string | null;
	/** The rows, for CSV and JSON. */
	rows?(): IExportRows;
	/** The picture, for PNG (the map composites its points, edges, overlay and legend). */
	png?(): Promise<Blob | null>;
}

/** The columns of the three row kinds the hosts export (`z` is empty in 2D). */
export const EXPORT_COLUMNS = {
	points: ['objectId', 'chunkId', 'path', 'chunk_index', 'length', 'density', 'cluster', 'cluster_label', 'query_similarity', 'is_duplicate', 'is_outlier', 'x', 'y', 'z', 'snippet'],
	documents: ['objectId', 'path', 'chunks', 'has_first_chunk', 'tables', 'size', 'ingestedAt', 'deleted_chunks', 'max_chunk_id'],
	search: ['rank', 'objectId', 'chunkId', 'path', 'score', 'raw_score', 'status', 'cited', 'preview'],
} as const;

/** components/ExportMenu.tsx (in the map toolbar, the directory, the search panel and the retrieval debugger). Frozen. */
export interface ExportMenuProps {
	items: readonly IExportItem[];
	/** The collection, for the file name (null: 'collection'). */
	collection: string | null;
	/** The menu button's words (default 'Export'). */
	label?: string;
	/** A file was handed to the browser: its name (for the announcement). */
	onExported?(fileName: string): void;
}

/** components/SimilarityMatrix.tsx (in the map's Selection tab). Frozen. */
export interface SimilarityMatrixProps {
	/** The selection's keys: sent as keys, never sample indices, so a re-drawn sample cannot shift the matrix. */
	keys: readonly VectorKey[];
	limits: IVectorLimits;
	/** The channel that reaches the store node, or null. */
	channel: Pick<IRoleChannel, 'invoke'> | null;
	storeNode: string;
	/** Row and column words for a key, e.g. 'C:/demo/a.md #3'. */
	labelOf(key: VectorKey): string;
	/** Highlight one pair on the map. */
	onShowPair?(a: VectorKey, b: VectorKey): void;
	/** Hand the matrix to the host's export. */
	onExport?(item: IExportItem): void;
}

/** The examples of a Recommend run (the 'recommend examples' cache: per connection, in memory). */
export interface IRecommendExamples {
	positive: readonly VectorKey[];
	negative: readonly VectorKey[];
	/** Count the active text query as a positive (its vector stays in the map). */
	withQuery: boolean;
}

/** What RecommendPanel asks the map to run. */
export interface IRecommendRequest {
	positive: VectorKey[];
	negative: VectorKey[];
	withQuery: boolean;
	k: number;
	strategy: RecommendStrategy;
}

/** components/RecommendPanel.tsx (a side tab of the map). Frozen. */
export interface RecommendPanelProps {
	sample: ISampleModel | null;
	limits: IVectorLimits;
	capabilities: IVectorCapabilities;
	examples: IRecommendExamples;
	onExamplesChange(next: IRecommendExamples): void;
	/** The active text query, when there is one ("+ current query"). */
	queryText: string | null;
	/** Run recommend: the map adds the query vector when asked, and the scope, then calls the store. */
	onRun(request: IRecommendRequest): Promise<ToolOutcome<IRecommendResult>>;
	/** Select a result on the map. */
	onSelect(key: VectorKey): void;
	/** Pin results that are outside the sample. */
	onPin(keys: readonly VectorKey[]): void;
}

/** What a saved view keeps. Never a token or a vector. */
export interface ISavedViewState {
	n: number;
	mode: SampleMode;
	seed: number;
	layout: MapLayout;
	colourBy: ColourBy;
	edges: EdgeMode;
	edgesM: EdgesPerPoint;
	minClusterSize: number;
	/** The text query (run again only on request: it costs an embed). */
	query: string | null;
	/** The saved filter the scope came from, or null. */
	scopeFilterId: string | null;
	/** The selection (at most scope_keys_max keys). */
	selection: readonly VectorKey[];
	/** The camera, opaque to the menu (the map reads it back). */
	camera: unknown;
}

/** A saved view (the 'saved views' cache: per connection, in memory, at most 20). */
export interface ISavedView extends ISavedViewState {
	id: string;
	name: string;
	/** Epoch ms. */
	savedAt: number;
}

/** What applying a view restored, for "1,340 of 1,900 selected points restored; 200 drawn hollow". */
export interface ISavedViewRestore {
	selected: number;
	restored: number;
	hollow: number;
	dropped: number;
}

/** components/SavedViewsMenu.tsx (the map toolbar's Views menu). Frozen. */
export interface SavedViewsMenuProps {
	connectionKey: string;
	limits: IVectorLimits;
	/** The view now, captured when Save is chosen; null without a sample. */
	current(): ISavedViewState | null;
	/** Apply a view: the map draws the sample again with its seed and scope, then restores the selection. */
	onApply(view: ISavedView): Promise<ISavedViewRestore | null>;
}

/** The minimum cluster size the map applies (in the browser, without a call). */
export type ClusterMinSize = 2 | 5 | 10;

/** components/ClustersPanel.tsx (a side tab of the map). Lane-internal. */
export interface ClustersPanelProps {
	sample: ISampleModel;
	minSize?: ClusterMinSize;
	onMinSize?(size: ClusterMinSize): void;
	chat?: Availability;
	/** Isolate one cluster. */
	onShow?(cluster: number): void;
	/** "Ask about these": the cluster's documents. */
	onAskAbout?(objectIds: readonly string[]): void;
	onSelect?(indices: readonly number[]): void;
}

/** components/SearchPanel.tsx (behind the chat panel's Search toggle). Lane-internal. */
export interface SearchPanelProps {
	model: ConsoleModel;
	channels: VectorChannels;
	selection: SelectionStore;
	actions: ConsoleActions;
	/** Filled by "Open in Search": the question and the keys its answer cited. */
	prefill?: { question: string; cited: readonly VectorKey[] } | null;
}

/** components/StatsCharts.tsx (the stats strip's Charts disclosure). Lane-internal. */
export interface StatsChartsProps {
	/** The directory rows loaded so far. */
	rows: readonly IDocumentItem[];
	/** Documents the store holds, when it counted them. */
	total?: number | null;
	/** The map's sample, for chunk lengths. */
	sample?: ISampleModel | null;
	dialect?: IDialectResult | null;
	/** A bar was clicked: scope the directory to it. */
	onScope?(filter: IDocumentsFilter): void;
}

/** components/HealthPanel.tsx (in a document tab). Lane-internal. */
export interface HealthPanelProps {
	/** The document's directory row, or null until it is loaded. */
	item: IDocumentItem | null;
	/** Median chunks per loaded document, for "oversize"; null when unknown. */
	medianChunks?: number | null;
}

/** components/ScopeBar.tsx (the directory's filter row). Lane-internal. */
export interface ScopeBarProps {
	/** The path box, the bar's always-visible first field. */
	text: string;
	onText(text: string): void;
	scope?: IScopeState | null;
	onScope?(scope: IScopeState | null): void;
}

/** components/ChunkTextPanel.tsx (in the point inspector). Lane-internal. */
export interface ChunkTextPanelProps {
	chunkKey: VectorKey;
	/** The full text, or null while it loads. */
	text: string | null;
	/** The active query, whose terms are marked. */
	query?: string | null;
	error?: string | null;
	onPrevious?(): void;
	onNext?(): void;
	onClose?(): void;
}

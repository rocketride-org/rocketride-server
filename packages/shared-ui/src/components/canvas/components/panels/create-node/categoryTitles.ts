// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/** Human-readable titles for inventory category keys. */
export const CATEGORY_TITLES: Record<string, string> = {
	source: 'Source',
	embedding: 'Embedding',
	llm: 'LLM',
	database: 'Database',
	filter: 'Filter',
	image: 'Image',
	preprocessor: 'Preprocessor',
	store: 'Store',
	agent: 'Agent',
	tool: 'Tool',
	other: 'Other',
};

/** Preferred display order — "source" first, then alphabetical by title. */
export const CATEGORY_ORDER = Object.keys(CATEGORY_TITLES);

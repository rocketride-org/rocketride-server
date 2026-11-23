// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

const CATEGORY_LABELS: Record<string, string> = {
	ai: 'AI',
};

export const formatCategory = (cat: string): string =>
	CATEGORY_LABELS[cat.toLowerCase()] ?? cat.charAt(0).toUpperCase() + cat.slice(1);

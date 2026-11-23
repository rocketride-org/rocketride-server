// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

const CATEGORY_LABELS: Record<string, string> = {
	ai: 'AI',
};

// Own labels only: a category named `constructor` or `__proto__` reads as any other word
export const formatCategory = (cat: string): string =>
	Object.hasOwn(CATEGORY_LABELS, cat.toLowerCase()) ? CATEGORY_LABELS[cat.toLowerCase()] : cat.charAt(0).toUpperCase() + cat.slice(1);

/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Stand-in for the node config form barrel (see resolve.ts). The canvas
 * types and helpers import two values from it; the form itself, and the
 * schema library behind it, never reach the widget.
 */
import type { PIPELINE_SCHEMA_VERSION as RealVersion } from '@app-shared/components/node-config';

/** Same value as the real export; tsc fails if the real one changes. */
export const PIPELINE_SCHEMA_VERSION: typeof RealVersion = 1;

/**
 * The builder fills a new node's form with schema defaults. The widget never
 * creates a node and draws no config, so there are no defaults to compute.
 */
export function getDefaultFormState(_schema: unknown): Record<string, unknown> {
	return {};
}

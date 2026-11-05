// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TEST SUPPORT: the wire fixtures (tests/fixtures/provisional, CONTRACT section 7)
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';

/** The provisional fixtures folder. */
export const PROVISIONAL = path.resolve(__dirname, '..', 'fixtures', 'provisional');

/**
 * Read one provisional fixture.
 *
 * @param name - The file name without `.json`.
 * @returns Its parsed JSON (a deep copy each call, so tests may change it).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture<T = any>(name: string): T {
	return JSON.parse(fs.readFileSync(path.join(PROVISIONAL, `${name}.json`), 'utf8')) as T;
}

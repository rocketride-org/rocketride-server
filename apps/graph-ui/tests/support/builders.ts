// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TEST SUPPORT - BUILDERS (re-exported) AND FIXTURE FILES
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import type { ReadQueryResult } from '../../src/graph/types';

export { deepFreeze, entitiesOf, generateGraph, node, prng, rel } from './generate';
export type { IGenerateOptions } from './generate';

/** Which fixture set: the driver-generated goldens, or the hand-modelled provisional ones. */
export type FixtureSet = 'v1' | 'provisional';

/** Read a JSON fixture by file name (without the .json). */
export function fixture<T = unknown>(name: string, set: FixtureSet = 'provisional'): T {
	return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', set, `${name}.json`), 'utf8')) as T;
}

/** A `read_query` fixture for an engine ('neo4j' | 'falkordb' | 'age') or a named variant. */
export function readQueryFixture(name: string, set: FixtureSet = 'provisional'): ReadQueryResult {
	return fixture<ReadQueryResult>(`read_query_${name}`, set);
}

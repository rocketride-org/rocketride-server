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

// =============================================================================
// VECTOR-UI - useSampleChunks (the drawer's two reads, on open)
// =============================================================================
//
// Asks the store for its first document and that document's first chunks
// once per open of a drawer (or the Details panel), unless the answer kept in
// memory is still good (vector/sampleChunks.ts). Nothing is sent for a store
// that cannot be read or holds no documents, and a late answer for a card
// that is no longer shown is dropped.
// =============================================================================

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { useVectorEnv } from '../envContext';
import { vectorCardView } from '../vector/connections';
import { readDialect } from '../vector/results';
import type { IStatsView } from '../vector/results';
import { cachedSample, loadSampleChunks, skipReason } from '../vector/sampleChunks';
import type { SampleState } from '../vector/sampleChunks';
import { failureText } from '../vector/wording';

const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/**
 * The sample chunks of one connection.
 *
 * @param endpoint - The connection.
 * @param probe - Its probe.
 * @param stats - The console's last stats, when it has them.
 * @returns The state the section shows.
 */
export function useSampleChunks(endpoint: IExplorerEndpoint, probe: IProbeResult | undefined, stats: IStatsView | null): SampleState {
	const env = useVectorEnv();
	const entry = env.existingConnection(endpoint.key);
	const writes = useSyncExternalStore(
		entry?.writes.subscribe ?? NO_SUBSCRIBE,
		() => entry?.writes.get() ?? 0,
		() => 0
	);
	const dialect = probe?.ok ? readDialect(probe.info) : null;
	const reason = skipReason(vectorCardView(endpoint, probe, stats).openable, dialect?.health.collection_exists !== false, stats);
	const channels = env.channels(endpoint);
	const caller = channels.tools ?? channels.chat ?? channels.ingest;
	const token = `${endpoint.key}#${writes}`;
	const [read, setRead] = useState<{ token: string; state: SampleState } | null>(null);
	useEffect(() => {
		if (reason !== null || caller === null) return undefined;
		const kept = cachedSample(endpoint.key, writes);
		if (kept !== undefined) {
			setRead({ token, state: kept === null ? { status: 'empty' } : { status: 'done', sample: kept } });
			return undefined;
		}
		let live = true;
		loadSampleChunks(caller, endpoint.nodeId, endpoint.key, writes).then(
			(sample) => {
				if (live) setRead({ token, state: sample === null ? { status: 'empty' } : { status: 'done', sample } });
			},
			(error) => {
				if (live) setRead({ token, state: { status: 'error', message: failureText(error)?.headline ?? 'The chunks could not be read.' } });
			}
		);
		return () => {
			live = false;
		};
		// `caller` is a fresh object each render in some mounts; the key and the write count say when to read again.
	}, [endpoint.key, endpoint.nodeId, writes, reason, caller === null]);
	if (reason !== null) return { status: 'skipped', reason };
	if (caller === null) return { status: 'skipped', reason: 'No source of this pipeline is running, so chunks cannot be read.' };
	return read !== null && read.token === token ? read.state : { status: 'loading' };
}

// MIT License
//
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
// GUARDS: when a batch stops starting trials
// =============================================================================

/**
 * Asked before each trial starts (schedule.ts QueueOptions.stop). A batch
 * stops starting trials once the finished trials' estimated cost reaches
 * the spend cap, or the output folder's disk has less free space than the
 * floor. Trials already running finish, and the run still writes
 * results.json and report.md, which say why it stopped.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The limits a batch runs under. */
export interface Guards {
	/** Stop once the finished trials' estimated cost is at or over this, in US dollars; null for no cap. */
	maxSpendUsd: number | null;
	/** Stop once the output folder's disk has less than this free, in GB (GiB, as `df -h` shows it). */
	minFreeGb: number;
}

/** Free space on the disk that holds `dir`, or its nearest existing parent, in GB (GiB). */
export function freeGb(dir: string): number {
	let at = path.resolve(dir);
	while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
	const s = fs.statfsSync(at);
	return (s.bavail * s.bsize) / 1024 ** 3;
}

/**
 * Why the batch must not start another trial, or null when it may.
 *
 * @param guards - The limits.
 * @param spentUsd - The finished trials' summed estimated cost.
 * @param free - The free space on the output folder's disk, in GB.
 */
export function stopReason(guards: Guards, spentUsd: number, free: number): string | null {
	if (guards.maxSpendUsd !== null && spentUsd >= guards.maxSpendUsd) return `the spend cap: the finished trials' estimated cost is $${spentUsd.toFixed(2)}, at or over --max-spend $${guards.maxSpendUsd.toFixed(2)}`;
	if (free < guards.minFreeGb) return `the disk floor: ${free.toFixed(1)} GB free on the output folder's disk, under --min-free-disk ${guards.minFreeGb} GB`;
	return null;
}

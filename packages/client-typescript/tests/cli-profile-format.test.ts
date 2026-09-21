/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Text formats of `rocketride profile threads` and `profile tree`.
 *
 * The fixtures and expected lines are copied verbatim in the Python suite
 * (client-python/tests/test_profile_cli_format.py): both CLIs must print
 * the same text, so a change to either format has to change both.
 */

import { describe, it, expect } from '@jest/globals';
import { formatProfileList, formatThreads, formatTree, waitForStop } from '../src/cli/commands/profile';
import type { ProfileListEntry } from '../src/cli/commands/profile';
import { takeInterrupt } from '../src/cli/common';
import type { CProfileReportTreeResponse, CProfileThreadInfo, CProfileTreeNode } from '../src/client/types';

const THREADS: CProfileThreadInfo[] = [
	{ id: 3, name: 'MainThread', tid: 8812, ttot: 10.1234, sched_count: 5, functions: 10, calls: 100 },
	{ id: 12, name: 'ThreadPoolExecutor-0_0', tid: 140234567890, ttot: 5.0, sched_count: 9, functions: 4, calls: 40 },
	{ id: 0, name: null, tid: 77, ttot: 0.0, sched_count: 1, functions: 0, calls: 0 },
];

function leaf(name: string, file: string, line: number, ncalls: number, tottime: number, cumtime: number): CProfileTreeNode {
	return { name, file, line, ncalls, tottime, cumtime, children: [] };
}

const TREE: CProfileReportTreeResponse = {
	tree: {
		name: '<root>',
		file: '',
		line: 0,
		ncalls: 1234,
		tottime: 0.0,
		cumtime: 12.5,
		children: [
			{
				name: 'run',
				file: 'ai/eaas.py',
				line: 120,
				ncalls: 1,
				tottime: 0.001,
				cumtime: 10.0,
				children: [
					{
						name: 'process',
						file: 'nodes/parse/parse.py',
						line: 88,
						ncalls: 1234,
						tottime: 0.25,
						cumtime: 8.75,
						children: [leaf('extract', 'nodes/parse/extract.py', 40, 12, 7.5, 7.5), leaf('process [cycle]', 'nodes/parse/parse.py', 88, 2, 0.0, 0.5)],
					},
					leaf("<method 'acquire' of '_thread.lock' objects>", '~', 0, 3, 1.0, 1.0),
				],
			},
			leaf('idle', '', 0, 5, 2.5, 2.5),
		],
	},
	total_time: 12.5,
	total_calls: 1234,
};

describe('profile threads format', () => {
	it('should print an aligned table with each thread share of the total', () => {
		// One line per printed line, to compare with the Python suite
		// prettier-ignore
		expect(formatThreads(THREADS)).toEqual([
			'ID  NAME                             TID     TIME  SHARE',
			' 3  MainThread                      8812  10.123s  66.9%',
			'12  ThreadPoolExecutor-0_0  140234567890   5.000s  33.1%',
			' 0  -                                 77   0.000s   0.0%',
			'3 thread(s), 15.123s total',
		]);
	});

	it('should say so when no thread was recorded', () => {
		expect(formatThreads([])).toEqual(['No threads recorded']);
	});
});

describe('profile tree format', () => {
	it('should draw the tree under the root totals, without the root itself', () => {
		// prettier-ignore
		expect(formatTree(TREE)).toEqual([
			'Call tree, all threads: 12.500s, 1,234 calls',
			'',
			'  CUM%     CUMTIME     TOTTIME      NCALLS  FUNCTION',
			' 80.0%     10.000s      0.001s           1  run  (ai/eaas.py:120)',
			' 70.0%      8.750s      0.250s       1,234  +-- process  (nodes/parse/parse.py:88)',
			' 60.0%      7.500s      7.500s          12  |   +-- extract  (nodes/parse/extract.py:40)',
			'  4.0%      0.500s      0.000s           2  |   `-- process [cycle]  (nodes/parse/parse.py:88)',
			"  8.0%      1.000s      1.000s           3  `-- <method 'acquire' of '_thread.lock' objects>  (~)",
			' 20.0%      2.500s      2.500s           5  idle',
		]);
	});

	it('should name the thread the tree was built for', () => {
		expect(formatTree(TREE, 3)[0]).toBe('Call tree, thread 3: 12.500s, 1,234 calls');
	});

	it('should say so when the tree has no calls', () => {
		expect(formatTree({ tree: null, total_time: 0, total_calls: 0 })).toEqual(['Call tree, all threads: 0.000s, 0 calls', 'No calls to show']);
	});

	it('should print no share when the total time is zero', () => {
		const result: CProfileReportTreeResponse = {
			tree: { name: '<root>', file: '', line: 0, ncalls: 1, tottime: 0.0, cumtime: 0.0, children: [leaf('f', 'a.py', 1, 1, 0.0, 0.0)] },
			total_time: 0,
			total_calls: 1,
		};
		expect(formatTree(result)[3]).toBe('     -      0.000s      0.000s           1  f  (a.py:1)');
	});
});

const PROCESSES: ProfileListEntry[] = [
	{ token: null, name: null, status: { active: false, owner: null, session: null, runtime: null, has_report: true } },
	{ token: 'PROFILE-DEMO', name: 'webhook_1', status: { active: true, owner: 'data:1503252257136', session: 'session_1789717993', runtime: 46.3241 } },
	{ token: 'DEMO-B', name: 'ingest', status: { active: false, owner: null, session: null, runtime: null, has_report: false } },
	{ token: 'DEMO-C', name: 'webhook_1', error: 'no answer within 10s' },
];

describe('profile list format', () => {
	it('should list every process, then the ones it could not read', () => {
		// prettier-ignore
		expect(formatProfileList(PROCESSES)).toEqual([
			'TOKEN         NAME       STATE     RUNNING  REPORT  SESSION',
			'(server)      -          inactive        -  yes     -',
			'PROFILE-DEMO  webhook_1  active    46.324s  -       session_1789717993',
			'DEMO-B        ingest     inactive        -  no      -',
			'DEMO-C: no answer within 10s',
			'4 process(es), 1 profiling, 1 unreadable',
		]);
	});

	it('should keep only the processes being profiled when asked', () => {
		// prettier-ignore
		expect(formatProfileList(PROCESSES, true)).toEqual([
			'TOKEN         NAME       STATE   RUNNING  REPORT  SESSION',
			'PROFILE-DEMO  webhook_1  active  46.324s  -       session_1789717993',
			'DEMO-C: no answer within 10s',
			'4 process(es), 1 profiling, 1 unreadable',
		]);
	});

	it('should say so when nothing is being profiled', () => {
		expect(formatProfileList(PROCESSES.slice(0, 1), true)).toEqual(['No active profiling sessions', '1 process(es), 0 profiling']);
	});
});

// The signal handler in rocketride.ts offers each signal to takeInterrupt() first
describe('profile run waiting', () => {
	it('should end the wait on the first Ctrl+C and leave the next one to shutdown', async () => {
		const waiting = waitForStop();

		expect(takeInterrupt()).toBe(true);
		await waiting;
		expect(takeInterrupt()).toBe(false);
	});

	it('should end the wait after the duration and stop listening', async () => {
		await waitForStop(0.05);

		expect(takeInterrupt()).toBe(false);
	});
});

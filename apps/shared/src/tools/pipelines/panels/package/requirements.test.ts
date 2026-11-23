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

/** PACKAGE › Requirements for a pipeline (mockup 2.10): the rows a document and a rail produce. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callerNeedsOf, deployRequirements, isShortId, publicParametersOf, requirementsLead, storeLadder } from './requirements';
import type { IRequirementsProject, IRequirementsVersion } from './requirements';

/** A complete, listable document: every deploy row passes. */
const COMPLETE: IRequirementsProject = {
	project_id: 'docBrain',
	components: [
		{ id: 'webhook_1' },
		{ id: 'llm_1' },
	],
	parameters: { maxEdge: 'llm_1.max_edge', outputFormat: 'llm_1.format' },
	store: { mode: 'free', icon: 'icon.svg', readme: 'README.md' } as IRequirementsProject['store'],
};

/** The row with the given id, asserted present. */
function row(items: ReturnType<typeof deployRequirements>, id: string): ReturnType<typeof deployRequirements>[number] {
	const found = items.find((item) => item.id === id);
	assert.ok(found, `row ${id} present`);
	return found;
}

describe('isShortId', () => {
	it('accepts one dot-free segment and refuses dotted, empty and spaced ids', () => {
		assert.equal(isShortId('docBrain'), true);
		assert.equal(isShortId('doc_brain-2'), true);
		assert.equal(isShortId('draft.docBrain'), false);
		assert.equal(isShortId(''), false);
		assert.equal(isShortId('doc brain'), false);
	});
});

describe('callerNeedsOf', () => {
	it('lists every ${ROCKETRIDE_*} placeholder once, wherever it sits in the document', () => {
		const project = {
			...COMPLETE,
			components: [
				{ id: 'llm_1', config: { apiKey: '${ROCKETRIDE_ANTHROPIC_KEY}', nested: { again: '${ROCKETRIDE_ANTHROPIC_KEY}' } } },
				{ id: 'db_1', config: { url: 'postgres://${ROCKETRIDE_DB_USER}:${ROCKETRIDE_DB_PASS}@host' } },
			],
		} as IRequirementsProject;
		assert.deepEqual(callerNeedsOf(project), ['ROCKETRIDE_ANTHROPIC_KEY', 'ROCKETRIDE_DB_USER', 'ROCKETRIDE_DB_PASS']);
	});

	it('is empty when nothing references the env', () => {
		assert.deepEqual(callerNeedsOf(COMPLETE), []);
	});
});

describe('publicParametersOf', () => {
	it('keeps the map order and pairs each name with its target', () => {
		assert.deepEqual(publicParametersOf(COMPLETE), [
			{ name: 'maxEdge', target: 'llm_1.max_edge' },
			{ name: 'outputFormat', target: 'llm_1.format' },
		]);
	});

	it('is empty without a map', () => {
		assert.deepEqual(publicParametersOf({ project_id: 'x' }), []);
	});
});

describe('deployRequirements', () => {
	it('passes every row on a complete, listable document', () => {
		const items = deployRequirements(COMPLETE, 'acme');
		assert.deepEqual(items.map((i) => [i.id, i.state]), [['ids', 'pass'], ['parameters', 'pass'], ['developer', 'pass'], ['store', 'pass'], ['assets', 'pass']]);
		assert.equal(row(items, 'developer').note, 'published as acme.docBrain');
		assert.equal(row(items, 'parameters').note, '2 public parameters');
	});

	it('fails the id row for a missing id, a dotted id, and a dotted component id', () => {
		assert.equal(row(deployRequirements({ ...COMPLETE, project_id: '' }, 'acme'), 'ids').state, 'fail');
		assert.equal(row(deployRequirements({ ...COMPLETE, project_id: 'acme.docBrain' }, 'acme'), 'ids').state, 'fail');
		const dotted = deployRequirements({ ...COMPLETE, components: [{ id: 'llm.1' }] }, 'acme');
		assert.equal(row(dotted, 'ids').state, 'fail');
		assert.equal(row(dotted, 'ids').note, 'llm.1');
	});

	it('fails the parameters row when a target names no component, and passes an empty map', () => {
		const dangling = deployRequirements({ ...COMPLETE, parameters: { maxEdge: 'ghost.max_edge' } }, 'acme');
		assert.equal(row(dangling, 'parameters').state, 'fail');
		assert.equal(row(dangling, 'parameters').note, 'maxEdge');
		const none = deployRequirements({ ...COMPLETE, parameters: undefined }, 'acme');
		assert.equal(row(none, 'parameters').state, 'pass');
		assert.equal(row(none, 'parameters').note, 'no public parameters');
	});

	it('rejects a parameter target without the nodeId.configKey separator, and accepts a well-formed one', () => {
		// `llm_1x` has no separator: it must not read as component `llm_1`, field `llm_1x`.
		const noDot = deployRequirements({ ...COMPLETE, parameters: { maxEdge: 'llm_1x' } }, 'acme');
		assert.equal(row(noDot, 'parameters').state, 'fail');
		assert.equal(row(noDot, 'parameters').note, 'maxEdge');
		const trailingDot = deployRequirements({ ...COMPLETE, parameters: { maxEdge: 'llm_1.' } }, 'acme');
		assert.equal(row(trailingDot, 'parameters').state, 'fail');
		const ok = deployRequirements({ ...COMPLETE, parameters: { maxEdge: 'llm_1.max_edge' } }, 'acme');
		assert.equal(row(ok, 'parameters').state, 'pass');
		assert.equal(row(ok, 'parameters').note, '1 public parameter');
	});

	it('fails the developer row while the organization has no id', () => {
		assert.equal(row(deployRequirements(COMPLETE, ''), 'developer').state, 'fail');
	});

	it('passes without a store block: the default listing stands in, and the assets row is not asked', () => {
		const items = deployRequirements({ ...COMPLETE, store: undefined }, 'acme');
		assert.equal(row(items, 'store').state, 'pass');
		assert.equal(row(items, 'store').label, 'Store listing: the default');
		assert.equal(items.some((i) => i.id === 'assets'), false);
	});

	it('warns on a block that declares no README', () => {
		const items = deployRequirements({ ...COMPLETE, store: { mode: 'free', icon: 'icon.png' } as IRequirementsProject['store'] }, 'acme');
		assert.equal(row(items, 'assets').state, 'warn');
		assert.equal(row(items, 'assets').label, 'No README declared');
	});

	it('passes a block with a README and no icon: an icon is optional', () => {
		const items = deployRequirements({ ...COMPLETE, store: { mode: 'free', readme: 'README.md' } as IRequirementsProject['store'] }, 'acme');
		assert.equal(row(items, 'assets').state, 'pass');
		assert.equal(row(items, 'assets').label, 'README declared');
		assert.equal(row(items, 'assets').note, 'README.md');
		assert.equal(row(deployRequirements(COMPLETE, 'acme'), 'assets').label, 'README and icon declared');
	});

	it('never mentions engine sharing', () => {
		for (const item of deployRequirements(COMPLETE, 'acme')) assert.doesNotMatch(`${item.label} ${item.note ?? ''}`, /engine/i);
	});
});

describe('storeLadder', () => {
	const rail = (state: IRequirementsVersion['state'], version = 5): IRequirementsVersion[] => [
		{ registryVersion: version, state },
		{ registryVersion: version - 1, state: 'private' },
	];

	it('is all pending on an empty rail except a free pricing', () => {
		const items = storeLadder(COMPLETE, []);
		assert.deepEqual(items.map((i) => [i.id, i.state]), [['deployed', 'pending'], ['pricing', 'pass'], ['submitted', 'pending'], ['ready', 'pending']]);
	});

	it('walks private -> submit -> ready off the newest version', () => {
		assert.deepEqual(storeLadder(COMPLETE, rail('private')).map((i) => i.state), ['pass', 'pass', 'pending', 'pending']);
		assert.deepEqual(storeLadder(COMPLETE, rail('submit')).map((i) => i.state), ['pass', 'pass', 'pass', 'pending']);
		assert.deepEqual(storeLadder(COMPLETE, rail('ready')).map((i) => i.state), ['pass', 'pass', 'pass', 'pass']);
		assert.equal(row(storeLadder(COMPLETE, rail('ready')), 'ready').label, 'v5 approved for the store');
	});

	it('fails the submitted row on a rejection', () => {
		assert.equal(row(storeLadder(COMPLETE, rail('rejected')), 'submitted').state, 'fail');
	});

	it('skips a failed newest version: the ladder reads the newest version that can still move', () => {
		const items = storeLadder(COMPLETE, [{ registryVersion: 6, state: 'failed' }, { registryVersion: 5, state: 'submit' }]);
		assert.equal(row(items, 'deployed').note, 'v5 is the newest');
		assert.equal(row(items, 'submitted').state, 'pass');
	});

	it('reads pricing off the block: paid without plans fails, paid with plans passes, no block is the default Free', () => {
		const paid = { ...COMPLETE, store: { mode: 'subscription' } as IRequirementsProject['store'] };
		assert.equal(row(storeLadder(paid, []), 'pricing').state, 'fail');
		const planned = { ...COMPLETE, store: { mode: 'subscription', billing: { plans: [{}] } } as unknown as IRequirementsProject['store'] };
		assert.equal(row(storeLadder(planned, []), 'pricing').state, 'pass');
		const unblocked = row(storeLadder({ ...COMPLETE, store: undefined }, []), 'pricing');
		assert.equal(unblocked.state, 'pass');
		assert.equal(unblocked.note, 'Free');
	});
});

describe('requirementsLead', () => {
	it('counts failures first, then warnings, then says all is in place', () => {
		assert.match(requirementsLead(deployRequirements(COMPLETE, '')), /^1 item needs fixing/);
		assert.match(requirementsLead(deployRequirements({ ...COMPLETE, store: { mode: 'free' } as IRequirementsProject['store'] }, 'acme')), /1 optional item would complete its listing/);
		assert.match(requirementsLead(deployRequirements(COMPLETE, 'acme')), /^Everything is in place/);
	});
});

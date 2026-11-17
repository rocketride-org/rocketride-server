import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENT_EVENTS, HOME_ROOT_ATTRIBUTE, RICH_EVENTS, isInsideHome, richEventGate } from './surface.ts';
import { HOME_ROOT_ATTRIBUTE as REPLAY_HOME_ROOT_ATTRIBUTE } from './replay.ts';

type Ev = { event: string; properties?: Record<string, unknown> } | null;

/** A click on a button inside the home root, as posthog-js serialises the chain (attributes sorted by name). */
const INSIDE = 'button:nth-child="1"nth-of-type="1"text="Get Started";div:attr__class="page"attr__data-rr-home-root=""nth-child="2"nth-of-type="1"';

test('the gate drops every rich event unless the surface is signed out; other events pass through next()', () => {
	let state: boolean | null = null;
	const seen: string[] = [];
	const gate = richEventGate<Ev>(() => state === false, (e) => {
		if (e) {
			seen.push(e.event);
		}
		return e;
	});
	for (const s of [null, true] as const) {
		state = s;
		for (const name of RICH_EVENTS) {
			assert.equal(gate({ event: name, properties: { $elements_chain: INSIDE } }), null, `${name} dropped while ${String(s)}`);
		}
		assert.deepEqual(gate({ event: '$pageview' }), { event: '$pageview' }, 'journey events are not gated');
		assert.equal(gate({ event: '$exception' }), null, 'no exception report from a signed-in surface');
	}
	state = false;
	for (const name of RICH_EVENTS) {
		const e = { event: name, properties: { $elements_chain: INSIDE } };
		assert.deepEqual(gate(e), e, `${name} passes on a signed-out surface`);
	}
	assert.equal(gate(null), null);
	assert.ok(seen.includes('$snapshot') && seen.includes('$pageview'));
});

test('RICH_EVENTS covers replay, heatmaps, autocapture, rage clicks, dead clicks, dead swipes and exceptions', () => {
	assert.deepEqual([...RICH_EVENTS].sort(), ['$$heatmap', '$autocapture', '$dead_click', '$dead_swipe', '$exception', '$rageclick', '$snapshot']);
	assert.ok([...ELEMENT_EVENTS].every((name) => {
		return RICH_EVENTS.has(name);
	}), 'every element event is a rich event');
});

test('a click event is kept only when its element sits inside the home root, whatever the outside looks like', () => {
	const gate = richEventGate<Ev>(() => true, (e) => {
		return e;
	});
	const outside = 'button:attr__title="Copy"nth-child="1"nth-of-type="1";div:attr__style="font-family: monospace"nth-child="3"nth-of-type="2"';
	const spoofed = 'button:attr__title="a \\"attr__data-rr-home-root=\\" b"nth-child="1"nth-of-type="1"';
	for (const name of ELEMENT_EVENTS) {
		assert.ok(gate({ event: name, properties: { $elements_chain: INSIDE } }), `${name} inside the home root passes`);
		assert.equal(gate({ event: name, properties: { $elements_chain: outside } }), null, `${name} outside the home root (a shell surface) is dropped`);
		assert.equal(gate({ event: name, properties: { $elements_chain: spoofed } }), null, `${name}: a value that only contains the marker text does not count`);
		assert.equal(gate({ event: name, properties: {} }), null, `${name} without its element is dropped`);
		assert.ok(gate({ event: name, properties: { $elements: [{ tag_name: 'button' }, { tag_name: 'div', 'attr__data-rr-home-root': '' }] } }), `${name} with $elements inside the home root passes`);
		assert.equal(gate({ event: name, properties: { $elements: [{ tag_name: 'button' }] } }), null, `${name} with $elements outside is dropped`);
	}
	assert.ok(gate({ event: '$$heatmap', properties: {} }), 'a heatmap batch (positions only) is not an element event');
});

test('isInsideHome reads the attribute key, first in its element or after the attribute before it', () => {
	assert.equal(isInsideHome({ $elements_chain: 'div:attr__data-rr-home-root=""nth-child="1"nth-of-type="1"' }), true);
	assert.equal(isInsideHome({ $elements_chain: INSIDE }), true);
	assert.equal(isInsideHome({ $elements_chain: 'div:attr__data-rr-home-rooted=""nth-child="1"' }), false);
	assert.equal(isInsideHome(null), false);
	assert.equal(isInsideHome('div:attr__data-rr-home-root=""'), false);
});

test('replay.ts carries the same home root attribute as surface.ts', () => {
	assert.equal(REPLAY_HOME_ROOT_ATTRIBUTE, HOME_ROOT_ATTRIBUTE);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_BELOW, GAP, MARGIN, PHONE_MARGIN, TOAST_MAX, TOAST_MIN, compactCopy, intersects, nextPlacement, onScreen, placeBar, placeToast, placementLabel, positionFor, samePlacement, toastRect, variantFor, type Placement, type PlacementInput, type Rect } from './placement.ts';

const r = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });
/** A toast whose text wraps: narrower is taller (about the desktop copy at 13 px). */
const heightAt = (w: number) => Math.round(110 + 40000 / w);

// Geometry measured on the landing page: terminal card, hero CTAs, hero image.
const DESKTOP_1440 = { view: { width: 1440, height: 900 }, obstacles: [r(296, 745, 1144, 1135), r(48, 529, 286, 581), r(308, 529, 526, 581), r(628, 36, 1935, 828)] };
const LAPTOP_1280 = { view: { width: 1280, height: 800 }, obstacles: [r(216, 677, 1064, 1067), r(48, 494, 286, 546), r(308, 494, 526, 546), r(560, 40, 1723, 746)] };
const WIDE_1920 = { view: { width: 1920, height: 1080 }, obstacles: [r(536, 853, 1384, 1243), r(288, 569, 526, 621), r(548, 569, 766, 621), r(1108, 90, 2415, 882)] };

test('variantFor: phones (narrow, or short like a phone held sideways) get the bar, tablets and desktops the toast', () => {
	assert.equal(variantFor({ width: 390, height: 844 }), 'phone');
	assert.equal(variantFor({ width: 844, height: 390 }), 'phone');
	assert.equal(variantFor({ width: 768, height: 1024 }), 'toast');
	assert.equal(variantFor({ width: 1440, height: 900 }), 'toast');
});

test('onScreen clips to the viewport and drops what is off screen', () => {
	const view = { width: 1440, height: 900 };
	assert.deepEqual(onScreen(view, [r(296, 745, 1144, 1135), r(10, 1000, 20, 1100), r(-50, -50, 10, 10)]), [r(296, 745, 1144, 900), r(0, 0, 10, 10)]);
});

test('1440x900: bottom-left, narrowed to the gutter beside the terminal; it covers neither the terminal nor a hero CTA nor the hero image', () => {
	const { view, obstacles } = DESKTOP_1440;
	const p = placeToast(view, onScreen(view, obstacles), heightAt);
	assert.ok(p);
	assert.equal(p.side, 'left');
	assert.ok(p.width < TOAST_MAX && p.width >= TOAST_MIN, `width ${p.width}`);
	const rect = toastRect(view, p.side, p.width, heightAt(p.width));
	for (const o of onScreen(view, obstacles)) assert.equal(intersects(rect, o, GAP), false);
});

test('1280x800: the terminal leaves no gutter of TOAST_MIN and the hero image fills the right: the banner waits', () => {
	const { view, obstacles } = LAPTOP_1280;
	assert.equal(placeToast(view, onScreen(view, obstacles), heightAt), null);
	// after the visitor scrolls the hero away, the corner is free at full width
	assert.deepEqual(placeToast(view, [], heightAt), { side: 'left', width: TOAST_MAX });
});

test('1920x1080: bottom-left at the full width', () => {
	const { view, obstacles } = WIDE_1920;
	assert.deepEqual(placeToast(view, onScreen(view, obstacles), heightAt), { side: 'left', width: TOAST_MAX });
});

test('bottom-right when only the left corner is taken', () => {
	const view = { width: 1440, height: 900 };
	assert.deepEqual(placeToast(view, [r(0, 600, 700, 900)], heightAt), { side: 'right', width: TOAST_MAX });
});

test('a narrow tablet viewport: the toast is never wider than the viewport allows', () => {
	const view = { width: 600, height: 900 };
	const p = placeToast(view, [], heightAt);
	assert.deepEqual(p, { side: 'left', width: Math.min(TOAST_MAX, 600 - 2 * MARGIN) });
});

test('phone bar: at the bottom when clear; raised above the footer\'s Privacy settings link; waits rather than climbing past mid-screen', () => {
	const view = { width: 390, height: 844 };
	assert.deepEqual(placeBar(view, [], 130), { bottom: PHONE_MARGIN });
	const link = r(72, 740, 318, 756);
	const raised = placeBar(view, [link], 130);
	assert.ok(raised);
	assert.equal(raised.bottom, 844 - 740 + GAP);
	const barRect = { left: PHONE_MARGIN, right: 390 - PHONE_MARGIN, bottom: 844 - raised.bottom, top: 844 - raised.bottom - 130 };
	assert.equal(intersects(barRect, link, GAP), false);
	assert.equal(placeBar(view, [r(0, 420, 390, 844)], 130), null);
});

test('compactCopy: the phone bar and a toast narrower than COMPACT_BELOW carry the short phone copy', () => {
	assert.equal(compactCopy('phone', 366), true);
	assert.equal(compactCopy('toast', COMPACT_BELOW - 1), true);
	assert.equal(compactCopy('toast', COMPACT_BELOW), false);
	assert.equal(compactCopy('toast', TOAST_MAX), false);
	assert.ok(TOAST_MIN < COMPACT_BELOW && COMPACT_BELOW < TOAST_MAX);
});

test('1440x900 with the copy each width carries: the toast beside the terminal is narrower than COMPACT_BELOW, so it carries the phone copy, and it still covers nothing', () => {
	const { view, obstacles } = DESKTOP_1440;
	const phoneCopyHeight = 110; // two lines of the phone copy and the buttons
	const carried = (w: number) => (compactCopy('toast', w) ? phoneCopyHeight : heightAt(w));
	const p = placeToast(view, onScreen(view, obstacles), carried);
	assert.ok(p);
	assert.equal(p.side, 'left');
	assert.equal(compactCopy('toast', p.width), true, `width ${p.width}`);
	const rect = toastRect(view, p.side, p.width, carried(p.width));
	for (const o of onScreen(view, obstacles)) assert.equal(intersects(rect, o, GAP), false);
});

test('positionFor: measured where it first appears, then in its corner at its width, the phone bar across the bottom', () => {
	assert.deepEqual(positionFor(null, true), { left: PHONE_MARGIN, right: PHONE_MARGIN, bottom: PHONE_MARGIN });
	assert.deepEqual(positionFor(null, false), { left: MARGIN, bottom: MARGIN });
	assert.deepEqual(positionFor({ variant: 'phone', bottom: 80 }, true), { left: PHONE_MARGIN, right: PHONE_MARGIN, bottom: PHONE_MARGIN });
	assert.deepEqual(positionFor({ variant: 'toast', side: 'left', width: 300 }, false), { left: MARGIN, bottom: MARGIN, width: 300 });
	assert.deepEqual(positionFor({ variant: 'toast', side: 'right', width: 380 }, false), { right: MARGIN, bottom: MARGIN, width: 380 });
});

test('placementLabel: measuring until placed, then bar, left or right', () => {
	assert.equal(placementLabel(null), 'measuring');
	assert.equal(placementLabel({ variant: 'phone', bottom: 12 }), 'bar');
	assert.equal(placementLabel({ variant: 'toast', side: 'left', width: 300 }), 'left');
	assert.equal(placementLabel({ variant: 'toast', side: 'right', width: 300 }), 'right');
});

// nextPlacement: what the banner does on its first placement and on every scroll or resize after it.
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const LEFT: Placement = { variant: 'toast', side: 'left', width: TOAST_MAX };
const BAR: Placement = { variant: 'phone', bottom: PHONE_MARGIN };
/** A nextPlacement input: nothing placed, nothing to keep clear, a toast measured with heightAt above. */
const input = (over: Partial<PlacementInput>): PlacementInput => ({
	current: null, isSameView: false, view: DESKTOP, obstacles: { all: [], always: [] }, height: heightAt(TOAST_MAX), heightAt, ...over,
});
/** The footer's Privacy settings link under the bottom-left toast. */
const FOOTER_LINK_LEFT = r(48, 800, 200, 820);

test('nextPlacement, first placement: a clear corner places the toast, the phone bar goes to the bottom', () => {
	assert.deepEqual(nextPlacement(input({})), LEFT);
	const { view, obstacles } = DESKTOP_1440;
	const all = onScreen(view, obstacles);
	assert.deepEqual(nextPlacement(input({ view, obstacles: { all, always: [] } })), { variant: 'toast', ...placeToast(view, all, heightAt) });
	assert.deepEqual(nextPlacement(input({ view: PHONE, height: 130 })), BAR);
});

test('nextPlacement, first placement: no clear spot waits (null); after a resize, a placement on screen stays only while still clear', () => {
	const { view, obstacles } = LAPTOP_1280;
	const all = onScreen(view, obstacles);
	assert.equal(nextPlacement(input({ view, obstacles: { all, always: [] } })), null);
	// the full-width toast from before the resize would cover the terminal in the new viewport: hidden, not kept
	assert.equal(nextPlacement(input({ view, obstacles: { all, always: [] }, current: LEFT, isSameView: false })), null);
	assert.equal(nextPlacement(input({ view: PHONE, height: 130, obstacles: { all: [r(0, 420, 390, 844)], always: [] } })), null);
	// a raised bar from before the resize that is still clear stays where it is, though a fresh one would have to
	// rise past BAR_MAX_TOP_SHARE
	const tall = r(0, 450, 390, 844);
	const raisedBar: Placement = { variant: 'phone', bottom: 500 };
	assert.equal(nextPlacement(input({ view: PHONE, height: 100, obstacles: { all: [tall], always: [] }, current: raisedBar, isSameView: false })), 'keep');
	// the same raised bar in a viewport too short to show it (its rectangle is above the top edge) is hidden,
	// never kept offscreen where its consent controls could not be reached
	const short = { width: 390, height: 400 };
	assert.equal(nextPlacement(input({ view: short, height: 100, obstacles: { all: [r(0, 200, 390, 400)], always: [] }, current: raisedBar, isSameView: false })), null);
});

test('nextPlacement: a desktop toast that becomes a phone viewport with no clear bar spot is hidden, never kept as a toast', () => {
	const obstacle = r(0, 420, 390, 844);
	assert.equal(nextPlacement(input({ view: PHONE, height: 130, current: LEFT, isSameView: false, obstacles: { all: [obstacle], always: [obstacle] } })), null);
});

test('placeBar: a short viewport still gets the bar at rest; only a RAISED bar is held below BAR_MAX_TOP_SHARE', () => {
	const short = { width: 390, height: 240 };
	assert.deepEqual(placeBar(short, [], 130), { bottom: PHONE_MARGIN }, 'the only consent prompt is never hidden for lack of height');
	assert.deepEqual(nextPlacement(input({ view: short, height: 130 })), BAR);
	assert.equal(placeBar(short, [r(0, 200, 390, 230)], 130), null, 'raising it past the share still waits');
});

test('nextPlacement, a toast on screen: keeps its corner and width while the page scrolls and nothing comes under it', () => {
	assert.equal(nextPlacement(input({ current: LEFT, isSameView: true })), 'keep');
	// the hero image above the corner, the terminal beside it: neither under the toast
	assert.equal(nextPlacement(input({ current: LEFT, isSameView: true, obstacles: { all: [r(628, 36, 1440, 500), r(500, 700, 1100, 900)], always: [] } })), 'keep');
});

test('nextPlacement, a toast on screen: swaps corners, same width, when the footer link comes under it', () => {
	const obstacles = { all: [FOOTER_LINK_LEFT], always: [FOOTER_LINK_LEFT] };
	// narrower than a fresh placement would make it, so a swap and a fresh placement give different answers
	const narrowed: Placement = { variant: 'toast', side: 'left', width: 300 };
	assert.deepEqual(nextPlacement(input({ current: narrowed, isSameView: true, obstacles, height: heightAt(300) })), { variant: 'toast', side: 'right', width: 300 });
});

test('nextPlacement, a toast on screen: placed again from scratch (narrowed) when both corners are covered at its width', () => {
	const terminal = r(300, 700, 1140, 900);
	const next = nextPlacement(input({ current: LEFT, isSameView: true, obstacles: { all: [terminal], always: [] } }));
	assert.ok(next !== 'keep' && next !== null && next.variant === 'toast' && next.width >= TOAST_MIN);
	assert.deepEqual(next, { variant: 'toast', side: 'left', width: 300 - GAP - MARGIN });
});

test('nextPlacement, a toast on screen: steps aside (null) when no corner is clear, even narrowed', () => {
	assert.equal(nextPlacement(input({ current: LEFT, isSameView: true, obstacles: { all: [r(0, 600, 1440, 900)], always: [] } })), null);
});

test('nextPlacement, the phone bar on screen: rises above the footer link, settles back once it has passed, never covers it', () => {
	const link = r(72, 740, 318, 756);
	const raised = nextPlacement(input({ view: PHONE, height: 130, current: BAR, isSameView: true, obstacles: { all: [link], always: [link] } }));
	assert.deepEqual(raised, { variant: 'phone', bottom: 844 - 740 + GAP });
	assert.deepEqual(nextPlacement(input({ view: PHONE, height: 130, current: { variant: 'phone', bottom: 112 }, isSameView: true })), BAR);
	// once shown, only what is marked "always" moves it: the hero's actions under the bar do not
	assert.deepEqual(nextPlacement(input({ view: PHONE, height: 130, current: BAR, isSameView: true, obstacles: { all: [r(16, 700, 374, 760)], always: [] } })), BAR);
	// it would have to climb past mid-screen and its spot covers the obstacle: it steps aside rather than cover it
	assert.equal(nextPlacement(input({ view: PHONE, height: 130, current: BAR, isSameView: true, obstacles: { all: [r(0, 420, 390, 844)], always: [r(0, 420, 390, 844)] } })), null);
	// it cannot move (a fresh spot would rise past the share), but its own spot is clear: it stays
	const raisedBar: Placement = { variant: 'phone', bottom: 500 };
	const tall = [r(0, 450, 390, 844)];
	assert.equal(nextPlacement(input({ view: PHONE, height: 100, current: raisedBar, isSameView: true, obstacles: { all: tall, always: tall } })), 'keep');
});

test('nextPlacement: a new viewport size or variant is a first placement again', () => {
	// a desktop toast, then the window narrowed to a phone: the bar
	assert.deepEqual(nextPlacement(input({ view: PHONE, height: 130, current: LEFT, isSameView: false })), BAR);
	// same size reported but the variant no longer matches: placed again
	assert.deepEqual(nextPlacement(input({ view: PHONE, height: 130, current: LEFT, isSameView: true })), BAR);
});

test('samePlacement compares placements field by field, whatever the key order', () => {
	assert.equal(samePlacement(null, null), true);
	assert.equal(samePlacement(LEFT, null), false);
	assert.equal(samePlacement(null, BAR), false);
	assert.equal(samePlacement(LEFT, { width: TOAST_MAX, side: 'left', variant: 'toast' }), true);
	assert.equal(samePlacement(LEFT, { variant: 'toast', side: 'right', width: TOAST_MAX }), false);
	assert.equal(samePlacement(LEFT, { variant: 'toast', side: 'left', width: 300 }), false);
	assert.equal(samePlacement(BAR, { bottom: PHONE_MARGIN, variant: 'phone' }), true);
	assert.equal(samePlacement(BAR, { variant: 'phone', bottom: 80 }), false);
	assert.equal(samePlacement(BAR, LEFT), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayGate, startReplay, homeBlockApplies, LOW_MEMORY_GB, REPLAY_INIT_CONFIG, HOME_ROOT_ATTRIBUTE, OUTSIDE_HOME_SELECTOR, type BlockTarget } from './replay.ts';

test('replayGate: Save-Data, a 2G/3G connection or low device memory skip replay; no signals keep it', () => {
	assert.equal(replayGate(undefined), null);
	assert.equal(replayGate({}), null, 'Safari and Firefox expose nothing: replay runs');
	assert.equal(replayGate({ connection: { saveData: true, effectiveType: '4g' }, deviceMemory: 8 }), 'save_data');
	for (const et of ['slow-2g', '2g', '3g']) assert.equal(replayGate({ connection: { effectiveType: et }, deviceMemory: 8 }), 'slow_network', et);
	assert.equal(replayGate({ connection: { effectiveType: '4g' }, deviceMemory: 8 }), null);
	assert.equal(replayGate({ deviceMemory: LOW_MEMORY_GB }), 'low_memory');
	assert.equal(replayGate({ deviceMemory: 1 }), 'low_memory');
	assert.equal(replayGate({ deviceMemory: LOW_MEMORY_GB * 2 }), null);
	assert.equal(replayGate({ deviceMemory: 0 }), null, 'a zero is not a reading');
});

test('replay config: inputs masked; data-rr-private elements and everything outside the home root blocked, not just text-masked', () => {
	const rec = REPLAY_INIT_CONFIG.session_recording;
	assert.equal(rec.maskAllInputs, true);
	const blocked = rec.blockSelector.split(',').map((s) => {
		return s.trim();
	});
	// the text mask covers text nodes only: a title, aria-label or data attribute inside a marked element needs the block
	assert.ok(blocked.includes('[data-rr-private]'), rec.blockSelector);
	assert.ok(blocked.includes(OUTSIDE_HOME_SELECTOR), rec.blockSelector);
	assert.equal(rec.captureCanvas.recordCanvas, false);
});

test('the block outside the home root goes by position: the root, its content and its ancestors stay, every other body element is blocked, whatever its style', () => {
	const root = `[${HOME_ROOT_ATTRIBUTE}]`;
	assert.equal(root, '[data-rr-home-root]', 'the attribute HomeApp renders on its root');
	const [scope, ...exclusions] = OUTSIDE_HOME_SELECTOR.split(':not(');
	assert.equal(scope, 'body *', 'every element of the body (the page head keeps its styles)');
	assert.deepEqual(exclusions.map((x) => {
		return `:not(${x}`;
	}), [
		`:not(${root})`, // the root itself
		`:not(${root} *)`, // the home content
		`:not(:has(${root}))`, // its ancestors: rrweb drops the whole subtree of a blocked element
	]);
	assert.ok(!REPLAY_INIT_CONFIG.session_recording.blockSelector.includes('style'), 'no block keyed on how an element is styled');
});

/** What a browser's document answers: whether it can parse :has(), and whether the home root is on the page. */
function fakeDocument(isHasSupported: boolean, hasHomeRoot: boolean): BlockTarget & { parsed: string[] } {
	const parsed: string[] = [];
	return {
		parsed,
		documentElement: {
			matches(selector: string): boolean {
				parsed.push(selector);
				if (!isHasSupported && selector.includes(':has(')) {
					// what Element.matches throws in a browser without :has() (Firefox before 121, Safari before 15.4)
					throw new SyntaxError(`'${selector}' is not a valid selector`);
				}
				return false;
			},
		},
		querySelector(selector: string): unknown {
			if (hasHomeRoot && selector === `[${HOME_ROOT_ATTRIBUTE}]`) {
				return {};
			}
			return null;
		},
	};
}

/** A consented instance that counts its recording starts. */
function fakeInstance(): { startSessionRecording(): void; sessionRecordingStarted(): boolean; starts: number } {
	return {
		starts: 0,
		startSessionRecording(): void {
			this.starts++;
		},
		sessionRecordingStarted(): boolean {
			return this.starts > 0;
		},
	};
}

test('startReplay fails closed: no recording where the browser cannot apply the block selector, or the home root is missing', () => {
	const noHas = fakeDocument(false, true);
	const noHasInstance = fakeInstance();
	assert.equal(homeBlockApplies(noHas), false);
	assert.equal(startReplay(noHasInstance, noHas), false);
	assert.equal(noHasInstance.starts, 0, 'the recorder never started without :has()');
	assert.deepEqual([...new Set(noHas.parsed)], [REPLAY_INIT_CONFIG.session_recording.blockSelector], 'the check parses the selector the recorder will apply');

	const noRoot = fakeDocument(true, false);
	const noRootInstance = fakeInstance();
	assert.equal(startReplay(noRootInstance, noRoot), false);
	assert.equal(noRootInstance.starts, 0, 'the recorder never started without the home root');

	const ready = fakeDocument(true, true);
	const readyInstance = fakeInstance();
	assert.equal(homeBlockApplies(ready), true);
	assert.equal(startReplay(readyInstance, ready), true);
	assert.equal(readyInstance.starts, 1, 'control: the recorder starts where the block applies');
});

test('replay config: network headers and bodies pinned off on the client (it overrides the project setting)', () => {
	const rec = REPLAY_INIT_CONFIG.session_recording;
	assert.equal(rec.recordHeaders, false);
	assert.equal(rec.recordBody, false);
});

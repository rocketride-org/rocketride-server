// =============================================================================
// Preference patch contract for ProjectView.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeProjectPreferences, updateProjectPreference, writeProjectPreference } from './projectPreferences';

test('a one-key ProjectView preference write emits a patch that preserves newer host values', () => {
	const staleEditorPrefs = { panelWidth: 280, showGrid: true };
	const newerHostPrefs = { panelWidth: 420, showGrid: true, minimapVisible: false };
	const changedKey = 'showGrid';
	const changedValue = false;
	const expectedPatch = { [changedKey]: changedValue };
	const { localPrefs, hostPatch } = updateProjectPreference(staleEditorPrefs, changedKey, changedValue);

	assert.deepEqual(localPrefs, { panelWidth: 280, showGrid: false }, 'the local editor retains its full preference bag');
	assert.deepEqual(hostPatch, expectedPatch, 'the host receives only the changed key');

	assert.deepEqual(
		{ ...newerHostPrefs, ...hostPatch },
		{ panelWidth: 420, showGrid: false, minimapVisible: false },
		'a one-key patch must merge without restoring stale editor values',
	);
});

test('parent preferences retain a local panel-width patch when a remote patch follows', () => {
	const parentPrefs = { panelWidth: 280 };
	const localPanelWidthPatch = { panelWidth: 420 };
	const remoteGlobalPatch = { cloudCanvasPromptDismissed: true };

	const afterLocalChange = mergeProjectPreferences(parentPrefs, localPanelWidthPatch);
	const finalParentPrefs = mergeProjectPreferences(afterLocalChange, remoteGlobalPatch);

	assert.deepEqual(finalParentPrefs, {
		panelWidth: 420,
		cloudCanvasPromptDismissed: true,
	});
});

test('a replayed preference state updater sends one host patch', () => {
	const scheduledUpdaters: Array<(prefs: Record<string, unknown>) => Record<string, unknown>> = [];
	const hostPatches: Record<string, unknown>[] = [];
	const callOrder: string[] = [];

	writeProjectPreference(
		(updater) => {
			callOrder.push('schedule-local-update');
			scheduledUpdaters.push(updater);
		},
		(patch) => {
			callOrder.push('notify-host');
			hostPatches.push(patch);
		},
		'showGrid',
		false,
	);

	assert.equal(scheduledUpdaters.length, 1);
	assert.deepEqual(callOrder, ['schedule-local-update', 'notify-host']);
	const updater = scheduledUpdaters[0];
	assert.deepEqual(updater({ panelWidth: 280, showGrid: true }), { panelWidth: 280, showGrid: false });
	assert.deepEqual(updater({ panelWidth: 280, showGrid: true }), { panelWidth: 280, showGrid: false });
	assert.deepEqual(hostPatches, [{ showGrid: false }], 'a retryable state updater must not replay the host side effect');
});

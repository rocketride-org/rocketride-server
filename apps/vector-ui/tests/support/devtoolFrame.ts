// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL TEST SUPPORT: a frame mounted as a host mounts it (real frame peer)
// =============================================================================

import { createVectorFrame } from '../../src/devtool/frame';
import type { IVectorFrame, IVectorFrameOptions, IVisibilitySource } from '../../src/devtool/frame';
import { shellProtocol } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness } from 'shared/explorer/devtool/testing';
import { manualTimers, recordingDocuments, track } from './devtool';
import type { IManualTimers } from './devtool';

/** A visibility source a test flips by hand. */
export function manualVisibility(initial = true): IVisibilitySource & { set(visible: boolean): void } {
	let visible = initial;
	const listeners = new Set<() => void>();
	return {
		visible: () => visible,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set(next) {
			visible = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

/** A mounted frame. */
export interface IMountedFrame {
	frame: IVectorFrame;
	docs: ReturnType<typeof recordingDocuments>;
	errors: unknown[];
	/** The summon's and the hints' timers (they fire only when the test advances them). */
	timers: IManualTimers;
}

/**
 * Mount a frame as a host does. Its summon and its hint debounce run on timers the test advances by hand, so a frame
 * sends no summon and no hint unless the test moves time on (`hintDelayMs: 0` sends hints on the next turn instead).
 *
 * @param h - The harness.
 * @param docKey - The frame's docKey.
 * @param over - Frame options to override.
 * @returns The frame, its documents recorder, its reported errors and its timers.
 */
export function mountFrame(h: IDevToolHarness, docKey: string | undefined, over: Partial<IVectorFrameOptions> = {}): IMountedFrame {
	const peer = h.newFramePeer();
	const docs = recordingDocuments();
	const errors: unknown[] = [];
	const timers = manualTimers();
	const frame = track(createVectorFrame({
		peer,
		channel: shellProtocol.createToolChannel(peer),
		documents: docs.documents,
		docKey,
		createToolController: shellProtocol.createToolController,
		createToolChannel: shellProtocol.createToolChannel,
		focusTarget: null,
		visibility: manualVisibility(true),
		schedule: timers.schedule,
		onError: (error) => errors.push(error),
		...over,
	}));
	return { frame, docs, errors, timers };
}

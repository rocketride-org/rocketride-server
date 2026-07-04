// MIT License
// Copyright (c) 2026 Aparavi Software AG
// (full header omitted for brevity)

// =============================================================================
// ENGINE ACTIONS — Per-tab action dispatch + state sync
// =============================================================================
//
// Each tab (editorId) registers its own action handler and engine state.
// The sidebar reads the ACTIVE tab's state and fires actions to the
// ACTIVE tab's handler. No singletons — everything is keyed by editorId.
// =============================================================================

import { useSyncExternalStore } from 'react';
import type { EngineState } from './types';

// =============================================================================
// STORE
// =============================================================================

type ActionCallback = (action: string) => void;

/** Per-tab action handlers keyed by editorId. */
const _handlers = new Map<string, ActionCallback>();

/** Per-tab engine state keyed by editorId. */
const _states = new Map<string, EngineState>();

/** Active editorId — set by navigation sync. */
let _activeEditorId: string | null = null;

/** Listeners for reactive sidebar updates. */
const _listeners = new Set<() => void>();

/** Notify all subscribers. */
function _emit() {
	for (const fn of _listeners) fn();
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Register a tab's action handler. Call with null to unregister. */
export function setActionHandler(editorId: string, cb: ActionCallback | null) {
	if (cb) {
		_handlers.set(editorId, cb);
	} else {
		_handlers.delete(editorId);
	}
}

/** Update a tab's engine state. */
export function setEngineState(editorId: string, state: EngineState) {
	const prev = _states.get(editorId);
	if (prev !== state) {
		_states.set(editorId, state);
		_emit();
	}
}

/** Set which tab is active (called from navigation sync). */
export function setActiveEditor(editorId: string | null) {
	if (_activeEditorId !== editorId) {
		_activeEditorId = editorId;
		_emit();
	}
}

/** Clean up a tab's state when it unmounts. */
export function cleanupEditor(editorId: string) {
	_handlers.delete(editorId);
	_states.delete(editorId);
	_emit();
}

/** Fire an action to the ACTIVE tab's handler. */
export function fireAction(action: 'start' | 'abort' | 'pause' | 'resume' | 'clear' | 'reset') {
	if (_activeEditorId) {
		_handlers.get(_activeEditorId)?.(action);
	}
}

/** React hook — subscribe to the ACTIVE tab's engine state. */
export function useEngineState(): EngineState {
	return useSyncExternalStore(
		(cb) => { _listeners.add(cb); return () => _listeners.delete(cb); },
		() => (_activeEditorId ? _states.get(_activeEditorId) : undefined) ?? 'idle',
	);
}

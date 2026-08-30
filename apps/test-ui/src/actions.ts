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
// ENGINE ACTIONS — Per-tab action dispatch + state sync
// =============================================================================
//
// Each tab (editorId) registers its own action handler and engine state.
// The sidebar reads the ACTIVE tab's state and fires actions to the
// ACTIVE tab's handler. No singletons — everything is keyed by editorId.
// =============================================================================

import type { EngineState } from './types';
import { createExternalStore } from './store';

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

/** Shared pub/sub for reactive sidebar updates. */
const _store = createExternalStore();

/** Notify all subscribers. */
function _emit() {
	_store.emit();
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
	return _store.useValue(() => (_activeEditorId ? _states.get(_activeEditorId) : undefined) ?? 'idle');
}

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
// NAVIGATION — View state for sidebar <-> tab communication
// =============================================================================
//
// Two separate concerns:
//
// 1. DISPLAY: What the sidebar shows. Set by the active tab via setView().
//    The sidebar reads this with useView().
//
// 2. REQUEST: When the user clicks a sidebar button, the request is stored
//    via requestView(). The active tab reads it with useViewRequest(),
//    applies it locally, then calls setView() to confirm.
// =============================================================================

import { createExternalStore } from './store';

// =============================================================================
// TYPES
// =============================================================================

export type ViewId = 'dashboard' | 'settings' | 'events' | 'errors' | 'scenarios';

// =============================================================================
// STORE
// =============================================================================

/** What the sidebar currently displays. Set by the active tab. */
let _view: ViewId | '' = '';

/** Pending view request from a sidebar button click. Consumed by the active tab. */
let _viewRequest: ViewId | null = null;

/** Whether any tab is open. */
let _hasActiveTab = false;

/** Shared pub/sub backing all three hooks below. */
const _store = createExternalStore();

// =============================================================================
// PUBLIC API — called by the active tab
// =============================================================================

/** Set the displayed view. Called by the active tab to tell the sidebar what to highlight. */
export function setView(view: ViewId): void {
	_view = view;
	_viewRequest = null; // clear any pending request
	_store.emit();
}

/** Set whether any tab is active (controls sidebar visibility). */
export function setHasActiveTab(active: boolean): void {
	if (_hasActiveTab !== active) {
		_hasActiveTab = active;
		if (!active) _view = '';
		_store.emit();
	}
}

// =============================================================================
// PUBLIC API — called by the sidebar
// =============================================================================

/** Request a view change. The active tab will pick this up and apply it. */
export function requestView(view: ViewId): void {
	_viewRequest = view;
	_store.emit();
}

// =============================================================================
// HOOKS
// =============================================================================

/** What the sidebar should display. */
export function useView(): ViewId | '' {
	return _store.useValue(() => _view);
}

/** Pending view request from sidebar. Null if none. */
export function useViewRequest(): ViewId | null {
	return _store.useValue(() => _viewRequest);
}

/** Whether any tab is open. */
export function useHasActiveTab(): boolean {
	return _store.useValue(() => _hasActiveTab);
}

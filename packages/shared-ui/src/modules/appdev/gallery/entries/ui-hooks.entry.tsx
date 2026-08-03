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
// UI UTILITY HOOKS — GALLERY ENTRY (DOC-ONLY, HOOKS)
// =============================================================================

/** Doc-only gallery entry for the small cross-cutting UI hooks. */

import type { IGalleryEntry } from '../galleryTypes';

/** The UI utility hooks gallery entry. */
export const uiHooksEntry: IGalleryEntry = {
	id: 'ui-hooks',
	name: 'UI utility hooks',
	group: 'hooks',
	blurb: 'The small cross-cutting hooks: debounced values, popup positioning and dismissal, platform announcements, and cross-app component loading.',
	doc: `Reach for these before writing an effect by hand — they encode the platform's popup, debounce, and announcement conventions:

- \`useClickOutside\` + \`useFixedPopupPosition\` are the popup pair: anchor a \`position: fixed\` popup to its trigger and dismiss it on outside clicks (what \`SidebarFooter\` and the grid header popups use).
- \`useDebouncedValue\` is the trailing debounce for search inputs feeding \`fetchPage\` or \`matchesSearch\`.
- \`useAnnouncements\` feeds the platform announcements ticker (fetched JSON, 1h cache, validity-window filtered).
- \`useAppComponent\` loads a named component from ANOTHER app's catalog — the sanctioned cross-app surface (never import another app's code).`,
	code: `import { useClickOutside, useFixedPopupPosition, useDebouncedValue } from 'shell';

function FilterPopup({ trigger }) {
	const [open, setOpen] = useState(false);
	const popupRef = useRef<HTMLDivElement>(null);
	const pos = useFixedPopupPosition(trigger, open, 'below');
	useClickOutside(popupRef, () => setOpen(false));
	return open && pos && (
		<div ref={popupRef} style={{ position: 'fixed', top: pos.top, left: pos.left }}>...</div>
	);
}

// Debounced server search:
const term = useDebouncedValue(rawInput, 300);
useEffect(() => { void grid.current?.refetch({ search: term }); }, [term]);`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'useDebouncedValue', type: '<T>(value: T, delayMs: number) => T', dir: 'out', note: 'Trailing-debounced copy of a changing value.' },
		{ name: 'useClickOutside', type: '(ref, onClose: () => void) => void', dir: 'out', note: 'Calls onClose on mousedown outside the referenced element.' },
		{ name: 'useFixedPopupPosition', type: "(triggerRef, isOpen, placement?: 'below' | 'above') => { top, left } | null", dir: 'out', note: 'Fixed-position anchor computed from the trigger rect; null while closed.' },
		{ name: 'useAnnouncements', type: '() => Announcement[]', dir: 'out', note: 'Platform announcements: fetched JSON, 1h cache, filtered by validity window; empty on failure.' },
		{ name: 'useAppComponent', type: '(appId, componentName) => ComponentType | null', dir: 'out', note: "Loads a component from another app's catalog (triggers its lazy descriptor load); null while loading or missing." },
	],
	sections: [
		{
			label: 'Types',
			rows: [
				{ name: 'Announcement', type: '{ id, title, body, priority, valid_from?, valid_until?, link?, dismissable? }', dir: 'in', note: "One announcement; title/body are markdown, priority is 'info' | 'warning' | 'urgent'." },
			],
		},
	],
};

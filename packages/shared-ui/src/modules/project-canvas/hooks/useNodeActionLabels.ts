// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Hook that builds the localised label/shortcut map used by the node
 * context menu and "more actions" dropdown.
 */
import { isMacOs } from 'react-device-detect';
import { useTranslation } from 'react-i18next';

import { cmdOrCtrl, shortcutKeys } from '../components/KeyboardShortcutsDisplay';
import { Option } from '../../../types/ui';

/**
 * Returns a record of node-action options (open, duplicate, delete, docs, ungroup)
 * with localised labels and platform-appropriate keyboard shortcut hints.
 *
 * Used by `NodeControlsMoreMenu` and other UI surfaces that display per-node actions.
 *
 * @returns A `Record<string, Option>` keyed by action name.
 */
export default function useNodeActionLabels(): Record<string, Option> {
	const { t } = useTranslation();
	// Resolve platform-specific shortcut key labels (e.g. Cmd on Mac, Ctrl on Windows)
	const keys = shortcutKeys(t);

	// Each entry maps an action name to a localised label and optional keyboard shortcut hint
	return {
		open: {
			label: t('common.moreMenu.open'),
		},
		duplicate: {
			label: t('common.moreMenu.duplicate'),
			// Copy then paste: Cmd/Ctrl+C, Cmd/Ctrl+P
			keys: [cmdOrCtrl(isMacOs), '+', 'C', ',', cmdOrCtrl(isMacOs), '+', 'P'],
		},
		deleteNode: {
			label: t('common.moreMenu.delete'),
			keys: keys.delete,
		},
		documentation: {
			label: t('common.moreMenu.documentation'),
		},
		ungroup: {
			label: t('common.moreMenu.ungroup'),
			keys: keys.ungroup,
		},
	};
}

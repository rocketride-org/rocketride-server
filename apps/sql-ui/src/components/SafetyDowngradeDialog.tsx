// =============================================================================
// MIT License
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
// SQL-UI — SAFETY DOWNGRADE (asked before a connection's level is lowered)
// =============================================================================
//
// Lowering a connection's safety level makes every document of that
// connection ask less, so the Query page asks first. Focus starts on Cancel,
// and Cancel changes nothing.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import { ConfirmDialog } from 'shell';
import { PATTERN_CANCEL_LABEL, focusCancelIn } from 'shared/explorer/components/PatternConfirmDialog';
import type { SafetyLevel } from '../connect/savedConnections';
import { safetyDowngradeCopy } from '../sql/safety';

/** Props for the {@link SafetyDowngradeDialog} component. */
export interface SafetyDowngradeDialogProps {
	/** The lower level chosen. */
	level: SafetyLevel;
	/** The connection's name. */
	connection: string;
	/** Lower the level. */
	onConfirm: () => void;
	/** Keep the level as it is. */
	onCancel: () => void;
}

/**
 * The question asked before a connection's safety level is lowered.
 *
 * @param props - {@link SafetyDowngradeDialogProps}.
 * @returns The dialog element.
 */
export function SafetyDowngradeDialog({ level, connection, onConfirm, onCancel }: SafetyDowngradeDialogProps): React.ReactElement {
	const copy = safetyDowngradeCopy(level, connection);
	// Runs after the shell dialog's own effect, which focuses its confirm button.
	const anchorRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		focusCancelIn(anchorRef.current);
	}, []);
	return (
		<ConfirmDialog
			title={copy.title}
			destructive
			message={<div ref={anchorRef}>{copy.message}</div>}
			cancelLabel={PATTERN_CANCEL_LABEL}
			confirmLabel={copy.confirmLabel}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
}

export default SafetyDowngradeDialog;

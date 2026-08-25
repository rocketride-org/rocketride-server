// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useFixedPopupPosition — computes a fixed-position anchor point for a popup
 * relative to a trigger element.
 */

import { useEffect, useState } from 'react';

export function useFixedPopupPosition(triggerRef: React.RefObject<HTMLElement | null>, isOpen: boolean, placement: 'below' | 'above' = 'below') {
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	useEffect(() => {
		if (!isOpen || !triggerRef.current) {
			setPos(null);
			return;
		}
		const rect = triggerRef.current.getBoundingClientRect();
		setPos({ top: placement === 'below' ? rect.bottom + 4 : rect.top, left: rect.left });
	}, [isOpen, triggerRef, placement]);
	return pos;
}

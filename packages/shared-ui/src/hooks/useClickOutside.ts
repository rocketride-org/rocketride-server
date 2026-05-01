// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useClickOutside — dismisses a popup/menu when the user clicks outside its ref.
 */

import { useEffect } from 'react';

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [ref, onClose]);
}

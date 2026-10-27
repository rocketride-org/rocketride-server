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
// VECTOR-UI — AdvancedPopover (the map toolbar's Advanced controls) and usePopover
// =============================================================================
//
// A disclosure, not a menu: a button (aria-expanded, aria-controls while open)
// and a panel of native controls in groups, which the toolbar fills (Graph,
// Select and view, Sample). Opening it moves the focus to its first enabled
// control. Escape closes it and puts the focus back on the button (an inner
// control that handled Escape first, calling preventDefault, is left alone);
// so does a window resize. A pointer pressed outside it, or the focus moving
// out of it, closes it and leaves the focus where it went. It stops no event
// and listens for no key above itself.
//
// usePopover is the placement every toolbar popover shares (this one, Export
// and Views): the panel is measured before the browser paints and placed with
// map/popover.ts placePopover (below the button, else above, else the side
// with more room with its height capped; clamped inside the viewport), then
// held there while it is open; it closes on a window resize (refocusing the
// button) and on a pointer pressed outside. Its edge is the computed border of
// a box over the map (map/styles.ts floatBorder) and the theme's shadow.
//
// Lane hooks: the root carries data-component="AdvancedPopover", the panel
// data-advanced-panel.
// =============================================================================

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { placePopover, popoverKey } from '../map/popover';
import { MAP_STYLES, floatBorder } from '../map/styles';
import { readPalette } from '../map/tokens';
import type { IMapPalette } from '../map/tokens';

/** Layout effects run only in a browser (a server render would warn). */
const useBrowserLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

/** The chrome every toolbar popover panel shares (its border and place come from usePopover). */
export const POPOVER_PANEL: CSSProperties = { position: 'absolute', zIndex: 20, boxSizing: 'border-box', borderRadius: 8, background: 'var(--rr-bg-paper)', color: 'var(--rr-text-primary)', boxShadow: '0 4px 16px var(--rr-shadow-widget, rgba(0, 0, 0, 0.25))' };

/** The elements a popover is measured from. */
export interface IPopoverRefs {
	/** The positioned element the panel hangs in. */
	root: RefObject<HTMLElement | null>;
	/** The button. */
	trigger: RefObject<HTMLElement | null>;
	/** The panel. */
	panel: RefObject<HTMLElement | null>;
}

/**
 * The theme as the page has it now, or null outside a browser.
 *
 * @returns The palette.
 */
function hostPalette(): IMapPalette | null {
	if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
	const style = getComputedStyle(document.documentElement);
	return readPalette((token) => style.getPropertyValue(token));
}

/**
 * Place an open popover inside the viewport, and close it on a window resize
 * (focus back on the button) or a pointer pressed outside it.
 *
 * @param open - Whether the panel is shown.
 * @param refs - Root, button and panel.
 * @param close - Close it; `refocus` puts the focus back on the button.
 * @returns The panel's place, caps and edge (merge it last into the panel's style).
 */
export function usePopover(open: boolean, refs: IPopoverRefs, close: (refocus: boolean) => void): CSSProperties {
	const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number; maxWidth: number } | null>(null);
	const closeRef = useRef(close);
	closeRef.current = close;
	// Read once per opening: a theme switch while a panel is open does not move it.
	const border = useMemo(() => (open ? floatBorder(hostPalette()) : null), [open]);

	// Measured before paint on every render while open (the content can change its size), set only when it moved.
	useBrowserLayoutEffect(() => {
		if (!open) {
			if (place !== null) setPlace(null);
			return;
		}
		const root = refs.root.current;
		const trigger = refs.trigger.current;
		const panel = refs.panel.current;
		if (!root || !trigger || !panel || typeof window === 'undefined') return;
		const anchor = trigger.getBoundingClientRect();
		const origin = root.getBoundingClientRect();
		const at = placePopover(anchor, { width: panel.offsetWidth, height: panel.scrollHeight }, { width: window.innerWidth, height: window.innerHeight });
		const next = { left: Math.round(at.left - origin.left), top: Math.round(at.top - origin.top), maxHeight: Math.floor(at.maxHeight), maxWidth: Math.floor(at.maxWidth) };
		if (place === null || place.left !== next.left || place.top !== next.top || place.maxHeight !== next.maxHeight || place.maxWidth !== next.maxWidth) setPlace(next);
	});

	useEffect(() => {
		if (!open || typeof window === 'undefined') return undefined;
		const onResize = (): void => closeRef.current(true);
		const onDown = (event: PointerEvent): void => {
			const root = refs.root.current;
			if (root && event.target instanceof Node && !root.contains(event.target)) closeRef.current(false);
		};
		window.addEventListener('resize', onResize);
		document.addEventListener('pointerdown', onDown);
		return () => {
			window.removeEventListener('resize', onResize);
			document.removeEventListener('pointerdown', onDown);
		};
		// The refs are stable objects.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const edge: CSSProperties = border ? { border: `1px solid ${border}` } : {};
	// Before the first measure (the same frame) the panel hangs below the button's left edge.
	return place === null ? { ...edge, top: 'calc(100% + 4px)', left: 0, right: 'auto' } : { ...edge, top: place.top, left: place.left, right: 'auto', maxHeight: place.maxHeight, maxWidth: place.maxWidth, overflowY: 'auto' };
}

/**
 * The first control of a panel that can take the focus.
 *
 * @param panel - The panel.
 * @returns The control, or null.
 */
function firstControl(panel: HTMLElement | null): HTMLElement | null {
	if (!panel) return null;
	const all = Array.from(panel.querySelectorAll<HTMLElement>('button, select, input, textarea, [tabindex]:not([tabindex="-1"])'));
	return all.find((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-hidden') !== 'true') ?? null;
}

/** Props of the Advanced popover. */
export interface AdvancedPopoverProps {
	/** The button's words. */
	label: string;
	/** The panel's accessible name. */
	panelLabel: string;
	/** Open at first (only its starting state; the tests render it open). */
	initialOpen?: boolean;
	/** The panel's controls; `close(true)` closes it and puts the focus on the button. */
	children: ReactNode | ((close: (refocus: boolean) => void) => ReactNode);
}

const S = {
	root: { position: 'relative', display: 'inline-flex', alignItems: 'center' } as CSSProperties,
	panel: { ...POPOVER_PANEL, width: 340, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
};

/**
 * The Advanced button and its panel.
 *
 * @param props - Words, starting state and the controls.
 * @returns The disclosure.
 */
export function AdvancedPopover(props: AdvancedPopoverProps): React.ReactElement {
	const panelId = `advanced-${useId().replace(/:/g, '')}`;
	const [open, setOpen] = useState(props.initialOpen === true);
	const root = useRef<HTMLSpanElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const wasOpen = useRef(open);

	const close = useCallback((refocus: boolean): void => {
		setOpen(false);
		if (refocus) trigger.current?.focus();
	}, []);
	const placement = usePopover(open, { root, trigger, panel }, close);

	// Opened by the user: the focus moves to the first control.
	useEffect(() => {
		if (open && !wasOpen.current) (firstControl(panel.current) ?? panel.current)?.focus();
		wasOpen.current = open;
	}, [open]);

	const onKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>): void => {
		if (!open) return;
		const action = popoverKey(event.key, event.defaultPrevented);
		if (action.prevent) event.preventDefault();
		if (action.close) close(action.refocus);
	};

	// The focus left the popover (Tab past its last control, or a click elsewhere): close, leaving the focus there.
	const onBlur = (event: React.FocusEvent<HTMLSpanElement>): void => {
		const next = event.relatedTarget;
		if (open && next instanceof Node && root.current && !root.current.contains(next)) setOpen(false);
	};

	return (
		<span ref={root} style={S.root} data-component="AdvancedPopover" onKeyDown={onKeyDown} onBlur={onBlur}>
			<button ref={trigger} type="button" style={{ ...MAP_STYLES.button, ...(open ? MAP_STYLES.buttonPressed : null) }} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((v) => !v)}>
				{props.label} ▾
			</button>
			{open ? (
				<div ref={panel} id={panelId} role="group" aria-label={props.panelLabel} tabIndex={-1} style={{ ...S.panel, ...placement }} data-advanced-panel="">
					{typeof props.children === 'function' ? props.children(close) : props.children}
				</div>
			) : null}
		</span>
	);
}

export default AdvancedPopover;

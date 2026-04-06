// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * FloatingToolbar — A draggable toolbar that floats over the canvas.
 *
 * Position is stored as an anchor edge + pixel offset from that edge:
 *   { anchorX: 'right', offsetX: 50, anchorY: 'bottom', offsetY: 30 }
 *
 * The anchor edge is determined automatically when the user finishes
 * dragging — whichever edge is closer wins. The offset is the pixel
 * distance from that edge.
 *
 * On render, the stored position is clamped so the toolbar stays fully
 * visible. If the viewport shrinks, the toolbar floats inward. When
 * the viewport grows again, it returns to its stored position.
 * The stored value is never modified by resize — only by user drag.
 *
 * When within 30px of the left or right edge, the toolbar switches to
 * vertical orientation automatically.
 */

import { ReactElement, ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { GripVertical, GripHorizontal } from 'lucide-react';

// =============================================================================
// CONSTANTS
// =============================================================================

const EDGE_THRESHOLD = 30;

// =============================================================================
// POSITION TYPE
// =============================================================================

export interface IToolbarPosition {
	anchorX: 'left' | 'right';
	offsetX: number;
	anchorY: 'top' | 'bottom';
	offsetY: number;
}

const DEFAULT_POSITION: IToolbarPosition = {
	anchorX: 'right',
	offsetX: 20,
	anchorY: 'top',
	offsetY: 20,
};

// =============================================================================
// PROPS
// =============================================================================

interface IFloatingToolbarProps {
	children: ReactNode;
	position?: IToolbarPosition;
	onPositionChange?: (position: IToolbarPosition) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export default function FloatingToolbar({ children, position = DEFAULT_POSITION, onPositionChange }: IFloatingToolbarProps): ReactElement {
	const toolbarRef = useRef<HTMLDivElement>(null);
	const [storedPos, setStoredPos] = useState<IToolbarPosition>(position);
	const [isDragging, setIsDragging] = useState(false);

	// Pixel position used during drag (absolute left/top within parent)
	const [dragPixels, setDragPixels] = useState<{ left: number; top: number } | null>(null);

	// Force re-render on resize so the clamped position recalculates
	const [, setResizeTick] = useState(0);

	const dragStart = useRef({ mouseX: 0, mouseY: 0, left: 0, top: 0 });

	// Sync with external position changes (e.g. preference loaded)
	useEffect(() => {
		setStoredPos(position);
	}, [position]);

	// Listen for parent resize to re-clamp the position
	useEffect(() => {
		const parent = toolbarRef.current?.parentElement;
		if (!parent) return;

		const observer = new ResizeObserver(() => {
			setResizeTick((t) => t + 1);
		});
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);

	// --- Position helpers ---------------------------------------------------

	/**
	 * Converts the stored anchor position to clamped pixel coordinates.
	 * Ensures the toolbar is fully visible regardless of viewport size.
	 */
	const getRenderedPosition = useCallback((): { left: number; top: number } => {
		const parent = toolbarRef.current?.parentElement;
		const toolbar = toolbarRef.current;
		if (!parent || !toolbar) return { left: 0, top: 0 };

		const parentRect = parent.getBoundingClientRect();
		const toolbarWidth = toolbar.offsetWidth;
		const toolbarHeight = toolbar.offsetHeight;

		// Convert anchor + offset to absolute left/top
		let left: number;
		if (storedPos.anchorX === 'left') {
			left = storedPos.offsetX;
		} else {
			left = parentRect.width - toolbarWidth - storedPos.offsetX;
		}

		let top: number;
		if (storedPos.anchorY === 'top') {
			top = storedPos.offsetY;
		} else {
			top = parentRect.height - toolbarHeight - storedPos.offsetY;
		}

		// Clamp so toolbar stays fully visible
		left = Math.max(0, Math.min(left, parentRect.width - toolbarWidth));
		top = Math.max(0, Math.min(top, parentRect.height - toolbarHeight));

		return { left, top };
	}, [storedPos]);

	/**
	 * Converts absolute pixel position to an anchor-based position.
	 * Picks the closer edge for each axis.
	 */
	const pixelsToAnchor = useCallback((left: number, top: number): IToolbarPosition => {
		const parent = toolbarRef.current?.parentElement;
		const toolbar = toolbarRef.current;
		if (!parent || !toolbar) return DEFAULT_POSITION;

		const parentRect = parent.getBoundingClientRect();
		const toolbarWidth = toolbar.offsetWidth;
		const toolbarHeight = toolbar.offsetHeight;

		// Distance from each edge
		const distLeft = left;
		const distRight = parentRect.width - left - toolbarWidth;
		const distTop = top;
		const distBottom = parentRect.height - top - toolbarHeight;

		return {
			anchorX: distLeft <= distRight ? 'left' : 'right',
			offsetX: distLeft <= distRight ? distLeft : distRight,
			anchorY: distTop <= distBottom ? 'top' : 'bottom',
			offsetY: distTop <= distBottom ? distTop : distBottom,
		};
	}, []);

	// --- Orientation (vertical when in an edge zone) -------------------------
	// Only switches when entering a zone — stays in current orientation otherwise.

	const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>(() => (storedPos.offsetX < EDGE_THRESHOLD ? 'vertical' : 'horizontal'));

	// Sync orientation when stored position changes (e.g. preference restored)
	useEffect(() => {
		setOrientation(storedPos.offsetX < EDGE_THRESHOLD ? 'vertical' : 'horizontal');
	}, [storedPos]);

	/**
	 * Determine orientation from the mouse cursor's proximity to parent edges.
	 * Uses the cursor — not toolbar bounds — so it's stable across dimension changes.
	 * Only activates when the cursor is within EDGE_THRESHOLD of any edge.
	 * Nearest side edge → vertical. Nearest top/bottom edge → horizontal (preferred on tie).
	 */
	const checkOrientation = useCallback((clientX: number, clientY: number) => {
		const parent = toolbarRef.current?.parentElement;
		if (!parent) return;
		const r = parent.getBoundingClientRect();
		const mx = clientX - r.left;
		const my = clientY - r.top;

		const nearestSide = Math.min(mx, r.width - mx);
		const nearestTopBottom = Math.min(my, r.height - my);

		if (nearestSide >= EDGE_THRESHOLD && nearestTopBottom >= EDGE_THRESHOLD) return;

		setOrientation(nearestSide < nearestTopBottom ? 'vertical' : 'horizontal');
	}, []);

	const isVertical = orientation === 'vertical';

	// --- Drag handlers -----------------------------------------------------

	const onMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();

			// Get current rendered position as the drag starting point
			const rendered = getRenderedPosition();

			dragStart.current = {
				mouseX: e.clientX,
				mouseY: e.clientY,
				left: rendered.left,
				top: rendered.top,
			};

			setDragPixels(rendered);
			setIsDragging(true);
		},
		[getRenderedPosition]
	);

	useEffect(() => {
		if (!isDragging) return;

		const onMouseMove = (e: MouseEvent) => {
			const parent = toolbarRef.current?.parentElement;
			const toolbar = toolbarRef.current;
			if (!parent || !toolbar) return;

			const parentRect = parent.getBoundingClientRect();

			const newLeft = dragStart.current.left + (e.clientX - dragStart.current.mouseX);
			const newTop = dragStart.current.top + (e.clientY - dragStart.current.mouseY);

			checkOrientation(e.clientX, e.clientY);

			// Clamp during drag
			const clampedLeft = Math.max(0, Math.min(newLeft, parentRect.width - toolbar.offsetWidth));
			const clampedTop = Math.max(0, Math.min(newTop, parentRect.height - toolbar.offsetHeight));

			setDragPixels({ left: clampedLeft, top: clampedTop });
		};

		const endDrag = () => {
			setIsDragging(false);

			// Convert final pixel position to anchor-based and store
			if (dragPixels) {
				const newPos = pixelsToAnchor(dragPixels.left, dragPixels.top);
				setStoredPos(newPos);
				onPositionChange?.(newPos);
			}

			setDragPixels(null);
		};

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', endDrag);
		document.addEventListener('mouseleave', endDrag);

		return () => {
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', endDrag);
			document.removeEventListener('mouseleave', endDrag);
		};
	}, [isDragging, dragPixels, pixelsToAnchor, onPositionChange]);

	// --- Render ------------------------------------------------------------

	// Use drag pixels during drag, clamped stored position otherwise
	const rendered = isDragging && dragPixels ? dragPixels : getRenderedPosition();

	return (
		<div
			ref={toolbarRef}
			className="nopan nodrag rr-floating-toolbar"
			style={{
				position: 'absolute',
				left: `${rendered.left}px`,
				top: `${rendered.top}px`,
				zIndex: 20,
				userSelect: isDragging ? 'none' : 'auto',
			}}
		>
			<div
				style={{
					display: 'flex',
					flexDirection: isVertical ? 'column' : 'row',
					alignItems: 'center',
					border: '1px solid var(--rr-border)',
					borderRadius: '4px',
					backgroundColor: 'var(--rr-bg-widget)',
					overflow: 'hidden',
					boxShadow: '0px 3px 1px -2px rgba(0,0,0,0.2), 0px 2px 2px 0px rgba(0,0,0,0.14), 0px 1px 5px 0px rgba(0,0,0,0.12)',
				}}
			>
				{/* Drag handle */}
				<div
					onMouseDown={onMouseDown}
					style={{
						display: 'flex',
						alignItems: 'center',
						cursor: isDragging ? 'grabbing' : 'grab',
						padding: isVertical ? '2px 4px' : '4px 2px',
						color: 'var(--rr-text-disabled)',
					}}
				>
					{isVertical ? <GripHorizontal size={14} /> : <GripVertical size={14} />}
				</div>

				{/* Toolbar content */}
				<div
					style={{
						display: 'flex',
						flexDirection: isVertical ? 'column' : 'row',
						alignItems: 'center',
						gap: '4px',
						padding: isVertical ? '4px 4px 8px' : '4px 8px 4px 4px',
					}}
				>
					{children}
				</div>
			</div>
		</div>
	);
}

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import { useCallback, useEffect, useRef } from 'react';
import { useFlow } from '../../../FlowContext';
import { isEditableElement } from '../../../../../utils/isEditableElement';

// Note: This allows users to hold Shift and an arrow key to navigate the canvas

/** Pixels to move on the first step when an arrow key is initially pressed. */
const INITIAL_SPEED = 10; // Pixels to move on the first step

/** How many additional pixels per interval to add while the key is held, creating acceleration. */
const ACCELERATION = 5; // Increase speed by this amount per interval

/** Upper bound on movement speed to prevent the viewport from scrolling too fast. */
const MAX_SPEED = 30; // Maximum speed (pixels per interval step)

/** Interval in milliseconds between each movement tick and acceleration update. */
const MOVEMENT_INTERVAL = 30; // Milliseconds for each movement step and acceleration update

/**
 * Checks whether a given key name is one of the four arrow keys.
 * Used to filter keyboard events so that only arrow-key presses drive canvas navigation.
 */
const isArrowKey = (keyName: string): boolean =>
	['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(keyName);

/**
 * Hook that enables keyboard-driven canvas panning via Shift + Arrow keys.
 * When the user holds Shift and presses an arrow key the viewport moves in that direction
 * with gradual acceleration up to a maximum speed, providing a smooth navigation experience
 * without requiring a mouse or trackpad.
 */
export function useArrowNavigation() {
	const { setViewport, getViewport } = useFlow();

	// Note: useRef instead of state because we do not rerender when these update
	const movementIntervalRef = useRef<NodeJS.Timeout | null>(null);
	const currentSpeedRef = useRef<number>(0);
	const activeKeysRef = useRef<Set<string>>(new Set());

	const moveAndAccelerate = useCallback(() => {
		// Snapshot the current viewport so we can compute the next position
		const currentViewport = getViewport();
		let { x, y } = currentViewport;
		const { zoom } = currentViewport;

		const speed = currentSpeedRef.current;
		let moved = false;

		// Adjust viewport offset for each currently held arrow key.
		// Positive y = pan up (viewport origin moves down), negative y = pan down.
		// Positive x = pan left (viewport origin moves right), negative x = pan right.
		if (activeKeysRef.current.has('ArrowUp')) {
			y += speed;
			moved = true;
		}
		if (activeKeysRef.current.has('ArrowDown')) {
			y -= speed;
			moved = true;
		}
		if (activeKeysRef.current.has('ArrowLeft')) {
			x += speed;
			moved = true;
		}
		if (activeKeysRef.current.has('ArrowRight')) {
			x -= speed;
			moved = true;
		}

		if (moved) {
			// Apply the computed viewport position, preserving the current zoom level
			setViewport({ x, y, zoom });

			// Gradually increase speed on each tick until the cap is reached
			if (currentSpeedRef.current < MAX_SPEED) {
				currentSpeedRef.current = Math.min(
					MAX_SPEED,
					currentSpeedRef.current + ACCELERATION
				);
			}
		}
	}, [getViewport, setViewport]);

	useEffect(() => {
		// Halts all movement: clears the repeating interval, resets tracked keys, and zeroes speed
		const stopMovement = () => {
			if (movementIntervalRef.current) {
				clearInterval(movementIntervalRef.current);
				movementIntervalRef.current = null;
			}
			activeKeysRef.current.clear();
			currentSpeedRef.current = 0;
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			// Skip if focused on an editable element to allow native behavior
			if (isEditableElement(event.target)) {
				return;
			}

			const pressedKey = event.key;
			// Only respond to Shift+Arrow combinations; ignore plain arrow keys
			if (!event.shiftKey || !isArrowKey(pressedKey)) {
				return;
			}
			// Prevent the browser from scrolling the page
			event.preventDefault();

			// Track whether this is the first arrow key being pressed (transition from idle)
			const previouslyActive = activeKeysRef.current.size > 0;
			activeKeysRef.current.add(pressedKey);

			if (!previouslyActive && activeKeysRef.current.size > 0) {
				// First arrow key pressed: initialize speed and start the movement loop
				currentSpeedRef.current = INITIAL_SPEED;
				if (movementIntervalRef.current) {
					clearInterval(movementIntervalRef.current); // Defensive clear
				}
				moveAndAccelerate(); // Perform the first move immediately for responsiveness
				movementIntervalRef.current = setInterval(moveAndAccelerate, MOVEMENT_INTERVAL);
			}
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			// Releasing Shift cancels all arrow-key navigation regardless of arrow state
			if (event.key === 'Shift') {
				stopMovement();
				return;
			}

			if (isArrowKey(event.key)) {
				// Remove this specific arrow from the active set
				activeKeysRef.current.delete(event.key);

				if (activeKeysRef.current.size === 0) {
					// All arrow keys have been released; stop the movement loop
					stopMovement();
				}
			}
		};

		// Stop movement when the window loses focus to avoid "stuck key" drift
		const handleBlur = () => {
			stopMovement();
		};

		// Register listeners on window so they work even when the canvas itself isn't focused
		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);
		window.addEventListener('blur', handleBlur);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
			window.removeEventListener('blur', handleBlur);
			stopMovement(); // Clean up on unmount
		};
	}, [moveAndAccelerate]); // moveAndAccelerate depends on getViewportCallback and setViewportCallback
}

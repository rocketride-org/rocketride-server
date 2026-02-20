/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';

/**
 * Props for the ImageCarousel component
 */
interface ImageCarouselProps {
	/** Array of image URLs to display in the carousel */
	images: string[];
	/** Index of the image to display initially (0-based) */
	initialIndex: number;
	/** Callback function invoked when the carousel is closed */
	onClose: () => void;
}

/**
 * ImageCarousel - Full-screen image viewer with navigation and zoom controls
 * 
 * Provides an immersive image viewing experience with the following features:
 * 
 * Navigation:
 * - Previous/Next buttons (visible only when applicable)
 * - Keyboard shortcuts: Left/Right arrows to navigate, Escape to close
 * - Circular navigation (wraps from last to first and vice versa)
 * 
 * Zoom Features:
 * - Mouse wheel zoom (Ctrl/Cmd + wheel or pinch trackpad)
 * - Zoom in/out buttons
 * - Pan when zoomed (click and drag)
 * - Reset zoom when changing images
 * - Min zoom: 100% (fit), Max zoom: 300%
 * 
 * UI Elements:
 * - Close button (X) in top-right corner
 * - Zoom controls in top-left corner
 * - Image counter showing current position (e.g., "3 / 10")
 * - Full-screen overlay with semi-transparent backdrop
 * - Click backdrop to close
 * 
 * Accessibility:
 * - Keyboard navigation support
 * - ARIA labels on all interactive elements
 * - Alt text for images with position information
 * 
 * @component
 * @example
 * ```tsx
 * <ImageCarousel
 *   images={['image1.jpg', 'image2.jpg', 'image3.jpg']}
 *   initialIndex={0}
 *   onClose={() => setShowCarousel(false)}
 * />
 * ```
 */
export const ImageCarousel: React.FC<ImageCarouselProps> = ({
	images,
	initialIndex,
	onClose
}) => {
	// Track the currently displayed image index
	const [currentIndex, setCurrentIndex] = useState(initialIndex);

	// Zoom state
	const [scale, setScale] = useState(1);
	const [position, setPosition] = useState({ x: 0, y: 0 });
	const [isDragging, setIsDragging] = useState(false);
	const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

	// Refs
	const imageRef = useRef<HTMLDivElement>(null);

	// Zoom constraints
	const MIN_SCALE = 0.1;
	const MAX_SCALE = 3;
	const ZOOM_STEP = 0.2;

	/**
	 * Resets zoom and position when image changes
	 */
	const resetZoom = useCallback(() => {
		setScale(1);
		setPosition({ x: 0, y: 0 });
	}, []);

	/**
	 * Navigates to the previous image in the carousel
	 * Wraps to the last image when at the beginning
	 */
	const goToPrevious = useCallback(() => {
		setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
		resetZoom();
	}, [images.length, resetZoom]);

	/**
	 * Navigates to the next image in the carousel
	 * Wraps to the first image when at the end
	 */
	const goToNext = useCallback(() => {
		setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
		resetZoom();
	}, [images.length, resetZoom]);

	/**
	 * Zooms in by one step
	 */
	const zoomIn = useCallback(() => {
		setScale(prev => Math.min(prev + ZOOM_STEP, MAX_SCALE));
	}, []);

	/**
	 * Zooms out by one step
	 */
	const zoomOut = useCallback(() => {
		setScale(prev => {
			const newScale = Math.max(prev - ZOOM_STEP, MIN_SCALE);
			// Reset position if returning to min scale
			if (newScale === MIN_SCALE) {
				setPosition({ x: 0, y: 0 });
			}
			return newScale;
		});
	}, []);

	/**
	 * Handles mouse wheel zoom
	 */
	const handleWheel = useCallback((e: WheelEvent) => {
		// Only zoom if Ctrl/Cmd key is pressed (standard browser behavior)
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();

			const delta = -e.deltaY;
			const zoomFactor = delta > 0 ? 1.1 : 0.9;

			setScale(prev => {
				const newScale = Math.min(Math.max(prev * zoomFactor, MIN_SCALE), MAX_SCALE);
				if (newScale === MIN_SCALE) {
					setPosition({ x: 0, y: 0 });
				}
				return newScale;
			});
		}
	}, []);

	/**
	 * Handles mouse down for panning
	 */
	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		if (scale > MIN_SCALE) {
			setIsDragging(true);
			setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
		}
	}, [scale, position]);

	/**
	 * Handles mouse move for panning
	 */
	const handleMouseMove = useCallback((e: React.MouseEvent) => {
		if (isDragging && scale > MIN_SCALE) {
			setPosition({
				x: e.clientX - dragStart.x,
				y: e.clientY - dragStart.y
			});
		}
	}, [isDragging, scale, dragStart]);

	/**
	 * Handles mouse up to stop panning
	 */
	const handleMouseUp = useCallback(() => {
		setIsDragging(false);
	}, []);

	/**
	 * Sets up keyboard navigation and cleanup
	 * 
	 * Keyboard controls:
	 * - ArrowLeft: Go to previous image
	 * - ArrowRight: Go to next image
	 * - Escape: Close the carousel
	 * - +/=: Zoom in
	 * - -: Zoom out
	 */
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Navigate to previous image
			if (e.key === 'ArrowLeft' && currentIndex > 0) {
				goToPrevious();
			}
			// Navigate to next image
			if (e.key === 'ArrowRight' && currentIndex < images.length - 1) {
				goToNext();
			}
			// Close carousel
			if (e.key === 'Escape') {
				onClose();
			}
			// Zoom in
			if (e.key === '+' || e.key === '=') {
				zoomIn();
			}
			// Zoom out
			if (e.key === '-') {
				zoomOut();
			}
		};

		// Register keyboard event listener
		window.addEventListener('keydown', handleKeyDown);

		// Cleanup listener on component unmount
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [goToPrevious, goToNext, onClose, currentIndex, images.length, zoomIn, zoomOut]);

	/**
	 * Sets up wheel event listener for zoom
	 */
	useEffect(() => {
		const imageContainer = imageRef.current;
		if (!imageContainer) return;

		imageContainer.addEventListener('wheel', handleWheel, { passive: false });
		return () => imageContainer.removeEventListener('wheel', handleWheel);
	}, [handleWheel]);

	return (
		// Full-screen overlay - clicking it closes the carousel
		<div className="carousel-overlay" onClick={onClose}>
			{/* Content container - prevents overlay click from propagating */}
			<div
				className="carousel-content"
				onClick={(e) => e.stopPropagation()}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				style={{ cursor: scale > MIN_SCALE ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
			>
				{/* Zoom controls in top-left corner */}
				<div className="carousel-zoom-controls">
					<button
						className="carousel-zoom-btn"
						onClick={zoomOut}
						disabled={scale <= MIN_SCALE}
						aria-label="Zoom out"
						title="Zoom out (-)"
					>
						<ZoomOut className="w-5 h-5" />
					</button>
					<span className="carousel-zoom-level">{Math.round(scale * 100)}%</span>
					<button
						className="carousel-zoom-btn"
						onClick={zoomIn}
						disabled={scale >= MAX_SCALE}
						aria-label="Zoom in"
						title="Zoom in (+)"
					>
						<ZoomIn className="w-5 h-5" />
					</button>
				</div>

				{/* Close button in top-right corner */}
				<button
					className="carousel-close"
					onClick={onClose}
					aria-label="Close carousel"
				>
					<X className="w-6 h-6" />
				</button>

				{/* Previous button - only show if not at first image */}
				{currentIndex > 0 && (
					<button
						className="carousel-nav carousel-prev"
						onClick={goToPrevious}
						aria-label="Previous image"
					>
						<ChevronLeft className="w-8 h-8" />
					</button>
				)}

				{/* Next button - only show if not at last image */}
				{currentIndex < images.length - 1 && (
					<button
						className="carousel-nav carousel-next"
						onClick={goToNext}
						aria-label="Next image"
					>
						<ChevronRight className="w-8 h-8" />
					</button>
				)}

				{/* Main image display area */}
				<div
					ref={imageRef}
					className="carousel-image-container"
				>
					<img
						src={images[currentIndex]}
						alt={`Image ${currentIndex + 1} of ${images.length}`}
						className="carousel-image"
						style={{
							transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
							transition: isDragging ? 'none' : 'transform 0.2s ease-out'
						}}
						draggable={false}
					/>
				</div>

				{/* Image counter - only show if multiple images exist */}
				{images.length > 1 && (
					<div className="carousel-counter">
						{currentIndex + 1} / {images.length}
					</div>
				)}
			</div>
		</div>
	);
};

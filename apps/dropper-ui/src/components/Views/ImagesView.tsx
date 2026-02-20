/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React, { useState } from 'react';
import { Image } from 'lucide-react';
import { ImageCarousel } from '../ImageCarousel';
import { ProcessedResults } from '../../types/dropper.types';

/**
 * Props for the ImagesView component
 */
interface ImagesViewProps {
	/** Array of image content groups to display */
	images: ProcessedResults['images'];
	/** Whether to display content in comparison mode (side-by-side) */
	compareMode: boolean;
	/** Callback to set element refs for scrolling functionality */
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

/**
 * ImagesView Component
 * 
 * Displays image content extracted from processed files in a grid layout.
 * Images are stored as data URLs separated by '|||' delimiter and rendered
 * in a flexible grid. Supports both normal stacked layout and comparison mode
 * for side-by-side viewing. Includes full-screen carousel functionality for
 * expanded image viewing.
 * 
 * Features:
 * - Grid layout for image display with flexible sizing
 * - Comparison mode for side-by-side image viewing
 * - Click-to-expand with full-screen carousel navigation
 * - Field name labels when multiple image groups exist
 * - Empty state when no images are available
 * - Ref management for scroll-to-file functionality
 * 
 * @param props - Component props
 * @returns React component displaying image content
 */
export const ImagesView: React.FC<ImagesViewProps> = ({ images, compareMode, setRef }) => {
	// State for image carousel modal
	const [carouselImages, setCarouselImages] = useState<string[] | null>(null);
	const [carouselIndex, setCarouselIndex] = useState(0);

	/**
	 * Handler for opening the image carousel
	 * 
	 * @param imageList - Array of image data URLs to display in carousel
	 * @param index - Index of the clicked image to show first
	 */
	const handleImageClick = (imageList: string[], index: number) => {
		setCarouselImages(imageList);
		setCarouselIndex(index);
	};

	// Show empty state if no images are available
	if (images.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<Image className="w-12 h-12 text-gray-300" />
					<p>No images found in the processed files.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="tab-content">
			<div className="content-list">
				{images.map((group, groupIndex) => (
					<div
						key={groupIndex}
						ref={(el) => {
							if (el && setRef) setRef(group.filename, el);
						}}
					>
						{/* File header */}
						<div className="content-item-header">{group.filename}</div>

						{/* Comparison mode: side-by-side layout */}
						{compareMode && group.contents.length > 1 ? (
							<div className="compare-grid">
								{group.contents.map((block: any, contentIndex: number) => (
									<div key={contentIndex} className="compare-column">
										{block.fieldName && (
											<div className="content-field-label">{block.fieldName}</div>
										)}
										<div className="content-item">
											<div className="image-grid">
												{/* Split images by delimiter and render in grid */}
												{block.content.split('|||').map((imageUrl: string, imgIndex: number) => (
													<div key={imgIndex} className="image-wrapper">
														<img
															src={imageUrl}
															alt={`${group.filename} - ${block.fieldName || 'Image'} ${imgIndex + 1}`}
															className="processed-image"
															onClick={() => handleImageClick(block.content.split('|||'), imgIndex)}
															style={{ cursor: 'pointer' }}
														/>
													</div>
												))}
											</div>
										</div>
									</div>
								))}
							</div>
						) : (
							/* Normal mode: stacked layout */
							group.contents.map((block: any, contentIndex: number) => (
								<div key={contentIndex} className="content-item-wrapper">
									{/* Show field name only when multiple image groups exist */}
									{group.contents.length > 1 && block.fieldName && (
										<div className="content-field-label">{block.fieldName}</div>
									)}
									<div className="content-item">
										<div className="image-grid">
											{/* Split images by delimiter and render in grid */}
											{block.content.split('|||').map((imageUrl: string, imgIndex: number) => (
												<div key={imgIndex} className="image-wrapper">
													<img
														src={imageUrl}
														alt={`${group.filename} - ${block.fieldName || 'Image'} ${imgIndex + 1}`}
														className="processed-image"
														onClick={() => handleImageClick(block.content.split('|||'), imgIndex)}
														style={{ cursor: 'pointer' }}
													/>
												</div>
											))}
										</div>
									</div>
								</div>
							))
						)}
					</div>
				))}
			</div>

			{/* Image carousel modal for full-screen viewing */}
			{carouselImages && (
				<ImageCarousel
					images={carouselImages}
					initialIndex={carouselIndex}
					onClose={() => setCarouselImages(null)}
				/>
			)}
		</div>
	);
};

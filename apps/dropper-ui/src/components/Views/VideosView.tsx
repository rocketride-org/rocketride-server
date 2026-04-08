/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React, { useState } from 'react';
import { Video } from 'lucide-react';
import { ProcessedResults, ContentBlock } from '../../types/dropper.types';

interface VideosViewProps {
	videos: ProcessedResults['videos'];
	compareMode: boolean;
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

export const VideosView: React.FC<VideosViewProps> = ({ videos, compareMode, setRef }) => {
	const [videoErrors, setVideoErrors] = useState<Set<string>>(new Set());

	const handleVideoError = (src: string) => {
		console.warn('[VideosView] Failed to load video blob URL:', src);
		setVideoErrors((prev) => new Set(prev).add(src));
	};

	const renderVideo = (block: ContentBlock) => (
		<div className="content-item">
			{videoErrors.has(block.content as string) ? (
				<p className="video-error">Video could not be loaded.</p>
			) : (
				<video src={block.content as string} controls className="processed-video" style={{ width: '100%' }} onError={() => handleVideoError(block.content as string)}>
					Your browser does not support the video element.
				</video>
			)}
		</div>
	);

	if (videos.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<Video className="w-12 h-12 text-gray-300" />
					<p>No videos found in the processed files.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="tab-content">
			<div className="content-list">
				{videos.map((group) => (
					<div
						key={group.filename}
						ref={(el) => {
							if (setRef) setRef(group.filename, el);
						}}
					>
						<div className="content-item-header">{group.filename}</div>

						{compareMode && group.contents.length > 1 ? (
							<div className="compare-grid">
								{group.contents.map((block: ContentBlock, contentIndex: number) => (
									<div key={contentIndex} className="compare-column">
										{block.fieldName && <div className="content-field-label">{block.fieldName}</div>}
										{renderVideo(block)}
									</div>
								))}
							</div>
						) : (
							group.contents.map((block: ContentBlock, contentIndex: number) => (
								<div key={contentIndex} className="content-item-wrapper">
									{group.contents.length > 1 && block.fieldName && <div className="content-field-label">{block.fieldName}</div>}
									{renderVideo(block)}
								</div>
							))
						)}
					</div>
				))}
			</div>
		</div>
	);
};

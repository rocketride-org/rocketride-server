/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React from 'react';
import { Video } from 'lucide-react';
import { ContentBlock, ProcessedResults } from '../../types/dropper.types';

/**
 * Props for the VideoView component.
 */
interface VideoViewProps {
	/** Video content groups to display (data URLs joined by '|||'). */
	video: ProcessedResults['video'];
	/** Whether to display content side-by-side. */
	compareMode: boolean;
	/** Callback to register element refs for scroll-to-file. */
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

/**
 * VideoView Component.
 *
 * Renders produced video as native `<video controls>` players, grouped by source
 * file. Data URLs are stored joined by the '|||' delimiter (as images are) and
 * split for rendering. Supports compare mode for side-by-side playback.
 *
 * @param props - Component props.
 * @returns React component displaying video players.
 */
export const VideoView: React.FC<VideoViewProps> = ({ video, compareMode, setRef }) => {
	if (video.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<Video className="w-12 h-12 text-gray-300" />
					<p>No video found in the processed files.</p>
				</div>
			</div>
		);
	}

	const renderPlayers = (content: string, label: string) => (
		<div className="media-grid">
			{content.split('|||').map((url: string, i: number) => (
				<video key={i} src={url} controls className="processed-video" aria-label={`${label} ${i + 1}`} />
			))}
		</div>
	);

	return (
		<div className="tab-content">
			<div className="content-list">
				{video.map((group, groupIndex) => (
					<div
						key={groupIndex}
						ref={(el) => {
							if (el && setRef) setRef(group.filename, el);
						}}
					>
						<div className="content-item-header">{group.filename}</div>

						{compareMode && group.contents.length > 1 ? (
							<div className="compare-grid">
								{group.contents.map((block: ContentBlock, contentIndex: number) => (
									<div key={contentIndex} className="compare-column">
										{block.fieldName && <div className="content-field-label">{block.fieldName}</div>}
										<div className="content-item">{renderPlayers(block.content, block.fieldName || 'Video')}</div>
									</div>
								))}
							</div>
						) : (
							group.contents.map((block: ContentBlock, contentIndex: number) => (
								<div key={contentIndex} className="content-item-wrapper">
									{group.contents.length > 1 && block.fieldName && <div className="content-field-label">{block.fieldName}</div>}
									<div className="content-item">{renderPlayers(block.content, block.fieldName || 'Video')}</div>
								</div>
							))
						)}
					</div>
				))}
			</div>
		</div>
	);
};

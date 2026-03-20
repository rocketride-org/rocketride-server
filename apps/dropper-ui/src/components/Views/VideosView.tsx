/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React from 'react';
import { Video } from 'lucide-react';
import { ProcessedResults } from '../../types/dropper.types';

interface VideosViewProps {
	videos: ProcessedResults['videos'];
	compareMode: boolean;
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

export const VideosView: React.FC<VideosViewProps> = ({ videos, compareMode, setRef }) => {
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
				{videos.map((group, groupIndex) => (
					<div
						key={groupIndex}
						ref={(el) => {
							if (el && setRef) setRef(group.filename, el);
						}}
					>
						<div className="content-item-header">{group.filename}</div>

						{compareMode && group.contents.length > 1 ? (
							<div className="compare-grid">
								{group.contents.map((block: any, contentIndex: number) => (
									<div key={contentIndex} className="compare-column">
										{block.fieldName && <div className="content-field-label">{block.fieldName}</div>}
										<div className="content-item">
											<video src={block.content} controls className="processed-video" style={{ width: '100%' }} />
										</div>
									</div>
								))}
							</div>
						) : (
							group.contents.map((block: any, contentIndex: number) => (
								<div key={contentIndex} className="content-item-wrapper">
									{group.contents.length > 1 && block.fieldName && <div className="content-field-label">{block.fieldName}</div>}
									<div className="content-item">
										<video src={block.content} controls className="processed-video" style={{ width: '100%' }} />
									</div>
								</div>
							))
						)}
					</div>
				))}
			</div>
		</div>
	);
};

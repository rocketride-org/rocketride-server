/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React from 'react';
import { Music } from 'lucide-react';
import { ContentBlock, ProcessedResults } from '../../types/dropper.types';

/**
 * Props for the AudioView component.
 */
interface AudioViewProps {
	/** Audio content groups to display (data URLs joined by '|||'). */
	audio: ProcessedResults['audio'];
	/** Whether to display content side-by-side. */
	compareMode: boolean;
	/** Callback to register element refs for scroll-to-file. */
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

/**
 * AudioView Component.
 *
 * Renders produced audio as native `<audio controls>` players, grouped by source
 * file. Data URLs are stored joined by the '|||' delimiter (as images are) and
 * split for rendering. Supports compare mode for side-by-side playback.
 *
 * @param props - Component props.
 * @returns React component displaying audio players.
 */
export const AudioView: React.FC<AudioViewProps> = ({ audio, compareMode, setRef }) => {
	if (audio.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<Music className="w-12 h-12 text-gray-300" />
					<p>No audio found in the processed files.</p>
				</div>
			</div>
		);
	}

	const renderPlayers = (content: string, label: string) => (
		<div className="media-grid">
			{content.split('|||').map((url: string, i: number) => (
				<audio key={i} src={url} controls className="processed-audio" aria-label={`${label} ${i + 1}`} />
			))}
		</div>
	);

	return (
		<div className="tab-content">
			<div className="content-list">
				{audio.map((group, groupIndex) => (
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
										<div className="content-item">{renderPlayers(block.content, block.fieldName || 'Audio')}</div>
									</div>
								))}
							</div>
						) : (
							group.contents.map((block: ContentBlock, contentIndex: number) => (
								<div key={contentIndex} className="content-item-wrapper">
									{group.contents.length > 1 && block.fieldName && <div className="content-field-label">{block.fieldName}</div>}
									<div className="content-item">{renderPlayers(block.content, block.fieldName || 'Audio')}</div>
								</div>
							))
						)}
					</div>
				))}
			</div>
		</div>
	);
};

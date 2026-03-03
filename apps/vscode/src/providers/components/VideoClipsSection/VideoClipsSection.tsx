import React, { useState, useRef } from 'react';
import type { ClipEntry } from '../../../shared/types/pageStatus';

interface VideoClipsSectionProps {
	clips: ClipEntry[];
	onRefresh: () => void;
	loading: boolean;
}

const ClipCard: React.FC<{ clip: ClipEntry }> = ({ clip }) => {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [error, setError] = useState(false);

	const label = clip.name
		.replace(/\.mp4$/i, '')
		.replace(/_/g, ' ');

	return (
		<div className="clip-card">
			<div className="clip-video-wrap">
				{error ? (
					<div className="clip-error">Unable to load video</div>
				) : (
					<video
						ref={videoRef}
						src={clip.uri}
						controls
						preload="metadata"
						onPlay={() => setIsPlaying(true)}
						onPause={() => setIsPlaying(false)}
						onEnded={() => setIsPlaying(false)}
						onError={() => setError(true)}
					/>
				)}
			</div>
			<div className="clip-info">
				<span className="clip-label" title={clip.name}>{label}</span>
				<span className="clip-size">{clip.sizeMB} MB</span>
			</div>
		</div>
	);
};

export const VideoClipsSection: React.FC<VideoClipsSectionProps> = ({
	clips,
	onRefresh,
	loading,
}) => {
	return (
		<section className="status-section">
			<header className="section-header">
				<span>Video Clips</span>
				<div className="trace-controls">
					<button
						className="trace-clear-btn"
						onClick={onRefresh}
						disabled={loading}
					>
						{loading ? 'Loading...' : 'Refresh'}
					</button>
				</div>
			</header>
			<div className="section-content">
				{clips.length === 0 ? (
					<div className="no-data">
						{loading
							? 'Loading clips...'
							: 'No video clips found. Run a pipeline with video output to generate clips.'}
					</div>
				) : (
					<div className="clips-grid">
						{clips.map((clip) => (
							<ClipCard key={clip.name} clip={clip} />
						))}
					</div>
				)}
			</div>
		</section>
	);
};

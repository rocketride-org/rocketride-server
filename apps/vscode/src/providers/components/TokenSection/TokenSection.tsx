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

import React from 'react';
import { TaskStatus } from '../../../shared/types';

/**
 * Token Usage Section Component
 * 
 * Displays token consumption metrics for AI/ML tasks.
 * Shows breakdown by resource type (CPU, Memory, GPU) with progress bars.
 */

interface TokenSectionProps {
	taskStatus: TaskStatus | undefined;
}

export const TokenSection: React.FC<TokenSectionProps> = ({ taskStatus }) => {
	// Don't render if no task status or no token data
	if (!taskStatus?.tokens) {
		return null;
	}

	const { tokens } = taskStatus;

	return (
		<section className="status-section">
			<header className="section-header">
				<span>Tokens</span>
				{tokens.total !== undefined && (
					<div className="token-total-display">
						Total: <span className="token-total-value">{tokens.total.toFixed(1)}</span>
					</div>
				)}
			</header>
			<div className="section-content">
				<div className="token-bars">
					{tokens.cpu_utilization !== undefined && (
						<div className="token-bar-row">
							<div className="token-bar-label">CPU Usage Tokens</div>
							<div className="token-bar-container">
								<div
									className="token-bar-fill token-bar-cpu-utilization"
									style={{
										width: `${Math.min((tokens.cpu_utilization / (tokens.total || 1)) * 100, 100)}%`
									}}
								/>
							</div>
							<div className="token-bar-value">{tokens.cpu_utilization.toFixed(1)}</div>
						</div>
					)}
					{tokens.cpu_memory !== undefined && (
						<div className="token-bar-row">
							<div className="token-bar-label">CPU Memory Tokens</div>
							<div className="token-bar-container">
								<div
									className="token-bar-fill token-bar-cpu-memory"
									style={{
										width: `${Math.min((tokens.cpu_memory / (tokens.total || 1)) * 100, 100)}%`
									}}
								/>
							</div>
							<div className="token-bar-value">{tokens.cpu_memory.toFixed(1)}</div>
						</div>
					)}
					{tokens.gpu_memory !== undefined && (
						<div className="token-bar-row">
							<div className="token-bar-label">GPU Memory Tokens</div>
							<div className="token-bar-container">
								<div
									className="token-bar-fill token-bar-gpu-memory"
									style={{
										width: `${Math.min((tokens.gpu_memory / (tokens.total || 1)) * 100, 100)}%`
									}}
								/>
							</div>
							<div className="token-bar-value">{tokens.gpu_memory.toFixed(1)}</div>
						</div>
					)}
				</div>
			</div>
		</section>
	);
};


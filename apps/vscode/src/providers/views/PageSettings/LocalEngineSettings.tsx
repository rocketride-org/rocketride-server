// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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
import { SettingsData } from './PageSettings';

interface LocalEngineSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	visible: boolean;
}

export const LocalEngineSettings: React.FC<LocalEngineSettingsProps> = ({
	settings,
	onSettingsChange,
	visible
}) => {
	const handleArgChange = (index: number, value: string) => {
		const newArgs = [...settings.localEngineArgs];
		newArgs[index] = value;
		onSettingsChange({ localEngineArgs: newArgs });
	};

	const addArgument = () => {
		onSettingsChange({
			localEngineArgs: [...settings.localEngineArgs, '']
		});
	};

	const removeArgument = (index: number) => {
		const newArgs = settings.localEngineArgs.filter((_, i) => i !== index);
		onSettingsChange({ localEngineArgs: newArgs });
	};

	if (!visible) {
		return null;
	}

	return (
		<div className="section" id="localEngineSection">
			<div className="section-title">Local Engine Settings</div>
			<div className="section-description">The engine will be downloaded automatically when needed. Configure additional arguments below.</div>

			<div className="form-grid">
				<div className="form-group">
					<label>Engine Arguments</label>
					<div className="args-container">
						{settings.localEngineArgs.map((arg, index) => (
							<div key={index} className="arg-item">
								<input
									type="text"
									value={arg}
									placeholder="--argument"
									onChange={(e) => handleArgChange(index, e.target.value)}
								/>
								<button
									type="button"
									className="secondary small"
									onClick={() => removeArgument(index)}
								>
									Remove
								</button>
							</div>
						))}
					</div>
					<button
						onClick={addArgument}
						className="secondary small"
					>
						Add Argument
					</button>
					<div className="help-text">Additional command-line arguments for the engine</div>
				</div>
			</div>
		</div>
	);
};

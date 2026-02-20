// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImportExport } from '@mui/icons-material';
import { IBasePanelProps } from '../types';
import BasePanel from '../BasePanel';
import BasePanelContent from '../BasePanelContent';
import BasePanelHeader from '../BasePanelHeader';
import { useFlow } from '../../../FlowContext';
import { Box, Button, Typography, FormControlLabel, Switch } from '@mui/material';

/**
 * Internal component that renders the import section of the ImportExportPanel.
 * Provides a file upload button that accepts JSON files and parses them
 * into a toolchain configuration, which is then imported into the canvas.
 */
function Import(): ReactNode {
	const { t } = useTranslation();
	const { importToolchain, onToolchainUpdated } = useFlow();
	const [error, setError] = useState<string | null>(null);

	/**
	 * Handles the file input change event. Validates the selected file
	 * is a JSON file, reads its contents, parses the JSON, and imports
	 * the resulting toolchain configuration into the canvas.
	 */
	const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		// Bail out if the user cancelled the file picker
		if (!file) return;

		// Validate that the selected file is a JSON (or txt) file before attempting to parse
		if (
			!file.type.includes('json') &&
			!file.name.toLowerCase().endsWith('.json') &&
			!file.name.toLowerCase().endsWith('.txt')
		) {
			setError(t('flow.panels.importExport.wrongFileType'));
			return false;
		}

		const reader = new FileReader();

		// Parse the file contents as JSON and import the toolchain configuration
		reader.onload = (e) => {
			try {
				const text = e.target?.result as string;
				const data = JSON.parse(text);
				importToolchain(data);
			} catch (err: unknown) {
				// Surface parse errors (malformed JSON, missing fields) to the user
				console.error(err);
				setError(err instanceof Error ? err.message : String(err));
			}
		};

		// Handle low-level file read errors (e.g. permission denied)
		reader.onerror = () => {
			const errMsg = 'Failed to read file';
			console.error(errMsg);
			setError(errMsg);
		};

		reader.readAsText(file);

		// Trigger a toolchain update to save the project
		onToolchainUpdated();
	};

	return (
		<Box sx={{ p: '2rem', pb: '1rem' }}>
			<Typography variant="h3">{t('flow.panels.importExport.importHeader')}</Typography>
			<Button
				component="label"
				fullWidth
				variant="contained"
				sx={{ mt: '1rem' }}
				disabled={false}
			>
				{t('flow.panels.importExport.importButton')}
				<input type="file" accept=".json" hidden onChange={handleFileChange} />
			</Button>
			{error && (
				<Typography variant="body1" color="error" sx={{ mt: '0.5rem' }}>
					{error}
				</Typography>
			)}
		</Box>
	);
}

/**
 * Internal component that renders the export section of the ImportExportPanel.
 * Provides an export button and a toggle for including sensitive data in the
 * exported JSON. Delegates to the flow context's `exportToolchain` function.
 */
function Export(): ReactNode {
	const { t } = useTranslation();

	const { exportToolchain, exportOptions, setExportOptions } = useFlow();

	/** Triggers the pipeline export as a downloadable JSON file. */
	const handleExport = async () => {
		await exportToolchain();
	};

	/** Toggles whether sensitive/secure data is included in the export. */
	const handleToggleIncludeSecureData = (event: React.ChangeEvent<HTMLInputElement>) => {
		// Spread existing options and override only the `includeSecureData` flag
		setExportOptions({
			...exportOptions,
			includeSecureData: event.target.checked,
		});
	};

	return (
		<Box sx={{ px: '2rem', py: '1rem' }}>
			<Typography variant="h3">{t('flow.panels.importExport.exportHeader')}</Typography>
			<Button
				fullWidth
				variant="contained"
				sx={{ mt: '1rem' }}
				disabled={false}
				onClick={() => handleExport()}
			>
				{t('flow.panels.importExport.exportButton')}
			</Button>
			<FormControlLabel
				control={
					<Switch
						checked={exportOptions.includeSecureData}
						onChange={handleToggleIncludeSecureData}
						disabled={false}
					/>
				}
				label="Include Sensitive Data"
				sx={{ mt: '1rem' }}
			/>
		</Box>
	);
}

/**
 * Renders the Import/Export side panel on the project canvas. Combines
 * the Import and Export sub-sections, allowing users to load a pipeline
 * configuration from a JSON file or download the current pipeline as JSON.
 *
 * @param onClose - Callback to dismiss the panel.
 */
export default function ImportExportPanel({ onClose }: IBasePanelProps): ReactNode {
	const { t } = useTranslation();

	return (
		<BasePanel width={400}>
			<BasePanelHeader
				title={t('flow.panels.importExport.header')}
				icon={<ImportExport sx={{ mr: '1rem' }} />}
				onClose={onClose}
			/>
			<BasePanelContent>
				<Import />
				<Export />
			</BasePanelContent>
		</BasePanel>
	);
}

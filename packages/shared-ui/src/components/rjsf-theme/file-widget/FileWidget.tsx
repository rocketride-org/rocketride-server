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

import { ChangeEvent, useCallback, useMemo } from 'react';
import {
	dataURItoBlob,
	FormContextType,
	getTemplate,
	Registry,
	RJSFSchema,
	StrictRJSFSchema,
	TranslatableString,
	UIOptionsType,
	WidgetProps,
} from '@rjsf/utils';
import { IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import Markdown from 'markdown-to-jsx';

/**
 * Injects the file name into a data URL's MIME segment so that the name
 * is preserved when the data URL is later decoded. This is necessary because
 * FileReader.readAsDataURL does not include the original file name.
 *
 * @param dataURL - The base64 data URL to modify.
 * @param name - The original file name to embed.
 * @returns The data URL with the name encoded, or null if the input was null.
 */
function addNameToDataURL(dataURL: string, name: string) {
	if (dataURL === null) {
		return null;
	}
	return dataURL.replace(';base64', `;name=${encodeURIComponent(name)};base64`);
}

/**
 * Represents metadata about a file selected for upload, including its
 * base64 data URL, original name, size in bytes, and MIME type.
 */
type FileInfoType = {
	dataURL?: string | null;
	name: string;
	size: number;
	type: string;
};

/**
 * Reads a single File object using FileReader and resolves with its metadata
 * and base64 data URL. Used during file upload to convert browser File objects
 * into a serializable format for the form value.
 *
 * @param file - The File object from the input element.
 * @returns A promise resolving to the file's metadata and data URL.
 */
function processFile(file: File): Promise<FileInfoType> {
	const { name, size, type } = file;
	return new Promise((resolve, reject) => {
		const reader = new window.FileReader();
		reader.onerror = reject;
		reader.onload = (event) => {
			// FileReader may return an ArrayBuffer for non-text reads; only string results contain a data URL
			if (typeof event.target?.result === 'string') {
				resolve({
					// Embed the original file name into the data URL so it survives round-trips
					dataURL: addNameToDataURL(event.target.result, name),
					name,
					size,
					type,
				});
			} else {
				// Non-string result means the read didn't produce a usable data URL
				resolve({
					dataURL: null,
					name,
					size,
					type,
				});
			}
		};
		// Read the file as a base64 data URL for embedding in the form value
		reader.readAsDataURL(file);
	});
}

/**
 * Processes all files from a FileList in parallel, converting each to a FileInfoType.
 *
 * @param files - The FileList from an input element's change event.
 * @returns A promise resolving to an array of file metadata objects.
 */
function processFiles(files: FileList) {
	return Promise.all(Array.from(files).map(processFile));
}

/**
 * Renders a preview for a single uploaded file. Shows an inline image preview
 * for JPEG/PNG files, or a download link for all other file types. Returns null
 * if no data URL is available.
 */
function FileInfoPreview<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({ fileInfo, registry }: { fileInfo: FileInfoType; registry: Registry<T, S, F> }) {
	const { translateString } = registry;
	const { dataURL, type, name } = fileInfo;
	if (!dataURL) {
		return null;
	}

	// If type is JPEG or PNG then show image preview.
	// Originally, any type of image was supported, but this was changed into a whitelist
	// since SVGs and animated GIFs are also images, which are generally considered a security risk.
	if (['image/jpeg', 'image/png'].includes(type)) {
		return <img src={dataURL} style={{ maxWidth: '100%' }} className="file-preview" />;
	}

	// otherwise, let users download file

	return (
		<>
			{' '}
			<a download={`preview-${name}`} href={dataURL} className="file-download">
				{translateString(TranslatableString.PreviewLabel)}
			</a>
		</>
	);
}

/**
 * Renders a list of uploaded files with their name, type, size, optional preview,
 * and a delete button for each. Provides visual feedback about what files are
 * currently attached to the form field.
 */
function FilesInfo<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({
	/* eslint-disable @typescript-eslint/no-unused-vars */
	filesInfo,
	registry,
	preview,
	onRemove,
	options,
}: {
	filesInfo: FileInfoType[];
	registry: Registry<T, S, F>;
	preview?: boolean;
	onRemove: (index: number) => void;
	options: UIOptionsType<T, S, F>;
}) {
	if (filesInfo.length === 0) {
		return null;
	}
	const { translateString } = registry;

	return (
		<ul className="file-info">
			{filesInfo.map((fileInfo, key) => {
				const { name, size, type } = fileInfo;
				const handleRemove = () => onRemove(key);
				return (
					<li key={key}>
						<Markdown>
							{translateString(TranslatableString.FilesInfo, [
								name,
								type,
								String(size),
							])}
						</Markdown>
						{preview && (
							<FileInfoPreview<T, S, F> fileInfo={fileInfo} registry={registry} />
						)}
						<IconButton sx={{ ml: 1 }} onClick={handleRemove} size="small">
							<DeleteIcon />
						</IconButton>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Extracts file metadata from an array of base64 data URLs by decoding each
 * into a Blob. Silently skips invalid data URLs so that corrupt entries
 * do not break the file list display.
 *
 * @param dataURLs - Array of base64-encoded data URL strings.
 * @returns Array of FileInfoType objects for each valid data URL.
 */
function extractFileInfo(dataURLs: string[]): FileInfoType[] {
	return dataURLs.reduce((acc, dataURL) => {
		// Skip null/undefined entries that may exist in a sparse array
		if (!dataURL) {
			return acc;
		}
		try {
			// Decode the data URL back into a Blob to extract size, type, and the embedded file name
			const { blob, name } = dataURItoBlob(dataURL);
			return [
				...acc,
				{
					dataURL,
					name: name,
					size: blob.size,
					type: blob.type,
				},
			];
		} catch {
			// Invalid dataURI, so just ignore it.
			return acc;
		}
	}, [] as FileInfoType[]);
}

/**
 *  The `FileWidget` is a widget for rendering file upload fields.
 *  It is typically used with a string property with data-url format.
 */
function FileWidget<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>(props: WidgetProps<T, S, F>) {
	const { disabled, readonly, required, multiple, onChange, value, options, registry } = props;
	// Retrieve the base input template from the registry so file input inherits the app's styling
	const BaseInputTemplate = getTemplate<'BaseInputTemplate', T, S, F>(
		'BaseInputTemplate',
		registry,
		options
	);

	const handleChange = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			if (!event.target.files) {
				return;
			}
			// Process each selected file into a base64 data URL, then update the form value.
			// For multi-file fields, append new files to the existing array rather than replacing.
			processFiles(event.target.files).then((filesInfoEvent) => {
				const newValue = filesInfoEvent.map((fileInfo) => fileInfo.dataURL);
				if (multiple) {
					onChange(value.concat(newValue));
				} else {
					onChange(newValue[0]);
				}
			});
		},
		[multiple, value, onChange]
	);

	// Memoize the parsed file metadata from the current form value for the preview list
	const filesInfo = useMemo(
		() => extractFileInfo(Array.isArray(value) ? value : [value]),
		[value]
	);
	// Remove a file by index: filter it out for multi-file fields, or clear the value for single-file
	const rmFile = useCallback(
		(index: number) => {
			if (multiple) {
				const newValue = value.filter(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(_: any, i: number) => i !== index
				);
				onChange(newValue);
			} else {
				onChange(undefined);
			}
		},
		[multiple, value, onChange]
	);
	return (
		<div>
			<BaseInputTemplate
				{...props}
				disabled={disabled || readonly}
				type="file"
				required={value ? false : required} // this turns off HTML required validation when a value exists
				onChangeOverride={handleChange}
				value=""
				accept={options.accept ? String(options.accept) : undefined}
			/>
			<FilesInfo<T, S, F>
				filesInfo={filesInfo}
				onRemove={rmFile}
				registry={registry}
				preview={options.filePreview}
				options={options}
			/>
		</div>
	);
}

export default FileWidget;

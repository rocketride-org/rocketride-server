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

/**
 * Byte multipliers for each storage unit size.
 * Used by formatting functions to convert raw byte counts into human-readable units.
 */
export enum UNIT_SIZE {
	Bytes = 1,
	KB = 1024,
	MB = Math.pow(1024, 2),
	GB = Math.pow(1024, 3),
	TB = Math.pow(1024, 4),
	PB = Math.pow(1024, 5),
	EB = Math.pow(1024, 6),
}

/**
 * String labels for storage unit sizes, used as display suffixes in formatted output.
 */
export enum Units {
	Bytes = 'Bytes',
	KB = 'KB',
	MB = 'MB',
	GB = 'GB',
	TB = 'TB',
	PB = 'PB',
	EB = 'EB',
}

/**
 * Formats a raw byte count into a human-readable string with the most appropriate unit
 * (e.g., "1.5 MB", "300 KB"). The result is localized and rounded to two decimal places.
 *
 * @param value - The size in bytes to format, or `undefined`.
 * @returns A formatted string like `"2.45 GB"`, or `undefined` if the input is `undefined`.
 */
export const formatSize = (value: number | undefined): string | undefined => {
	let unit = '';
	let size = 0;

	// If no size, done
	if (value === undefined) return;

	// Select the largest unit where the value is >= 1, cascading from smallest to largest
	if (value < UNIT_SIZE.KB) {
		unit = 'Bytes';
		size = value;
	} else if (value < UNIT_SIZE.MB) {
		unit = 'KB';
		size = value / UNIT_SIZE.KB;
	} else if (value < UNIT_SIZE.GB) {
		unit = 'MB';
		size = value / UNIT_SIZE.MB;
	} else if (value < UNIT_SIZE.TB) {
		unit = 'GB';
		size = value / UNIT_SIZE.GB;
	} else if (value < UNIT_SIZE.PB) {
		unit = 'TB';
		size = value / UNIT_SIZE.TB;
	} else if (value < UNIT_SIZE.EB) {
		unit = 'PB';
		size = value / UNIT_SIZE.PB;
	} else {
		unit = 'EB';
		size = value / UNIT_SIZE.EB;
	}

	// Truncate to two decimal places (floor, not round) and localize the number
	return (Math.floor(size * 100) / 100).toLocaleString() + ' ' + unit;
};

/**
 * Formats a value that is already expressed in gigabytes by first converting it
 * back to bytes and then applying {@link formatSize}. Used specifically by system
 * information views where the API returns sizes in GB.
 *
 * @param sizeInBytes - The size value in gigabyte units (despite the parameter name).
 * @returns A formatted string with the appropriate unit, or `undefined`.
 */
export const formatGigabyteSize = (sizeInBytes: number): string | undefined => {
	if (sizeInBytes === undefined) return undefined;

	// Convert from gigabytes back to bytes so formatSize can pick the best unit
	const value = UNIT_SIZE[Units.GB] * sizeInBytes;
	return formatSize(value);
};

/**
 * Converts a raw byte count to gigabytes as a floating-point number.
 *
 * @param bytes - The value in bytes.
 * @returns The equivalent value in gigabytes.
 */
export function convertBytesToGB(bytes: number) {
	const bytesInGB = 1024 ** 3; // 1 GB = 1024^3 bytes

	return bytes / bytesInGB;
}

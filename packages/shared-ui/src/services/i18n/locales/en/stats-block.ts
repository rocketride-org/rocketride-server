// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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
 * Type definition for the "stats-block" translation namespace.
 * Describes translatable labels for the statistics dashboard cards
 * showing file counts, sizes, data connections, and processing metrics.
 */
export interface ITranslationStatsBlock {
	fileSize: string;
	fileCount: string;
	sourceCount: string;
	toolchainCount: string;
	loadCount: string;
	fileProcessed: string;
	fileProcessedSize: string;
}

/** English translations for the "stats-block" namespace covering dashboard statistics cards. */
export const statsBlock: ITranslationStatsBlock = {
	fileSize: 'Total Size',
	fileCount: 'Total Files',
	sourceCount: 'Data Connections',
	toolchainCount: 'Projects',
	loadCount: 'Load Count',
	fileProcessed: 'Files Processed',
	fileProcessedSize: 'Processed Size',
};

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

interface UriLike {
	fsPath: string;
}

interface SourceComponentLike {
	id: string;
}

function isPipelineFile(filePath: string): boolean {
	return filePath.endsWith('.pipe') || filePath.endsWith('.pipe.json');
}

export function resolvePipelineCommandUri<T extends UriLike>(explicitUri?: T, activeEditorUri?: T, activeTabUri?: T): T | undefined {
	if (explicitUri) {
		return explicitUri;
	}

	if (activeEditorUri && isPipelineFile(activeEditorUri.fsPath)) {
		return activeEditorUri;
	}

	if (activeTabUri && isPipelineFile(activeTabUri.fsPath)) {
		return activeTabUri;
	}

	return undefined;
}

export function resolvePipelineSourceComponentId<T extends SourceComponentLike>(
	explicitSourceId?: string,
	pipelineSourceId?: string,
	sourceComponents: T[] = []
): string | undefined {
	if (explicitSourceId) {
		return explicitSourceId;
	}

	if (pipelineSourceId) {
		return pipelineSourceId;
	}

	return sourceComponents[0]?.id;
}

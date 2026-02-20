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
 * Barrel file that re-exports all keyboard shortcut hooks used in the project canvas.
 * Centralizes imports so consumers can pull any shortcut hook from a single path,
 * keeping the canvas component tree clean and discoverable.
 */

import { useArrowNavigation } from './useArrowNavigation';
import { useDevMode } from './useDevMode';
import { useRunPipeline } from './useRunPipeline';
import { useSelectAll } from './useSelectAll';
import { useGroup } from './useGroup';
import { useUngroup } from './useUngroup';
import { useSave } from './useSave';
import { useCopy, usePaste } from './useCopyPaste';
import { useNodeTraversal } from './useNodeTraversal';
import { useUndoRedo } from './useUndoRedo';

export {
	useArrowNavigation,
	useDevMode,
	useRunPipeline,
	useSelectAll,
	useGroup,
	useUngroup,
	useSave,
	useCopy,
	usePaste,
	useNodeTraversal,
	useUndoRedo,
};

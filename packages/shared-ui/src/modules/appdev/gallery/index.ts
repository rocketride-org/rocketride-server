// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// COMPONENT GALLERY — MODULE BARREL
// =============================================================================

/**
 * The component gallery's public surface, re-exported through the appdev
 * module barrel (`shared/modules/appdev`) - like the rest of appdev it is
 * deliberately NOT on the shared-ui main barrel, so the gallery costs
 * nothing on the shell's eager `shared` singleton.
 */

export { ComponentGallery } from './ComponentGallery';
export { KnobsPanel } from './KnobsPanel';
export type { IKnobsPanelProps } from './KnobsPanel';
export { GALLERY_ENTRIES, GALLERY_GROUPS } from './registry';
export type {
	GalleryGroup,
	IGalleryDemoProps,
	IGalleryEntry,
	IGalleryKnob,
	IGalleryPropRow,
	KnobValue,
	KnobValues,
} from './galleryTypes';

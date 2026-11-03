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
// TOOL GLYPH — a dev tool's icon as a currentColor glyph
// =============================================================================
//
// Rail icons and strip tabs must follow the chrome's foreground color (rest /
// hover / active states), so the tool's icon URL is applied as a CSS MASK
// filled with currentColor — the same treatment the shared SidebarView gives
// its tool strip tabs — rather than drawn as an <img>. Tools without an icon
// fall back to the generic extensions glyph.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { CodiconExtensions } from 'shared/components/icons/Codicon';

/**
 * One dev tool's rail/strip glyph.
 *
 * @param props.iconUrl - The tool's icon URL; absent renders the generic glyph.
 * @param props.size - Square glyph size in px (20 reads well on the rail).
 */
export const ToolGlyph: React.FC<{ iconUrl?: string | undefined; size?: number }> = ({ iconUrl, size = 20 }) => {
	if (!iconUrl) return <CodiconExtensions size={size} />;
	const mask: CSSProperties = {
		width: size,
		height: size,
		display: 'inline-block',
		backgroundColor: 'currentColor',
		WebkitMaskImage: `url(${iconUrl})`,
		maskImage: `url(${iconUrl})`,
		WebkitMaskRepeat: 'no-repeat',
		maskRepeat: 'no-repeat',
		WebkitMaskSize: 'contain',
		maskSize: 'contain',
		WebkitMaskPosition: 'center',
		maskPosition: 'center',
	};
	return <span aria-hidden style={mask} />;
};

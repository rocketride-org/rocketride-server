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
// CODICON — VS Code's icon glyphs, for surfaces that mirror VS Code chrome
// =============================================================================
//
// Glyph path data is from microsoft/vscode-codicons (code MIT, icons
// CC-BY-4.0 — this header is the required attribution). Vendored as inline
// SVG components matching the shell's IconComponent contract, so a codicon
// and a BoxIcon are interchangeable anywhere an icon is accepted.
//
// Deliberately a HAND-PICKED subset: only glyphs a RocketRide surface
// actually renders. Each icon keeps its source viewBox (the set mixes 16 and
// 24 grids); `size` scales the rendered box exactly like BoxIcon.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props every codicon accepts — mirrors the shell's IconComponent contract. */
export interface CodiconProps {
	size?: number;
	color?: string;
	className?: string;
	style?: CSSProperties;
}

export type CodiconComponent = React.FC<CodiconProps>;

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Builds a codicon component from raw path data.
 *
 * @param paths - The SVG path data (one entry per <path>).
 * @param viewBox - The glyph's source grid (codicons mix 16 and 24).
 * @returns The icon component.
 */
function createCodicon(paths: string[], viewBox: string): CodiconComponent {
	const Icon: CodiconComponent = ({ size = 20, color = 'currentColor', className, style }) => (
		<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox={viewBox} fill={color} className={className} style={style}>
			{paths.map((d, i) => (
				<path key={i} d={d} />
			))}
		</svg>
	);
	return Icon;
}

// =============================================================================
// ICONS
// =============================================================================

/** VS Code's Explorer icon (codicon `files`). */
export const CodiconFiles = createCodicon([
	'M7.5 22.5H17.595C17.07 23.4 16.11 24 15 24H7.5C4.185 24 1.5 21.315 1.5 18V6C1.5 4.89 2.1 3.93 3 3.405V18C3 20.475 5.025 22.5 7.5 22.5ZM21 8.121V18C21 19.6545 19.6545 21 18 21H7.5C5.8455 21 4.5 19.6545 4.5 18V3C4.5 1.3455 5.8455 0 7.5 0H12.879C13.4715 0 14.0505 0.24 14.4705 0.6585L20.3415 6.5295C20.766 6.954 21 7.5195 21 8.121ZM13.5 6.75C13.5 7.164 13.8375 7.5 14.25 7.5H19.1895L13.5 1.8105V6.75ZM19.5 18V9H14.25C13.0095 9 12 7.9905 12 6.75V1.5H7.5C6.672 1.5 6 2.1735 6 3V18C6 18.8265 6.672 19.5 7.5 19.5H18C18.828 19.5 19.5 18.8265 19.5 18Z',
], '0 0 24 24');

/** VS Code's Source Control icon (codicon `source-control`). */
export const CodiconSourceControl = createCodicon([
	'M21 8.25C21 6.1815 19.3185 4.5 17.25 4.5C15.1815 4.5 13.5 6.1815 13.5 8.25C13.5 10.023 14.739 11.5035 16.395 11.892C16.116 12.819 15.2655 13.5 14.25 13.5H9.75C8.9025 13.5 8.1285 13.7925 7.5 14.268V7.4235C9.21 7.0755 10.5 5.5605 10.5 3.75C10.5 1.6815 8.8185 0 6.75 0C4.6815 0 3 1.6815 3 3.75C3 5.562 4.29 7.0755 6 7.4235V16.575C4.29 16.923 3 18.438 3 20.2485C3 22.317 4.6815 23.9985 6.75 23.9985C8.8185 23.9985 10.5 22.317 10.5 20.2485C10.5 18.4755 9.261 16.995 7.605 16.6065C7.884 15.6795 8.7345 14.9985 9.75 14.9985H14.25C16.0845 14.9985 17.61 13.6725 17.931 11.9295C19.674 11.607 21 10.0845 21 8.25ZM4.5 3.75C4.5 2.5095 5.5095 1.5 6.75 1.5C7.9905 1.5 9 2.5095 9 3.75C9 4.9905 7.9905 6 6.75 6C5.5095 6 4.5 4.9905 4.5 3.75ZM9 20.25C9 21.4905 7.9905 22.5 6.75 22.5C5.5095 22.5 4.5 21.4905 4.5 20.25C4.5 19.0095 5.5095 18 6.75 18C7.9905 18 9 19.0095 9 20.25ZM17.25 10.5C16.0095 10.5 15 9.4905 15 8.25C15 7.0095 16.0095 6 17.25 6C18.4905 6 19.5 7.0095 19.5 8.25C19.5 9.4905 18.4905 10.5 17.25 10.5Z',
], '0 0 24 24');

/** VS Code's Extensions icon (codicon `extensions`) — the dev-tools modules button. */
export const CodiconExtensions = createCodicon([
	'M15 4.95703C15 4.58711 14.8563 4.24054 14.5949 3.97992L12.0096 1.39234C11.4879 0.86922 10.5788 0.86922 10.0571 1.39234L8 3.45119V3.32321C8 2.55068 7.37187 1.922 6.6 1.922H2.4C1.62813 1.922 1 2.55068 1 3.32321V13.5988C1 14.3713 1.62813 15 2.4 15H12.6667C13.4385 15 14.0667 14.3713 14.0667 13.5988V9.39514C14.0667 8.62261 13.4385 7.99393 12.6667 7.99393H12.5379L14.5949 5.93508C14.8553 5.67445 15 5.32602 15 4.95703ZM2.4 2.85521H6.6C6.85667 2.85521 7.06667 3.06446 7.06667 3.32228V7.99299H1.93333V3.32228C1.93333 3.06446 2.14333 2.85521 2.4 2.85521ZM1.93333 13.5979V8.92714H7.06667V14.0649H2.4C2.14333 14.0649 1.93333 13.8547 1.93333 13.5979ZM13.1333 9.39421V13.5979C13.1333 13.8547 12.9233 14.0649 12.6667 14.0649H8V8.92714H12.6667C12.9233 8.92714 13.1333 9.13638 13.1333 9.39421ZM8 7.99299V6.46287L9.5288 7.99299H8ZM13.9351 5.2737L11.3488 7.86221C11.1789 8.03223 10.8859 8.03223 10.716 7.86221L8.12973 5.2737C8.0448 5.18963 7.99813 5.07753 7.99813 4.95796C7.99813 4.83839 8.0448 4.7263 8.12973 4.64129L10.716 2.05278C10.8009 1.96777 10.9129 1.92106 11.0324 1.92106C11.1519 1.92106 11.2639 1.96777 11.3488 2.05278L13.9351 4.64129C14.02 4.72536 14.0667 4.83746 14.0667 4.95703C14.0667 5.0766 14.02 5.1887 13.9351 5.2737Z',
], '0 0 16 16');

/** VS Code's circuit-board icon (codicon `circuit-board`) — the Nodes rail glyph. */
export const CodiconCircuitBoard = createCodicon([
	'M12.5 1H3.5C2.121 1 1 2.121 1 3.5V12.5C1 13.879 2.121 15 3.5 15H12.5C13.879 15 15 13.879 15 12.5V3.5C15 2.121 13.879 1 12.5 1ZM6 6.5C6 6.775 5.775 7 5.5 7C5.225 7 5 6.775 5 6.5C5 6.225 5.225 6 5.5 6C5.775 6 6 6.225 6 6.5ZM12.5 14H6V11.5C6 11.225 6.225 11 6.5 11H9.092C9.299 11.581 9.849 12 10.5 12C11.327 12 12 11.327 12 10.5C12 9.673 11.327 9 10.5 9C9.849 9 9.299 9.419 9.092 10H6.5C5.673 10 5 10.673 5 11.5V14H3.5C2.673 14 2 13.327 2 12.5V3.5C2 2.673 2.673 2 3.5 2H5V5.092C4.419 5.299 4 5.849 4 6.5C4 7.327 4.673 8 5.5 8C6.327 8 7 7.327 7 6.5C7 5.849 6.581 5.299 6 5.092V2H12.5C13.327 2 14 2.673 14 3.5V6H10.908C10.701 5.419 10.151 5 9.5 5C8.673 5 8 5.673 8 6.5C8 7.327 8.673 8 9.5 8C10.151 8 10.701 7.581 10.908 7H14V12.5C14 13.327 13.327 14 12.5 14ZM10 10.5C10 10.225 10.225 10 10.5 10C10.775 10 11 10.225 11 10.5C11 10.775 10.775 11 10.5 11C10.225 11 10 10.775 10 10.5ZM10 6.5C10 6.775 9.775 7 9.5 7C9.225 7 9 6.775 9 6.5C9 6.225 9.225 6 9.5 6C9.775 6 10 6.225 10 6.5Z',
], '0 0 16 16');

/** VS Code's type-hierarchy icon (codicon `type-hierarchy`) — the Pipelines rail glyph. */
export const CodiconTypeHierarchy = createCodicon([
	'M8 1C6.61929 1 5.5 2.11929 5.5 3.5C5.5 4.7093 6.35863 5.71806 7.4995 5.94989V6.99994H5.36684C4.61209 6.99994 4.00024 7.61178 4.00024 8.36653V10.05C2.859 10.2815 2 11.2904 2 12.5C2 13.8807 3.11929 15 4.5 15C5.88071 15 7 13.8807 7 12.5C7 11.2906 6.14124 10.2818 5.00024 10.0501V8.36653C5.00024 8.16407 5.16437 7.99994 5.36684 7.99994H10.6337C10.8361 7.99994 11.0002 8.16407 11.0002 8.36653V10.05C9.859 10.2815 9 11.2904 9 12.5C9 13.8807 10.1193 15 11.5 15C12.8807 15 14 13.8807 14 12.5C14 11.2906 13.1412 10.2818 12.0002 10.0501V8.36653C12.0002 7.61178 11.3884 6.99994 10.6337 6.99994H8.4995V5.95009C9.64087 5.71865 10.5 4.70966 10.5 3.5C10.5 2.11929 9.38071 1 8 1ZM6.5 3.5C6.5 2.67157 7.17157 2 8 2C8.82843 2 9.5 2.67157 9.5 3.5C9.5 4.32843 8.82843 5 8 5C7.17157 5 6.5 4.32843 6.5 3.5ZM3 12.5C3 11.6716 3.67157 11 4.5 11C5.32843 11 6 11.6716 6 12.5C6 13.3284 5.32843 14 4.5 14C3.67157 14 3 13.3284 3 12.5ZM11.5 11C12.3284 11 13 11.6716 13 12.5C13 13.3284 12.3284 14 11.5 14C10.6716 14 10 13.3284 10 12.5C10 11.6716 10.6716 11 11.5 11Z',
], '0 0 16 16');

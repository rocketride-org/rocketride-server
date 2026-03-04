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

/** URL for the product waitlist / download page, used in marketing CTAs. */
export const WAITLIST_URL = 'https://rocketride.ai/';

/**
 * Enum of external social media profile URLs for the RocketRide brand.
 * Used in footer links, about pages, and social sharing features.
 */
export enum SOCIAL_LINKS {
	DISCORD = 'https://discord.gg/9hr3tdZmEG',
	FACEBOOK = 'https://www.facebook.com/rocketride',
	X = 'https://x.com/rocketrideai',
	LINKEDIN = 'https://www.linkedin.com/company/rocketride-ai',
	YOUTUBE = 'https://www.youtube.com/@rocketrideai',
	INSTAGRAM = 'https://www.instagram.com/rocketrideai/',
}

/**
 * Keys used with `localStorage` for persisting user preferences across sessions.
 * Each key corresponds to a specific UI setting on the project canvas.
 *
 * @remarks FIXME: de-dupe this constant
 */
export const STORAGE_KEY = {
	PIPELINE_NODE_ID: 'PIPELINE_NODE_ID',
	SNAP_TO_GRID: 'SNAP_TO_GRID',
	SHOW_KEYBOARD_SHORTCUTS: 'SHOW_KEYBOARD_SHORTCUTS',
	NAVIGATION_MODE: 'NAVIGATION_MODE',
};

export { NodeType } from './modules/project-canvas/constants';

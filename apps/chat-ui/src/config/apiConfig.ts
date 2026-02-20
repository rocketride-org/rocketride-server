/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * API configuration for development and production modes
 *
 * Values are injected at build time via rsbuild's source.define
 *
 */
export const API_CONFIG: {
	devMode: boolean;
	ROCKETRIDE_URI: string;
	ROCKETRIDE_APIKEY: string;
	[key: string]: any;
} = process.env.CONFIG as any;

// Function to clear and set the config with new values
export const setAPIConfig = (config: Record<string, string>) => {
	// Clear existing keys
	Object.keys(API_CONFIG).forEach(key => {
		delete API_CONFIG[key];
	});

	// Set new keys from config
	Object.keys(config).forEach(key => {
		API_CONFIG[key] = config[key];
	});
};

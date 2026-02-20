/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

/**
 * API configuration for development and production modes
 *
 * Values are injected at build time via rsbuild's source.define
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

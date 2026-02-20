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
 * Service/connector definition types (e.g. dynamic forms, validate response).
 * Split from api/server/types for shared use without pulling in server API layer.
 */

/**
 * Enumeration of operational modes a service/connector can run in.
 * Determines the data-flow direction and behaviour of the connector on the canvas.
 */
export enum IServiceMode {
	TARGET = 'Target',
	SOURCE = 'Source',
	EXPORT = 'Export',
	TRANSFORM = 'Transform',
}

/**
 * Represents a file-system or object-storage path used for include/exclude filters on a service.
 * Additional arbitrary keys can carry provider-specific metadata alongside the path string.
 */
export interface IPath {
	path: string;
	[key: string]: unknown;
}

/**
 * Cost and performance estimation metadata for a service connector.
 * Used by the UI to display estimated resource usage to the user before running a pipeline.
 */
export interface IServiceEstimation {
	storeCost: number;
	accessCost: number;
	accessDelay: number;
	accessRate: number;
}

/**
 * Full definition of a service/connector instance.
 * Describes the configuration, actions, parameters, and path filters
 * for a single connector used within a pipeline.
 */
export interface IService {
	mode: IServiceMode;
	type: string;
	name: string;
	key?: string;
	sync?: string;
	actions: Record<string, unknown>;
	parameters: Record<string, unknown>;
	estimation: IServiceEstimation;
	include?: IPath[];
	exclude?: IPath[];
}

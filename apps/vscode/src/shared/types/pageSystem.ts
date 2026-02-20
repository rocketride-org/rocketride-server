// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

import { ConnectionState } from './index';

/**
 * Path information for system directories
 */
export interface PathInfo {
	diskFree: number;
	diskSize: number;
	diskUsed: number;
	path: string;
}

/**
 * System information data structure (matches server response)
 */
export interface SystemInfo {
	disks: Array<{
		diskFree: number;
		diskSize: number;
		diskUsed: number;
		diskUtilization: number;
		path: string;
	}>;
	diskUtilization: number;
	cpuUtilization?: number;
	memoryUtilization?: number;
	GPUSize: number;
	nCPUCores: number;
	paths: {
		cache: PathInfo;
		control: PathInfo;
		data: PathInfo;
		log: PathInfo;
	};
	platform: string;
}

export type PageSystemIncomingMessage
	= {
		type: 'update';
		systemInfo: SystemInfo;
		state: ConnectionState;
	}
	| {
		type: 'connectionState';
		state: ConnectionState;
	}
	| {
		type: 'error';
		error: string;
		state: ConnectionState;
	};

export type PageSystemOutgoingMessage
	= {
		type: 'ready';
	};

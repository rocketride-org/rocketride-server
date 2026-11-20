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
// MAP - CAMERA MEMORY (one camera per connection, forgotten on sign-out)
// =============================================================================
//
// The map canvas may unmount when its tab is closed and mount again later; the
// camera of each connection is kept here so the view comes back where it was.
// A sign-out or identity change resets the shared selection to no connection,
// and the map then forgets every camera.
// =============================================================================

import type { MapCamera } from './camera';

const cameras = new Map<string, MapCamera>();

/**
 * Keep a connection's camera.
 *
 * @param key - The connection key.
 * @param camera - Its camera.
 */
export function rememberCamera(key: string, camera: MapCamera): void {
	cameras.set(key, camera);
}

/**
 * A connection's last camera.
 *
 * @param key - The connection key.
 * @returns The camera, or null.
 */
export function recallCamera(key: string): MapCamera | null {
	return cameras.get(key) ?? null;
}

/** Forget every camera (sign-out, identity change). */
export function forgetCameras(): void {
	cameras.clear();
}

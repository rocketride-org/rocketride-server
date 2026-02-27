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
 * Default protocol for connections when none is specified.
 */
export const CONST_DEFAULT_WEB_PROTOCOL = 'http://';

/**
 * Default hostname for local RocketRide instances.
 */
export const CONST_DEFAULT_WEB_HOST = 'localhost';

/**
 * Default server port for self-hosted / local RocketRide instances.
 * Applied when no port is specified in the URI.
 */
export const CONST_DEFAULT_WEB_PORT = '5565';

/**
 * Default local RocketRide service endpoint URL.
 */
export const CONST_DEFAULT_WEB_LOCAL = `${CONST_DEFAULT_WEB_PROTOCOL}${CONST_DEFAULT_WEB_HOST}:${CONST_DEFAULT_WEB_PORT}`;

/**
 * Default cloud RocketRide service endpoint URL.
 * Used when no custom URI is provided in the client configuration.
 */
export const CONST_DEFAULT_WEB_CLOUD = 'https://cloud.rocketride.ai:80';

/**
 * @deprecated Use CONST_DEFAULT_WEB_CLOUD instead.
 */
export const CONST_DEFAULT_SERVICE = CONST_DEFAULT_WEB_CLOUD;

/**
 * WebSocket connection timeout in seconds.
 * If no communication occurs within this period, the connection may be considered stale.
 */
export const CONST_SOCKET_TIMEOUT = 180;

/**
 * WebSocket ping interval in seconds.
 * Ping frames are sent at this interval to detect dead connections.
 */
export const CONST_WS_PING_INTERVAL = 15;

/**
 * WebSocket ping timeout in seconds.
 * If no pong response is received within this period after a ping,
 * the connection is considered dead and will be closed.
 */
export const CONST_WS_PING_TIMEOUT = 60;
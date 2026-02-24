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

/** Semantic log field name conventions for RocketRide observability. */

// Service identification
export const SVC_NAME = 'service.name';
export const SVC_VERSION = 'service.version';
export const SVC_INSTANCE_ID = 'service.instance.id';

// Pipeline execution context
export const NODE_ID = 'rocketride.node.id';
export const NODE_TYPE = 'rocketride.node.type';
export const PIPELINE_ID = 'rocketride.pipeline.id';
export const PIPELINE_NAME = 'rocketride.pipeline.name';

// Operation tracking
export const OPERATION = 'rocketride.operation';
export const DURATION_MS = 'rocketride.duration_ms';

// DAP protocol fields
export const DAP_SEQ = 'rocketride.dap.seq';
export const DAP_COMMAND = 'rocketride.dap.command';
export const DAP_MSG_TYPE = 'rocketride.dap.msg_type';

// OpenTelemetry trace context
export const TRACE_ID = 'trace_id';
export const SPAN_ID = 'span_id';
export const TRACE_FLAGS = 'trace_flags';

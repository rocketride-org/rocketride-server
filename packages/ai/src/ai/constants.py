# MIT License
#
# Copyright (c) 2025 RocketRide Corporation
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
RocketRide AI Configuration Constants.

Global configuration values for metrics, billing, and system tuning.
"""

# =============================================================================
# Metrics Sampling and Reporting Intervals
# =============================================================================
CONST_METRICS_SAMPLE_INTERVAL = 0.25  # seconds between metric samples (250ms)
CONST_BILLING_REPORT_INTERVAL = 5 * 60.0  # seconds between billing reports (5 minutes)
CONST_METRICS_STOP_TIMEOUT = 5.0  # seconds to wait for metrics monitoring to stop gracefully

# =============================================================================
# Billing API Configuration
# =============================================================================
CONST_BILLING_API_TIMEOUT = 10.0  # seconds timeout for HTTP requests to billing API

# =============================================================================
# Chargebee Configuration
# =============================================================================
CONST_CHARGEBEE_ITEM_PRICE_ID = 'compute-tokens-USD'  # default metered item price ID
CONST_CHARGEBEE_USAGE_RETRY_COUNT = 1  # retry once on transient failure
CONST_CHARGEBEE_USAGE_RETRY_DELAY = 2.0  # seconds between retries

# =============================================================================
# Billing Rates (tokens per resource-hour)
# =============================================================================
CONST_RATE_VCPU_HOUR = 1020  # tokens per vCPU-hour
CONST_RATE_MEMORY_GB_HOUR = 100  # tokens per memory GB-hour
CONST_RATE_GPU_GB_HOUR = 2140  # tokens per GPU GB-hour

# =============================================================================
# Task Engine Configuration
# =============================================================================
CONST_DEFAULT_MAX_THREADS = 64  # default thread pool size for task execution
CONST_CANCEL_WAIT_TIMEOUT_SECONDS = 5  # seconds to wait for graceful task cancellation
CONST_STATUS_UPDATE_FREQ = 1.0  # seconds between status broadcast updates
CONST_MAX_READY_TIME = 5 * 60  # seconds to wait for task to become ready
CONST_READY_POLL_INTERVAL = 0.250  # seconds between readiness checks
CONST_SUBPROCESS_BUFFER_LIMIT = 16 * 1024 * 1024  # bytes for subprocess stdin/stdout/stderr buffers (16MB)
CONST_STATUS_UPDATE_CANCEL_TIMEOUT = 2.0  # seconds to wait for status update task cancellation
CONST_DEFAULT_TTL = 15 * 60  # default time-to-live for idle tasks in seconds (15 minutes)
CONST_TTL_CHECK = 60 # check for tasks to kill every 60 seconds

# =============================================================================
# Task Server Configuration
# =============================================================================
CONST_CLEANUP_DELAY_TIME = 5 * 60  # seconds grace period to keep completed tasks (5 minutes)
CONST_CLEANUP_SLEEP_TIME = 1 * 60  # seconds between cleanup scans (1 minute)

# =============================================================================
# Web Server Configuration
# =============================================================================
CONST_DEFAULT_WEB_PORT = 5565  # default web server port
CONST_DEFAULT_WEB_HOST = '0.0.0.0'  # default bind address (all interfaces)
CONST_WEB_WS_MAX_SIZE = 250 * 1024 * 1024  # maximum WebSocket message size in bytes (250MB)

# =============================================================================
# Data Connection Configuration
# =============================================================================
CONST_DATA_PIPE_TIMEOUT = 60.0  # seconds of inactivity before pipe is considered zombie
CONST_DATA_SHUTDOWN_TIMEOUT = 30.0  # seconds to wait for data connection shutdown

# =============================================================================
# HTTP/Stream Configuration
# =============================================================================
CONST_HTTP_CHUNK_SIZE = 64 * 1024  # bytes per chunk for streaming data (64KB)

# =============================================================================
# Chat/LLM Retry Configuration
# =============================================================================
CONST_CHAT_MAX_RETRIES = 5  # maximum network/API retry attempts
CONST_CHAT_BASE_DELAY = 1.0  # base delay in seconds for exponential backoff
CONST_CHAT_MAX_DELAY = 60.0  # maximum delay in seconds between retries

# =============================================================================
# Transport/DAP Configuration
# =============================================================================
CONST_TRANSPORT_PROCESS_WAIT_TIMEOUT = 5.0  # seconds to wait for process termination

# =============================================================================
# Model Server Configuration
# =============================================================================
CONST_MODEL_SERVER_PORT = 5590  # default model server port
CONST_MODEL_SERVER_HOST = '0.0.0.0'  # default bind address (all interfaces)
CONST_MODEL_QUEUE_SCALE_UP_THRESHOLD = 50  # queue depth to trigger replica addition
CONST_MODEL_QUEUE_SCALE_DOWN_THRESHOLD = 5  # queue depth to trigger replica removal
CONST_MODEL_QUEUE_SCALE_UP_DELAY = 30  # seconds to wait before scaling up
CONST_MODEL_QUEUE_SCALE_DOWN_DELAY = 300  # seconds to wait before scaling down (5 min)
CONST_MODEL_REPLICA_MANAGER_INTERVAL = 10  # seconds between auto-scaling checks

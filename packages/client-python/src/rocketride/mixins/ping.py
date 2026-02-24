# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
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
Server Connectivity Testing for RocketRide Client.

This module provides ping functionality to test connectivity and responsiveness
of RocketRide servers. Use ping operations to verify server availability, measure
response times, and troubleshoot connection issues.

Usage:
    # Basic connectivity test
    try:
        await client.ping()
        print("Server is responding")
    except RuntimeError as e:
        print(f"Server ping failed: {e}")

    # Test with authentication
    await client.ping(token="your_token")

    # Measure response time
    import time
    start = time.time()
    await client.ping()
    response_time = (time.time() - start) * 1000
    print(f"Server response time: {response_time:.1f}ms")
"""

from ..core import DAPClient


class PingMixin(DAPClient):
    """
    Provides server connectivity testing for the RocketRide client.

    This mixin adds ping functionality to test server connectivity and
    responsiveness. Ping operations are useful for:
    - Verifying server availability before starting operations
    - Measuring network latency and response times
    - Testing authentication credentials
    - Troubleshooting connection issues
    - Health checks in monitoring systems

    Ping operations are lightweight and fast, making them ideal for
    regular connectivity checks without impacting server performance.

    This is automatically included when you use RocketRideClient, so you can
    call client.ping() directly without needing to import this mixin.
    """

    def __init__(self, **kwargs):
        """Initialize ping functionality."""
        super().__init__(**kwargs)

    async def ping(self, token: str = None) -> None:
        """
        Test connectivity to the RocketRide server.

        Sends a lightweight ping request to the server to verify it's responding
        and reachable. This is useful for connectivity testing, health checks,
        and measuring response times.

        The ping operation:
        1. Sends a minimal request to the server
        2. Waits for a response confirming server availability
        3. Returns successfully if server responds
        4. Raises an exception if server is unreachable or not responding

        Args:
            token: Optional authentication token for authenticated ping

        Raises:
            RuntimeError: If the server doesn't respond or ping fails
            ConnectionError: If not connected to server
            TimeoutError: If ping takes too long

        Example:
            # Basic connectivity test
            try:
                await client.ping()
                print("✓ Server is available and responding")
            except RuntimeError as e:
                print(f"✗ Server ping failed: {e}")

            # Measure response time
            import time

            start_time = time.time()
            try:
                await client.ping()
                response_time = (time.time() - start_time) * 1000
                print(f"Server response time: {response_time:.2f}ms")
            except Exception as e:
                print(f"Ping failed: {e}")

            # Health check in a monitoring loop
            async def health_check():
                while True:
                    try:
                        await client.ping()
                        print("Server healthy")
                    except Exception as e:
                        print(f"Server health check failed: {e}")
                        # Maybe alert or reconnect

                    await asyncio.sleep(30)  # Check every 30 seconds

            # Test with authentication
            try:
                await client.ping(token="your_session_token")
                print("✓ Authenticated ping successful")
            except RuntimeError as e:
                print(f"✗ Authenticated ping failed: {e}")

        Use Cases:
            - Pre-flight checks before starting operations
            - Network connectivity troubleshooting
            - Service health monitoring
            - Response time measurement
            - Connection validation after network changes

        Notes:
            - Ping is a lightweight operation with minimal server impact
            - Response time includes network latency plus server processing
            - Failed pings may indicate network, server, or authentication issues
            - Regular pings can detect connection problems early
        """
        # Build ping request
        request = self.build_request(command='rrext_ping')

        # Send to server and wait for response
        response = await self.request(request)

        # Check if ping failed
        if self.did_fail(response):
            error_msg = response.get('message', 'Ping failed')
            raise RuntimeError(f'Ping failed: {error_msg}')

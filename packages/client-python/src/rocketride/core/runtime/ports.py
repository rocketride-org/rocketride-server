"""
Port allocation for runtime instances.

Scans from a base port upward to find the next available port.
"""

import socket

from ..constants import CONST_DEFAULT_WEB_PORT


def find_available_port(base: int = CONST_DEFAULT_WEB_PORT) -> int:
    """Find the next available TCP port starting from base.

    Checks each port with both a connect attempt (catches processes
    listening on 0.0.0.0) and a bind attempt. Scans up to 100 ports
    above base before giving up.
    """
    for offset in range(100):
        port = base + offset
        try:
            # First check if anything is already listening
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.1)
                result = s.connect_ex(('127.0.0.1', port))
                if result == 0:
                    continue  # Something is listening — skip

            # Then verify we can actually bind
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('0.0.0.0', port))
                return port
        except OSError:
            continue

    raise OSError(f'No available port found in range {base}-{base + 99}')

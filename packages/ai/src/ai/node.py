import argparse
import sys
import asyncio
import threading

# Remove auto-added script directory to avoid import conflicts with the ai package
if sys.path and (sys.path[0].endswith('ai') or sys.path[0].endswith('ai\\') or sys.path[0].endswith('ai/')):
    sys.path.pop(0)

# Import directly from C++
from engLib import debug

# Global shared event loop for async operations in worker threads
# Usage: from ai.node import server_loop
#        future = asyncio.run_coroutine_threadsafe(my_async_func(), server_loop)
#        result = future.result()


def _create_loop():
    """Create the event loop immediately."""
    loop = asyncio.new_event_loop()

    def run_loop():
        asyncio.set_event_loop(loop)
        loop.run_forever()

    thread = threading.Thread(target=run_loop, daemon=True, name='GlobalEventLoop')
    thread.start()
    debug(f'[NODE] Created server_loop at module import: {loop}')
    return loop


# Initialize at module import time
server_loop = _create_loop()
debug(f'[NODE] server_loop initialized: {server_loop}')
_loop_thread = None
_loop_ready = threading.Event()


def _start_event_loop():
    """Log that event loop is ready (already started at import time)."""
    debug(f'[NODE] Global event loop ready: {server_loop}')


def _stop_event_loop():
    """Stop the global event loop."""
    global server_loop, _loop_thread

    if server_loop:
        server_loop.call_soon_threadsafe(server_loop.stop)
        if _loop_thread:
            _loop_thread.join(timeout=5)
        server_loop = None
        _loop_thread = None
        debug('[NODE] Stopped global event loop')


def run():
    """
    Execute the script.
    """
    import os
    
    # Inject mock modules path if set (for testing)
    mock_path = os.environ.get('ROCKETRIDE_MOCK')
    if mock_path:
        sys.path.insert(0, mock_path)

    # Parse arguments
    parser = argparse.ArgumentParser(add_help=False)  # Don't interfere with main arg parsing
    parser.add_argument('--debug_host', type=str, default=None)
    parser.add_argument('--debug_port', type=int, default=None)
    parser.add_argument('--wait_for_client', action='store_true', default=False)

    # Parse only the args we care about, ignore unknown ones
    parsed_args, _ = parser.parse_known_args(sys.argv)

    # Connect to parent process debugpy if arguments provided
    if parsed_args.debug_host and parsed_args.debug_port:
        try:
            import debugpy

            # Get connection details (use debug_host if data_host not provided)
            debug_host = parsed_args.debug_host
            debug_port = parsed_args.debug_port

            debug(f'[NODE] Listening for debugger at {debug_host}:{debug_port}')
            debugpy.listen(
                (
                    debug_host,
                    debug_port,
                ),
                in_process_debug_adapter=True,
            )

            # Enable debugging for this thread
            debugpy.debug_this_thread()

            # If we are supposed to wait for the client attach, do so
            if parsed_args.wait_for_client:
                debug('[NODE] Waiting for client to attach...')
                debugpy.wait_for_client()
                debug('[NODE] Client attached...')

        except Exception as e:
            debug(f'[NODE] Failed to listen for parent debugger: {e}')
    else:
        debug('[NODE] No debugger connection arguments provided, running standalone')

    # Output a debug message indicating the server is initialized
    debug('[NODE] NodeServer initialized')

    # Start the global event loop for async operations
    _start_event_loop()

    # This will actually do the dependency loading and start the main process
    from rocketlib import processArguments, monitorStatus

    # Update the status
    monitorStatus('Loading pipeline')

    try:
        # Start the main engine process (this will block)
        processArguments(sys.argv)
    finally:
        # Stop the event loop on exit
        _stop_event_loop()


if __name__ == '__main__':
    try:
        run()

    except Exception as e:
        debug(e)

    except (KeyboardInterrupt, SystemExit):
        pass

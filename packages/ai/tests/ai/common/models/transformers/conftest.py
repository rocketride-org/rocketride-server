"""Fixtures shared by the sentence-transformer tests."""

import threading
import time

import pytest

# How long the calls a test runs at once are given to finish, all together
_FINISH_S = 30.0


@pytest.fixture
def map_in_threads():
    """Map a function over items on daemon threads, as ``ThreadPoolExecutor.map`` does, within a time limit.

    A pool's shutdown waits for its threads with no limit, so a guard that never lets a call
    through would hang the suite. The function this gives fails the test instead.

    Returns:
        ``run(function, items, workers, finish_s=_FINISH_S)``. It calls ``function`` with each
        item on ``workers`` threads and returns what each call returned, in the order of
        ``items``. It re-raises the error of the first item whose call raised, and fails the test
        when a call is still running after ``finish_s`` seconds; no further call starts then.
    """

    def run(function, items, workers, finish_s=_FINISH_S):
        """Run the calls and return their results in order; see the fixture."""
        items = list(items)
        results = [None] * len(items)
        errors = [None] * len(items)
        pending = iter(range(len(items)))
        take = threading.Lock()

        def work():
            """Run calls until none is left, keeping each result or error."""
            while True:
                with take:
                    index = next(pending, None)
                if index is None:
                    return
                try:
                    results[index] = function(items[index])
                except BaseException as e:  # pytest.fail raises a BaseException too; re-raised below
                    errors[index] = e

        threads = [threading.Thread(target=work, daemon=True) for _ in range(min(workers, len(items)))]
        for thread in threads:
            thread.start()
        deadline = time.monotonic() + finish_s
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        if any(thread.is_alive() for thread in threads):
            with take:
                # a call that returns late must not start another after the test has ended
                for _ in pending:
                    pass
            pytest.fail(f'calls still running after {finish_s} s')
        for error in errors:
            if error is not None:
                raise error
        return results

    return run

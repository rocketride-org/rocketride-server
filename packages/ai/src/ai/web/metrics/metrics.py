import threading
import time
from contextlib import contextmanager
from typing import Any, Dict


class Timer:
    """
    Timer class to measure elapsed time in milliseconds.

    Supports start, stop, pause, resume, and reset operations.
    Uses time.perf_counter() for high-resolution timing.
    """

    def __init__(self, autostart: bool = True):
        """
        Initialize the Timer.

        Args:
            autostart: If True, starts the timer immediately upon creation.
        """
        self.total_time = 0.0  # Total accumulated time in seconds
        self.elapsed_time = 0.0  # Elapsed time since last pause/stop
        self.paused = False

        if autostart:
            self.start_time = time.perf_counter()
        else:
            self.start_time = None

    def start(self):
        """Start the timer if not already started or paused."""
        if self.start_time is None and not self.paused:
            self.start_time = time.perf_counter()

    def stop(self):
        """Stop the timer and accumulate elapsed time."""
        if self.start_time is not None:
            # Compute how long we have been running since start and the total time
            self.elapsed_time = time.perf_counter() - self.start_time
            self.total_time += self.elapsed_time

            # Reset paused state when stopping
            self.start_time = None

    def pause(self):
        """Pause the timer and accumulate elapsed time."""
        self.paused = True
        self.stop()

    def resume(self):
        """Resume the timer if previously paused."""
        self.paused = False
        self.start()

    def elapsed(self):
        """
        Get elapsed time in milliseconds since the last start.

        Returns:
            Total elapsed time in milliseconds, including any currently running time.
        """
        # Get the elapsed time since we stopped
        elapsed_time = self.elapsed_time

        # Add currently running time if timer is active
        if self.start_time is not None:
            elapsed_time += time.perf_counter() - self.start_time

        return elapsed_time * 1000  # Convert to milliseconds

    def total(self):
        """
        Get total time in milliseconds since we started the timer the first time.

        Returns:
            Total elapsed time in milliseconds, including any currently running time.
        """
        # Get the elapsed time since we stopped
        total_time = self.total_time

        # Add currently running time if timer is active
        if self.start_time is not None:
            total_time += time.perf_counter() - self.start_time

        return total_time * 1000  # Convert to milliseconds

    def reset(self):
        """Reset the timer to initial state."""
        self.total_time = 0.0
        self.elapsed_time = 0.0
        self.start_time = None
        self.paused = False


class MetricsManager:
    """
    Central class to manage timing and counter metrics for tasks and pipes..

    Supports:
    - Task-level metrics (with task IDs)
    - Pipe-level metrics (per pipe)
    - Timers for different resources
    - Counters for numeric metrics
    - Events for structured logging
    - Context managers for resource timing
    """

    def __init__(self):
        """Initialize the MetricsManager with empty task and pipe metrics."""
        self._task_metrics = {}  # Task ID -> metrics dict
        self._pipe_metrics = {}  # Pipe ID -> metrics dict
        self._lock = threading.Lock()

    def _pause_all(self, pipe_metrics: Dict[str, Any]):
        # Get the timers
        timers = pipe_metrics.get('timers', {})

        # Pause all timers
        for timer in timers.values():
            timer.pause()

    def _stop_all(self, pipe_metrics: Dict[str, Any]):
        # Get the timers
        timers = pipe_metrics.get('timers', {})

        # Stop all timers
        for timer in timers.values():
            timer.stop()

    def _start_all(self, pipe_metrics: Dict[str, Any]):
        # Get the timers
        timers = pipe_metrics.get('timers', {})

        # Start all non-paused timers
        for timer in timers.values():
            timer.start()

    def _get_pipe_metrics(self, pipe_id: int) -> Dict[str, Any]:
        # Get the pipe metrics
        pipe_metrics = self._pipe_metrics.get(pipe_id, None)

        # Make sure got it
        if not pipe_metrics:
            raise RuntimeError(f'Metrics not initialized for pipe: {pipe_id}')

        # Return it
        return pipe_metrics

    def _merge_pipe_metrics(self, task_metrics: Dict[str, Any], pipe_metrics: Dict[str, Any]):
        """
        Merge another metrics dictionary into the base dictionary.

        This is used for aggregating metrics from different pipes when
        the pipe object has been completed.

        Args:
            task_metrics: The task metrics to merge into
            pipe_metrics: The metrics from the pipe

        NOTE: This must use a synchronous thread lock! Shouldn't be that big
        of a problem since all our callers are synchronous pipe threads.
        """
        with self._lock:
            metrics = task_metrics.get('metrics', {})

            # Copy over all the total times
            timers = pipe_metrics.get('timers', {})
            for resource, timer in timers.items():
                total = timer.total()
                if resource not in metrics['timers']:
                    metrics['timers'][resource] = total
                else:
                    metrics['timers'][resource] += total

            # Copy over all the elapsed times
            counters = pipe_metrics.get('counters', {})
            for resource, value in counters.items():
                if resource not in metrics['counters']:
                    metrics['counters'][resource] = value
                else:
                    metrics['counters'][resource] += value

            # Append all the billable events
            events = pipe_metrics.get('events', [])
            for event in events:
                metrics['events'].append(event)

    def _report(self, task_metrics: Dict[str, Any]):
        pass

    def begin_task(self, task_id: str):
        """
        Initialize and start metrics tracking for a specific task.

        Args:
            task_id: Unique identifier for the task.

        Raises:
            RuntimeError: If metrics are already initialized for this task.
        """
        # Check if we have already started
        if task_id in self._task_metrics:
            raise RuntimeError(f'Metrics already initialized for task: {task_id}')

        # Initialize task metrics with a total time timer
        self._task_metrics[task_id] = {
            'total_time': Timer(autostart=True),
            'metrics': {
                'timers': {},
                'counters': {},
                'events': [],
            },
        }

    def end_task(self, task_id: str):
        """
        Stop metrics tracking for a specific task.

        Args:
            task_id: The task identifier to end tracking for.
        """
        # Get the task metrics
        task_metrics = self._task_metrics.pop(task_id, None)

        # If we didn't find them for this task
        if not task_metrics:
            raise RuntimeError(f'Metrics not initialized for task: {task_id}')

        # Stop the total time timer
        task_metrics['total_time'].stop()

        # Return the report
        return self._report(task_metrics)

    def begin_object(self, task_id: str, pipe_id: int):
        """
        Initialize metrics tracking for the current object.

        Creates a new metrics structure for the current object containing:
        - timers: Dictionary of resource name -> Timer object
        - counters: Dictionary of counter name -> int value
        - events: List of structured event dictionaries

        Raises:
            RuntimeError: If metrics are already initialized for this pipe.
        """
        # Get the pipe metrics
        pipe_metrics = self._pipe_metrics.get(pipe_id, None)

        # If they are there, then error
        if pipe_metrics:
            raise RuntimeError(f'Metrics already initialized for pipe: {pipe_id}')

        # Build the metrics info with an autostart cpu timer
        metrics = {
            'timers': {'cpu': Timer()},
            'counters': {},  # Counter name -> int value
            'events': [],  # List of event dictionaries
        }

        # Initialize pipe specific metrics structure
        self._pipe_metrics[pipe_id] = metrics

        # One more object being pushed through
        self.counter(pipe_id, 'request', 1)

    def end_object(self, task_id: str, pipe_id: int):
        """
        Stop all metrics tracking for the current object.

        This stops all active timers and merges the current objects metrics
        into the task metrics
        """
        # Get/remove the pipe metrics
        pipe_metrics = self._pipe_metrics.pop(pipe_id, None)

        # Make sure got it
        if not pipe_metrics:
            raise RuntimeError(f'Metrics not initialized for pipe: {pipe_id}')

        # Stop all active timers
        self._stop_all(pipe_metrics)

        # Get the task metrics
        task_metrics = self._task_metrics.get(task_id, None)

        # If we didn't find them for this task
        if not task_metrics:
            raise RuntimeError(f'Metrics not initialized for task: {task_id}')

        # Merge into our task
        self._merge_pipe_metrics(task_metrics, pipe_metrics)

        # Return
        return

    def counter(self, pipe_id: int, name: str, value: int):
        """
        Increment a named counter by the specified value.

        Args:
            name: The name of the counter.
            value: The value to add to the counter.
        """
        pipe_metrics = self._get_pipe_metrics(pipe_id)
        counters = pipe_metrics['counters']
        counters[name] = counters.get(name, 0) + value

    def event(self, pipe_id: int, event: Dict[str, Any]):
        """
        Log a structured event with the given details.

        Args:
            event: Dictionary containing event data.
        """
        pipe_metrics = self._get_pipe_metrics(pipe_id)
        pipe_metrics['events'].append(event)

    def start_timer(self, pipe_id: int, resource: str = 'cpu'):
        """
        Start timing for a specific resource.

        Args:
            resource: The name of the resource being timed.
        """
        pipe_metrics = self._get_pipe_metrics(pipe_id)
        timers = pipe_metrics['timers']
        # Create timer if it doesn't exist, then start it
        timer = timers.setdefault(resource, Timer(autostart=False))
        timer.start()

    def stop_timer(self, pipe_id: int, resource: str = 'cpu'):
        """
        Stop timing for a specific resource.

        Args:
            resource: The name of the resource to stop timing.
        """
        pipe_metrics = self._get_pipe_metrics(pipe_id)
        timers = pipe_metrics['timers']

        if resource in timers:
            timers[resource].stop()

    def pause_timer(self, pipe_id: int, resource: str = 'cpu'):
        """
        Pause timing for a specific resource.

        Args:
            resource: The name of the resource to pause.
        """
        pipe_metrics = self._get_pipe_metrics(pipe_id)
        timers = pipe_metrics['timers']

        if resource in timers:
            timers[resource].pause()

    def resume_timer(self, pipe_id: int, resource: str = 'cpu'):
        """
        Resume timing for a specific resource.

        Args:
            resource: The name of the resource to resume.
        """
        pipe_metrics = self._get_pipe_metrics(pipe_id)
        timers = pipe_metrics['timers']

        if resource in timers:
            timers[resource].resume()

    @contextmanager
    def resource(self, pipe_id: int, name: str):
        """
        Context manager to time a specific resource.

        Args:
            name: The name of the resource being timed.

        Usage:
            with metrics.resource("gpu"):
                ...  # code to measure
        """
        pipe_metrics = self._get_pipe_metrics(pipe_id)
        timers = pipe_metrics['timers']

        # Create timer if it doesn't exist
        timer = timers.setdefault(name, Timer(autostart=False))
        timer.start()

        try:
            yield
        finally:
            timer.stop()

    @contextmanager
    def pause_all(self, pipe_id: int):
        """
        Context manager to temporarily pause all active timers.

        Example:
            with metrics.pause_all():
                ...  # do something without affecting timers
        """
        pipe_metrics = self._get_pipe_metrics(pipe_id)
        timers = pipe_metrics['timers']

        # Pause all timers
        for timer in timers.values():
            if timer.start_time is not None:  # Only pause if running
                timer.pause()

        try:
            yield
        finally:
            # Resume all paused timers
            for timer in timers.values():
                if timer.paused:
                    timer.resume()


# Global instance used throughout the application
metrics = MetricsManager()

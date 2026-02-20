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
Base Command Abstract Class for RocketRide CLI Commands.

This module provides the BaseCommand abstract base class that defines the common
interface and shared functionality for all RocketRide CLI commands. Use this class
as the foundation when implementing new CLI commands to ensure consistent behavior,
error handling, and resource management across the command suite.

The base class provides common functionality including client creation, connection
management, configuration loading, cleanup operations, and abstract methods that
concrete commands must implement for their specific operations.

Key Features:
    - Abstract base class defining standard command interface
    - Common functionality shared across all CLI commands
    - Client creation and connection management utilities
    - Pipeline configuration loading with error handling
    - Resource cleanup and lifecycle management
    - Standardized error handling patterns

Usage:
    class MyCommand(BaseCommand):
        async def execute(self, client):
            # Implementation specific logic
            return 0

Components:
    BaseCommand: Abstract base class for all CLI command implementations
"""

from abc import ABC, abstractmethod
from ..utils.config import load_pipeline_config


class BaseCommand(ABC):
    """
    Abstract base class providing common functionality for all CLI commands.

    Define the standard interface and shared functionality that all RocketRide CLI
    commands must implement. Provide common utilities for client management,
    configuration loading, and resource cleanup while requiring concrete
    implementations to define their specific execution logic.

    Example:
        ```python
        class MyCommand(BaseCommand):
            def __init__(self, cli, args):
                super().__init__(cli, args)

            async def execute(self, client):
                # Command-specific implementation
                return 0
        ```

    Key Features:
        - Standardized initialization with CLI context and arguments
        - Common client and monitor lifecycle management
        - Pipeline configuration loading utilities
        - Resource cleanup and error handling patterns
        - Abstract execute method requiring implementation
    """

    def __init__(self, cli, args):
        """
        Initialize BaseCommand with CLI context and parsed arguments.

        Establish the common foundation for all CLI commands by storing
        the CLI context and command arguments for use in command execution
        and lifecycle management.

        Args:
            cli: CLI instance providing cancellation state, events, and utilities
            args: Parsed command line arguments containing command-specific options
        """
        self.cli = cli
        self.args = args
        self.client = None
        self.monitor = None

    async def create_client(self):
        """
        Create and connect an RocketRide client instance.

        Establish a connection to the RocketRide server using the configured
        URI and authentication, with proper error handling and event
        callback setup for command-specific event processing.

        Returns:
            Connected RocketRideClient instance ready for use

        Raises:
            ImportError: If RocketRideClient cannot be imported
            ConnectionError: If connection to server fails
        """
        try:
            from rocketride import RocketRideClient
        except ImportError:
            from rocketride import RocketRideClient

        self.client = RocketRideClient(
            self.cli.uri,
            auth=self.args.apikey,
            on_event=self.cli._handle_event,
        )

        await self.client.connect()
        return self.client

    async def cleanup(self):
        """
        Clean up command resources and connections.

        Perform graceful cleanup of client connections and other resources
        when command execution completes or is interrupted. Handle cleanup
        errors gracefully to ensure proper resource deallocation.
        """
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
            finally:
                self.client = None

    def load_pipeline_config(self, pipeline_file: str):
        """
        Load and validate pipeline configuration from file.

        Load pipeline configuration from the specified file path with
        comprehensive error handling for file access, parsing, and
        validation issues.

        Args:
            pipeline_file: Path to the pipeline configuration file

        Returns:
            Parsed pipeline configuration dictionary

        Raises:
            FileNotFoundError: If pipeline file doesn't exist
            ValueError: If file format is invalid or parsing fails
        """
        return load_pipeline_config(pipeline_file)

    @abstractmethod
    async def execute(self) -> int:
        """
        Execute the command-specific logic.

        Implement the main command functionality in concrete subclasses.
        This method must be overridden to provide the specific behavior
        for each command type.

        Returns:
            Exit code: 0 for success, non-zero for errors

        Note:
            Concrete implementations should handle all command-specific
            logic including validation, execution, and error handling
            while using the common utilities provided by the base class.
        """
        pass

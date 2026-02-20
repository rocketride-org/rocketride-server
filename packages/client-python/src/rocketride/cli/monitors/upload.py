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
Real-time Upload Progress Monitor for RocketRide File Uploads.

This module provides the UploadProgressMonitor class for comprehensive monitoring
and display of file upload operations with progress tracking, statistics, error
handling, and dynamic layout management. Use this monitor to track upload progress,
view real-time statistics, monitor errors and completion status, and maintain
visibility into file transfer operations.

The upload monitor creates organized displays showing active uploads with progress
bars, completed files, failed uploads with error messages, and overall upload
statistics with automatic space management and visual formatting.

Key Features:
    - Real-time upload progress tracking with visual progress bars
    - Dynamic display layout adapting to terminal size
    - Comprehensive upload statistics and throughput calculations
    - Error tracking and detailed failure reporting
    - File validation error display with user-friendly formatting
    - Final results summary with timing and performance data

Usage:
    monitor = UploadProgressMonitor(cli)
    monitor.set_total_files(file_count)
    monitor.display_status(upload_event)

Components:
    UploadProgressMonitor: Comprehensive upload progress monitor with statistics
"""

from pathlib import Path
from typing import Dict, Any, Optional, List
from .base import BoxMonitor
from ..ui.box import Box
from ..ui.colors import ANSI_RED, ANSI_GREEN, ANSI_RESET, CHR_CHECK, CHR_CROSS, CHR_BLOCK, CHR_LIGHT_BLOCK
from ..utils.formatters import format_size, truncate_filename


class UploadProgressMonitor(BoxMonitor):
    """
    Real-time upload progress monitor for file uploads.

    Provides comprehensive monitoring and display of file upload operations with
    progress tracking, real-time statistics, error handling, and dynamic layout
    management. Shows active uploads with progress bars, completed files,
    failed uploads with error messages, and overall upload statistics.

    Example:
        ```python
        # Create upload monitor
        monitor = UploadProgressMonitor(cli)

        # Set total files for progress calculation
        monitor.set_total_files(10)

        # Update display with upload progress
        monitor.display_status(upload_event_message)

        # Show final results
        monitor.display_final_results(results, start_time, end_time)
        ```

    Key Features:
        - Live upload progress tracking with visual progress bars
        - Dynamic space allocation for different display sections
        - Real-time statistics including throughput and completion rates
        - Error tracking with detailed failure messages
        - File validation error display with user guidance
        - Final results summary with comprehensive statistics
    """

    def __init__(self, cli, width: int = None, height: int = None):
        """
        Initialize UploadProgressMonitor with CLI context and terminal dimensions.

        Set up the monitor for tracking and displaying file upload progress
        with the configured terminal display settings.

        Args:
            cli: CLI instance for access to cancellation state and events
            width: Terminal width override (None for auto-detect)
            height: Terminal height override (None for auto-detect)

        Usage:
            Creates a comprehensive upload monitor that tracks upload state
            across multiple files and provides organized status displays
            with automatic layout management based on terminal size.
        """
        super().__init__(cli, 'RocketRide File Upload', width, height)

        # Upload tracking state
        self._total_files = 0  # Total number of files to upload
        self.active_uploads = {}  # Currently uploading files with progress
        self.completed_uploads = {}  # Successfully completed uploads
        self.failed_uploads = {}  # Failed uploads with error messages

        # Set initial status
        self.set_command_status('Preparing upload...')

    def _create_progress_bar(self, percent: float, width: int = 30) -> str:
        """
        Create a progress bar string.

        Generates a visual progress bar using block characters to show
        completion percentage with precise formatting.

        Args:
            percent: Completion percentage (0-100)
            width: Character width of the progress bar

        Returns:
            str: Formatted progress bar with percentage

        Visual Format:
            [████████████░░░░░░░] 65.4%
            - Filled blocks show completed progress
            - Light blocks show remaining progress
            - Percentage displayed with decimal precision
        """
        # Calculate how many characters should be filled
        filled_length = int(width * percent / 100)

        # Create bar with filled and unfilled sections
        bar = CHR_BLOCK * filled_length + CHR_LIGHT_BLOCK * (width - filled_length)

        return f'[{bar}] {percent:5.1f}%'

    def set_total_files(self, total_files: int):
        """
        Set the total number of files to upload.

        Used by upload commands to initialize the progress tracking
        with the expected total number of files.

        Args:
            total_files: Total number of files that will be uploaded

        Usage:
            Call this method before starting uploads to enable
            accurate progress calculation and display statistics.
        """
        self._total_files = total_files

    def display_validation_errors(self, invalid_files: List[str]):
        """
        Display file validation errors.

        Displays file validation errors in a formatted box, limiting
        the number shown to avoid overwhelming the display.

        Args:
            invalid_files: List of validation error messages

        Display Features:
            - Color-coded error indicators with cross symbols
            - Limited display count to prevent screen overflow
            - Truncation message for additional errors
            - Clear error formatting for user guidance
        """
        validation_error_lines = []
        display_count = min(len(invalid_files), 15)

        # Format validation errors with cross symbol
        for error in invalid_files[:display_count]:
            validation_error_lines.append(f'{ANSI_RED}{CHR_CROSS}{ANSI_RESET} {error}')

        # Add truncation message if there are more errors
        if len(invalid_files) > 15:
            remaining = len(invalid_files) - 15
            validation_error_lines.append(f'... and {remaining} more validation errors')

        # Display validation errors
        self.set_command_status('File validation completed with errors')
        self.add_box('File Validation Errors', validation_error_lines)
        self.draw()

    def display_final_results(self, results: List[Dict[str, Any]], start_time: float, end_time: float):
        """
        Display final upload results.

        Processes upload results to generate statistics and creates
        comprehensive display showing summary, failures, and successes.

        Args:
            results: List of upload result dictionaries from client
            start_time: Upload start timestamp
            end_time: Upload completion timestamp

        Display Sections:
            - Upload Summary: Overall statistics and timing
            - Failed Uploads: Files that failed with error details
            - Recent Successful Uploads: Recently completed files
        """
        self.clear()

        # Categorize results
        successful_files = []
        failed_files = []

        for result in results:
            filename = Path(result['filepath']).name
            if result['action'] == 'complete':
                successful_files.append(
                    {
                        'name': filename,
                        'size': result['file_size'],
                        'time': result['upload_time'],
                    }
                )
            else:
                failed_files.append(
                    {
                        'name': filename,
                        'error': result.get('error', 'Unknown error'),
                    }
                )

        # Build comprehensive results display
        self._build_final_summary_box(results, start_time, end_time)

        if failed_files:
            self._build_final_failed_files_box(failed_files)

        if successful_files:
            self._build_final_successful_files_box(successful_files)

        # Update final status and render
        self.set_command_status('Completed')
        self.draw()

    def _build_final_summary_box(self, results: List[Dict[str, Any]], start_time: float, end_time: float):
        """
        Build final upload summary box.

        Creates a summary box with overall statistics including file counts,
        data transfer amounts, timing information, and throughput calculations.

        Args:
            results: List of upload result dictionaries from client
            start_time: Upload start timestamp
            end_time: Upload completion timestamp

        Summary Information:
            - Total files processed and success/failure counts
            - Total data transferred with size formatting
            - Elapsed time with appropriate time units
            - Average throughput calculations
        """
        successful = sum(1 for r in results if r['action'] == 'complete')
        failed = len(results) - successful
        total_bytes = sum(r['file_size'] for r in results if r['action'] == 'complete')

        # Build summary lines with counts and data amounts
        summary_lines = [f'Total files processed: {successful + failed}']
        summary_lines.append(f'Successful uploads: {ANSI_GREEN}{successful}{ANSI_RESET}')
        if failed > 0:
            summary_lines.append(f'Failed uploads: {ANSI_RED}{failed}{ANSI_RESET}')
        summary_lines.append(f'Total data uploaded: {format_size(total_bytes)}')

        # Add timing and throughput information if available
        if start_time and end_time and end_time > start_time:
            elapsed_seconds = end_time - start_time

            # Format elapsed time appropriately
            if elapsed_seconds < 60:
                elapsed_str = f'{elapsed_seconds:.1f} seconds'
            elif elapsed_seconds < 3600:
                minutes = int(elapsed_seconds // 60)
                seconds = elapsed_seconds % 60
                elapsed_str = f'{minutes}m {seconds:.1f}s'
            else:
                hours = int(elapsed_seconds // 3600)
                minutes = int((elapsed_seconds % 3600) // 60)
                seconds = elapsed_seconds % 60
                elapsed_str = f'{hours}h {minutes}m {seconds:.1f}s'

            summary_lines.append(f'Total elapsed time: {elapsed_str}')

            # Calculate and display average throughput
            if total_bytes > 0 and elapsed_seconds > 0:
                throughput_bps = total_bytes / elapsed_seconds
                throughput_str = format_size(int(throughput_bps))
                summary_lines.append(f'Average throughput: {throughput_str}/s')

        self.add_box('Upload Summary', summary_lines)

    def _build_final_failed_files_box(self, failed_files: List[Dict[str, Any]]):
        """
        Build final failed files box.

        Creates a display box showing failed uploads with error messages,
        truncating long lists and messages to fit the display.

        Args:
            failed_files: List of failed file dictionaries with names and errors

        Display Features:
            - Error indicators with cross symbols
            - Truncated filenames and error messages for space
            - Limited display count with truncation indicators
        """
        failure_lines = []

        # Show up to 10 failed files with truncated names and error messages
        for failed_file in failed_files[:10]:
            error_width = self.width - 34  # Reserve space for formatting
            filename = failed_file['name'][:25] + '...' if len(failed_file['name']) > 25 else failed_file['name']
            error_msg = failed_file['error'][:error_width] + '...' if len(failed_file['error']) > error_width else failed_file['error']
            failure_lines.append(f'{ANSI_RED}{CHR_CROSS}{ANSI_RESET} {filename} - {error_msg}')

        # Add truncation message if there are more failures
        if len(failed_files) > 10:
            failure_lines.append(f'... and {len(failed_files) - 10} more failures')

        self.add_box(f'Failed Uploads ({len(failed_files)})', failure_lines)

    def _build_final_successful_files_box(self, successful_files: List[Dict[str, Any]]):
        """
        Build final successful files box.

        Creates a display box showing recent successful uploads with
        file sizes and upload times for verification.

        Args:
            successful_files: List of successful file dictionaries with details

        Display Features:
            - Success indicators with check symbols
            - File sizes and upload times for verification
            - Recent files display with truncation for older files
        """
        success_lines = []

        # Show the 5 most recent successful uploads
        for success_file in successful_files[-5:]:
            truncated_name = success_file['name'][:35] + '...' if len(success_file['name']) > 35 else success_file['name']
            size_str = format_size(success_file['size'])
            time_str = f'{success_file["time"]:.1f}s'
            success_lines.append(f'{ANSI_GREEN}{CHR_CHECK}{ANSI_RESET} {truncated_name} ({size_str}, {time_str})')

        # Add truncation message if there are more successes
        if len(successful_files) > 5:
            success_lines.append(f'... and {len(successful_files) - 5} more successful uploads')

        self.add_box('Recent Successful Uploads', success_lines)

    def display_status(self, message: Dict[str, Any]):
        """
        Handle upload progress events.

        Processes upload progress events from the client and updates the
        display state accordingly. Tracks file progress through different
        stages: writing, closing, completion, and error handling.

        Args:
            message: DAP event message containing upload progress data

        Upload States Handled:
            - write: Active file transfer with progress updates
            - close: File finalization and completion processing
            - complete: Successful upload completion
            - error: Upload failure with error information
        """
        # Extract event data
        body = message.get('body', {})
        filepath = body.get('filepath', 'unknown')
        bytes_sent = body.get('bytes_sent', 0)
        file_size = body.get('file_size', 0)
        action = body.get('action', None)

        # Use just filename for display tracking
        filename = Path(filepath).name

        if action == 'write':
            # Update progress for active upload
            self.active_uploads[filename] = {
                'filepath': filepath,
                'action': action,
                'bytes_sent': bytes_sent,
                'file_size': file_size,
            }

        elif action == 'close':
            # File is being finalized
            if filename in self.active_uploads:
                self.active_uploads[filename].update(
                    {
                        'action': action,
                        'bytes_sent': bytes_sent,
                        'file_size': file_size,
                    }
                )

        elif action == 'complete':
            # File completed successfully
            self.active_uploads.pop(filename, None)
            self.completed_uploads[filename] = {
                'filepath': filepath,
                'action': action,
                'file_size': file_size,
            }

        elif action == 'error':
            # File failed with error
            self.active_uploads.pop(filename, None)
            error_message = body.get('error', 'Unknown error')
            self.failed_uploads[filename] = {
                'filepath': filepath,
                'action': action,
                'file_size': file_size,
                'error': error_message,
            }

        # Update command status based on current state
        if self._cli.is_cancelled():
            self.set_command_status(f'{ANSI_RED}Upload cancelling...{ANSI_RESET}')
        else:
            total_processed = len(self.completed_uploads) + len(self.failed_uploads)
            self.set_command_status(f'Processed {total_processed} of {self._total_files} files...')

        # Refresh the display with updated data
        self._render_upload_status()

        # Check for cancellation and abort if needed
        if self._cli.is_cancelled():
            raise RuntimeError('Upload cancelled')

    def _build_active_uploads_box(self, available_lines: int) -> Optional[Box]:
        """
        Build the active uploads box with dynamic sizing.

        Creates a display box showing currently uploading files with progress
        bars, adapting to available screen space and truncating when necessary.

        Args:
            available_lines: Number of lines available for active uploads display

        Returns:
            Optional[Box]: Formatted box for active uploads, None if no active uploads

        Display Features:
            - Progress bars showing upload completion percentage
            - Current upload phase (Writing/Finalize)
            - Data transfer amounts and file sizes
            - Dynamic sizing based on available terminal space
        """
        if not self.active_uploads:
            return None

        # Calculate how many uploads we can show
        max_content_lines = max(available_lines - 2, 1)
        upload_lines = []
        active_items = list(self.active_uploads.items())

        # Reserve space for "more uploads" message if needed
        display_count = min(len(active_items), max_content_lines)
        if len(active_items) > max_content_lines:
            display_count = max_content_lines - 1

        # Format each active upload with progress information
        for filename, data in active_items[:display_count]:
            # Truncate filename for consistent formatting
            display_name = truncate_filename(filename, 20).ljust(20)

            # Show current phase of upload
            action = data.get('action', None)
            phase = 'Writing ' if action == 'write' else 'Finalize' if action == 'close' else '        '

            # Calculate progress percentage
            bytes_sent = data.get('bytes_sent', 0)
            file_size = data.get('file_size', 1)
            percent = (bytes_sent / file_size * 100) if file_size > 0 else 0

            # Create progress display elements
            progress_bar = self._create_progress_bar(percent, 12)
            size_info = f'{format_size(bytes_sent)}/{format_size(file_size)}'
            upload_line = f'{display_name} {phase} {progress_bar} {size_info}'

            upload_lines.append(upload_line)

        # Add "more uploads" message if we truncated the list
        if len(self.active_uploads) > display_count:
            remaining = len(self.active_uploads) - display_count
            upload_lines.append(f'... and {remaining} more uploads in progress')

        # Pad with empty lines to maintain consistent box size
        while len(upload_lines) < max_content_lines:
            upload_lines.append('')

        return Box(f'Active Uploads ({len(self.active_uploads)})', upload_lines, self.width)

    def _build_upload_summary_box(self) -> Optional[Box]:
        """
        Build the upload summary box.

        Creates a summary display showing overall statistics including
        completed files, failed files, and total data transferred.

        Returns:
            Optional[Box]: Formatted box for upload summary, None if no data to show

        Summary Information:
            - Completed file count
            - Failed file count
            - Total data transferred with size formatting
        """
        if not self.completed_uploads and not self.failed_uploads:
            return None

        # Calculate summary statistics
        total_completed = len(self.completed_uploads)
        total_failed = len(self.failed_uploads)
        total_bytes = sum(data['file_size'] for data in self.completed_uploads.values())

        # Build summary lines
        summary_lines = []
        if total_completed > 0:
            summary_lines.append(f'Completed: {total_completed} files')
        if total_failed > 0:
            summary_lines.append(f'Failed: {total_failed} files')
        summary_lines.append(f'Total size: {format_size(total_bytes)}')

        return Box('Upload Summary', summary_lines, self.width)

    def _build_failed_uploads_box(self) -> Optional[Box]:
        """
        Build the failed uploads box.

        Creates a display showing recent failed uploads with error messages,
        truncating long lists to show most recent failures.

        Returns:
            Optional[Box]: Formatted box for failed uploads, None if no failures

        Display Features:
            - Error indicators with cross symbols
            - Truncated filenames and error messages
            - Recent failures with count indicators
        """
        if not self.failed_uploads:
            return None

        lines = []
        failed_items = list(self.failed_uploads.items())

        # Show recent failures, limiting display count
        display_count = 4 if len(failed_items) > 5 else min(5, len(failed_items))
        more_line = len(failed_items) > 5

        # Format each failed upload with error message
        for filename, data in failed_items[-display_count:]:
            display_name = truncate_filename(filename, 25)
            error_msg = data['error'][:30] + '...' if len(data['error']) > 30 else data['error']
            lines.append(f'{ANSI_RED}{CHR_CROSS}{ANSI_RESET} {display_name} - {error_msg}')

        # Add "more failures" message if we truncated
        if more_line:
            remaining = len(failed_items) - display_count
            lines.append(f'... and {remaining} more files have failed')

        return Box(f'Failed Uploads ({len(self.failed_uploads)})', lines, self.width)

    def _build_recently_completed_box(self) -> Optional[Box]:
        """
        Build the recently completed box.

        Creates a display showing the most recently completed uploads
        with file sizes for confirmation.

        Returns:
            Optional[Box]: Formatted box for completed uploads, None if none completed

        Display Features:
            - Success indicators with check symbols
            - File sizes for verification
            - Recent completions display
        """
        if not self.completed_uploads:
            return None

        completed_lines = []
        completed_items = list(self.completed_uploads.items())

        # Show the 3 most recent completions
        for filename, data in completed_items[-3:]:
            display_name = truncate_filename(filename, 35)
            size_str = format_size(data['file_size'])
            completed_lines.append(f'{ANSI_GREEN}{CHR_CHECK}{ANSI_RESET} {display_name} ({size_str})')

        return Box('Recently Completed', completed_lines, self.width)

    def _render_upload_status(self):
        """
        Render the complete upload status display.

        Orchestrates the display of all upload information by building
        appropriate boxes and managing screen space allocation dynamically.

        Display Layout:
            - Active uploads (dynamically sized based on available space)
            - Upload summary (if data available)
            - Failed uploads (if any failures)
            - Recently completed uploads (if any completions)
        """
        self.clear()

        # Collect all boxes to display
        boxes_to_show = []

        # Add summary box if we have data
        summary_box = self._build_upload_summary_box()
        if summary_box:
            boxes_to_show.append(summary_box)

        # Add failed uploads box if there are failures
        failed_box = self._build_failed_uploads_box()
        if failed_box:
            boxes_to_show.append(failed_box)

        # Add completed uploads box if there are completions
        completed_box = self._build_recently_completed_box()
        if completed_box:
            boxes_to_show.append(completed_box)

        # Calculate remaining space for active uploads
        command_box = Box(self.command_title, self.command_status, self.width)
        command_lines = len(command_box.render()) + 1

        # Calculate space used by other boxes
        other_boxes_lines = command_lines
        for box in boxes_to_show:
            other_boxes_lines += len(box.render()) + 1

        # Allocate remaining space to active uploads
        available_lines = max(self.height - other_boxes_lines, 5)

        # Add active uploads box (gets remaining space)
        active_box = self._build_active_uploads_box(available_lines)
        if active_box:
            boxes_to_show.insert(0, active_box)  # Show active uploads first

        # Add all boxes to display
        for box in boxes_to_show:
            self.add_box(box.title, box.lines)

        # Render the complete display
        self.draw()

    def reset(self):
        """
        Reset the monitor for a new upload session.

        Clears all upload tracking state and resets the display for
        a fresh upload operation.

        Usage:
            Call this method to prepare the monitor for a new upload
            session, clearing all previous upload history and statistics.
        """
        # Clear all tracking dictionaries
        self.active_uploads.clear()
        self.completed_uploads.clear()
        self.failed_uploads.clear()

        # Reset status and display
        self.set_command_status('Preparing upload...')
        self.clear_screen()

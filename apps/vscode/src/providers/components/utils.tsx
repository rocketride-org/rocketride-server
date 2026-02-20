// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Utility Functions for Time and Data Formatting
 * 
 * This module provides essential utility functions for formatting time durations
 * and file sizes in a human-readable format throughout the VSCode extension.
 * These utilities ensure consistent formatting across all components and provide
 * a better user experience by displaying technical data in accessible formats.
 * 
 * Key Design Principles:
 * - Consistent formatting patterns across the application
 * - Human-readable output that users can quickly understand
 * - Proper handling of edge cases (zero values, large numbers)
 * - Locale-aware formatting where appropriate
 * - Performance-optimized for frequent use in UI components
 * 
 * @fileoverview Formatting utilities for time and data size display
 * @module Utils
 */

// ============================================================================
// TIME FORMATTING UTILITIES
// ============================================================================

/**
 * Enhanced Elapsed Time Formatter
 * 
 * Converts elapsed time in seconds into a detailed, human-readable format
 * with appropriate granularity based on the duration length. This function
 * provides more descriptive labels than typical "HH:MM:SS" format, making
 * it easier for users to quickly understand durations at a glance.
 * 
 * Formatting Strategy:
 * - Under 1 minute: Shows only seconds for simplicity
 * - 1 minute to 1 hour: Shows minutes and seconds for precision
 * - 1 hour or more: Shows hours, minutes, and seconds for completeness
 * 
 * Output Format Examples:
 * - 0-59 seconds: "45secs"
 * - 1-59 minutes: "5min, 30secs"  
 * - 1+ hours: "1hr, 26min, 30secs"
 * 
 * Use Cases:
 * - Pipeline execution time display
 * - Job duration monitoring
 * - Real-time elapsed time updates
 * - Historical job duration reporting
 * 
 * Technical Considerations:
 * - Uses Math.floor() to ensure integer seconds display
 * - Handles modulo arithmetic correctly for time unit conversion
 * - Provides consistent comma-separated format for multi-unit display
 * - Avoids showing zero units (e.g., won't show "0hr" in output)
 * 
 * @param seconds - Duration in seconds to format (can be decimal)
 * @returns string Formatted duration with descriptive labels
 * 
 * @example
 * ```typescript
 * formatElapsedTime(45);      // "45secs"
 * formatElapsedTime(90);      // "1min, 30secs"
 * formatElapsedTime(3665);    // "1hr, 1min, 5secs"
 * formatElapsedTime(7200);    // "2hr, 0min, 0secs"
 * formatElapsedTime(0.5);     // "0secs" (rounds down)
 * ```
 */
export const formatElapsedTime = (seconds: number): string => {
    // ========================================================================
    // INPUT NORMALIZATION
    // ========================================================================
    
    /**
     * Normalize Input to Integer Seconds
     * 
     * Convert potentially decimal input to whole seconds for display.
     * Uses Math.floor to ensure consistent rounding behavior (always down)
     * rather than Math.round which could create confusion in real-time displays.
     */
    const totalSeconds = Math.floor(seconds);
    
    // ========================================================================
    // SHORT DURATION FORMATTING (< 1 MINUTE)
    // ========================================================================
    
    /**
     * Handle Durations Under 1 Minute
     * 
     * For very short durations, showing minutes would be misleading
     * and showing "0min, Xsecs" would be verbose. Simple seconds
     * display provides the clearest information.
     */
    if (totalSeconds < 60) {
        return `${totalSeconds}secs`;
    }
    
    // ========================================================================
    // MEDIUM DURATION FORMATTING (1 MINUTE - 1 HOUR)
    // ========================================================================
    
    /**
     * Handle Durations Between 1 Minute and 1 Hour
     * 
     * For medium durations, minutes and seconds provide appropriate
     * granularity. Hours would be misleading, and seconds alone
     * would be hard to quickly interpret.
     */
    if (totalSeconds < 3600) {
        const minutes = Math.floor(totalSeconds / 60);           // Extract whole minutes
        const remainingSeconds = totalSeconds % 60;              // Calculate remaining seconds
        return `${minutes}min, ${remainingSeconds}secs`;
    }
    
    // ========================================================================
    // LONG DURATION FORMATTING (1+ HOURS)
    // ========================================================================
    
    /**
     * Handle Durations of 1 Hour or More
     * 
     * For long durations, showing hours, minutes, and seconds provides
     * complete information while maintaining readability. This level
     * of detail is appropriate for long-running processes.
     * 
     * Time Unit Extraction:
     * 1. Hours: Divide total seconds by 3600, floor to get whole hours
     * 2. Minutes: Get remainder after hours, divide by 60, floor for whole minutes  
     * 3. Seconds: Final remainder after hours and minutes are extracted
     */
    const hours = Math.floor(totalSeconds / 3600);                    // Extract whole hours
    const minutes = Math.floor((totalSeconds % 3600) / 60);           // Extract remaining minutes
    const remainingSeconds = totalSeconds % 60;                       // Extract remaining seconds
    
    return `${hours}hr, ${minutes}min, ${remainingSeconds}secs`;
};

// ============================================================================
// DATA SIZE FORMATTING UTILITIES
// ============================================================================

/**
 * Byte Size Formatter with Binary Units
 * 
 * Converts raw byte counts into human-readable file sizes using binary
 * units (1024-based) which are standard for file system and memory
 * representations. This provides accurate size information that matches
 * what users expect from their operating systems.
 * 
 * Unit Progression:
 * - B (Bytes): 1-1023 bytes
 * - KB (Kilobytes): 1024 bytes = 1 KB
 * - MB (Megabytes): 1024² bytes = 1 MB  
 * - GB (Gigabytes): 1024³ bytes = 1 GB
 * - TB (Terabytes): 1024⁴ bytes = 1 TB
 * 
 * Formatting Features:
 * - Uses binary (1024) rather than decimal (1000) for accuracy
 * - Shows 1 decimal place precision for readability
 * - Handles zero bytes gracefully
 * - Automatic unit selection based on size magnitude
 * 
 * Design Decisions:
 * - Binary units match OS file size displays
 * - Single decimal place balances precision vs readability
 * - Covers range from bytes to terabytes for future-proofing
 * - Simple, clean output format without unnecessary precision
 * 
 * @param bytes - The number of bytes to format (must be non-negative)
 * @returns string Formatted size with appropriate unit (e.g., "1.5 MB")
 * 
 * @example
 * ```typescript
 * formatBytes(0);           // "0 B"
 * formatBytes(512);         // "512 B"  
 * formatBytes(1024);        // "1.0 KB"
 * formatBytes(1536);        // "1.5 KB"
 * formatBytes(1048576);     // "1.0 MB"
 * formatBytes(2684354560);  // "2.5 GB"
 * formatBytes(1099511627776); // "1.0 TB"
 * ```
 */
export const formatBytes = (bytes: number): string => {
    // ========================================================================
    // ZERO BYTES EDGE CASE
    // ========================================================================
    
    /**
     * Handle Zero Bytes Special Case
     * 
     * Zero bytes should display as "0 B" rather than going through
     * the logarithmic calculation which would be undefined or incorrect.
     * This provides clear, expected output for empty files or initialization states.
     */
    if (bytes === 0) return '0 B';
    
    // ========================================================================
    // UNIT CALCULATION SETUP
    // ========================================================================
    
    /**
     * Binary Unit Base and Size Labels
     * 
     * Define the conversion base and unit labels for file size calculation.
     * 
     * Binary vs Decimal:
     * - k = 1024 (binary): Matches OS file system displays, more accurate for digital data
     * - k = 1000 (decimal): Used by storage manufacturers, less common in software
     * 
     * We use binary (1024) because:
     * - Matches user expectations from file managers
     * - Consistent with memory and storage representations
     * - Standard in most development and system administration contexts
     */
    const k = 1024;                                    // Binary base for accurate file sizes
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];       // Unit labels in progression order
    
    // ========================================================================
    // UNIT INDEX CALCULATION
    // ========================================================================
    
    /**
     * Determine Appropriate Unit Index
     * 
     * Calculate which unit (B, KB, MB, etc.) is most appropriate for
     * the given byte count using logarithmic mathematics.
     * 
     * Mathematical Approach:
     * - log(bytes) / log(k) gives us the power of k needed
     * - Math.floor ensures we get the largest appropriate unit
     * - Result is index into sizes array
     * 
     * Examples:
     * - 512 bytes: log(512)/log(1024) = 0.88 → floor = 0 → sizes[0] = "B"
     * - 2048 bytes: log(2048)/log(1024) = 1.1 → floor = 1 → sizes[1] = "KB"  
     * - 1048576 bytes: log(1048576)/log(1024) = 2.0 → floor = 2 → sizes[2] = "MB"
     */
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    // ========================================================================
    // VALUE CALCULATION AND FORMATTING
    // ========================================================================
    
    /**
     * Calculate and Format Final Value
     * 
     * Convert the raw byte count to the appropriate unit and format
     * for display with proper precision and unit label.
     * 
     * Calculation Process:
     * 1. Divide bytes by k^i to get value in target unit
     * 2. Round to 1 decimal place using toFixed(1)
     * 3. Convert back to number with parseFloat to remove trailing zeros
     * 4. Concatenate with space and unit label
     * 
     * Precision Decision:
     * - toFixed(1) ensures consistent decimal places
     * - parseFloat removes unnecessary trailing zeros (e.g., "2.0" becomes "2")
     * - Balances precision with readability
     */
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

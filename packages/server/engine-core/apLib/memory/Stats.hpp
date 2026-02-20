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

#pragma once

namespace ap::memory {

struct Stats {
    Size virtualMemoryTotal;
    Size virtualMemoryUsed;
    Size virtualMemoryUsedByProcess;

    Size physicalMemoryTotal;
    Size physicalMemoryUsed;
    Size physicalMemoryUsedByProcess;

    friend std::ostream &operator<<(std::ostream &stream,
                                    const Stats &stats) noexcept {
        stream << "Memory Stats:\n";
        stream << " VirtTotalSystem: " << stats.virtualMemoryTotal << "\n";
        stream << " VirtUsedSystem: " << stats.virtualMemoryUsed << "\n";
        stream << " PhyTotalSystem: " << stats.physicalMemoryTotal << "\n";
        stream << " PhyUsedSystem: " << stats.physicalMemoryUsed << "\n";
        stream << " PhyUsedProcess: " << stats.physicalMemoryUsedByProcess
               << "\n";
        stream << " VirtUsedProcess: " << stats.virtualMemoryUsedByProcess
               << "\n";
        return stream;
    }

    Stats &operator-=(const Stats &other) noexcept {
        virtualMemoryTotal -= other.virtualMemoryTotal;
        virtualMemoryUsed -= other.virtualMemoryUsed;
        virtualMemoryUsedByProcess -= other.virtualMemoryUsedByProcess;
        physicalMemoryTotal -= other.physicalMemoryTotal;
        physicalMemoryUsed -= other.physicalMemoryUsed;
        physicalMemoryUsedByProcess -= other.physicalMemoryUsedByProcess;
        return *this;
    }

    Stats &operator+=(const Stats &other) noexcept {
        virtualMemoryTotal += other.virtualMemoryTotal;
        virtualMemoryUsed += other.virtualMemoryUsed;
        virtualMemoryUsedByProcess += other.virtualMemoryUsedByProcess;
        physicalMemoryTotal += other.physicalMemoryTotal;
        physicalMemoryUsed += other.physicalMemoryUsed;
        physicalMemoryUsedByProcess += other.physicalMemoryUsedByProcess;
        return *this;
    }

    Stats operator-(const Stats &other) const noexcept {
        auto copy = *this;
        copy.virtualMemoryTotal -= other.virtualMemoryTotal;
        copy.virtualMemoryUsed -= other.virtualMemoryUsed;
        copy.virtualMemoryUsedByProcess -= other.virtualMemoryUsedByProcess;
        copy.physicalMemoryTotal -= other.physicalMemoryTotal;
        copy.physicalMemoryUsed -= other.physicalMemoryUsed;
        copy.physicalMemoryUsedByProcess -= other.physicalMemoryUsedByProcess;
        return copy;
    }

    Stats operator+(const Stats &other) const noexcept {
        auto copy = *this;
        copy.virtualMemoryTotal += other.virtualMemoryTotal;
        copy.virtualMemoryUsed += other.virtualMemoryUsed;
        copy.virtualMemoryUsedByProcess += other.virtualMemoryUsedByProcess;
        copy.physicalMemoryTotal += other.physicalMemoryTotal;
        copy.physicalMemoryUsed += other.physicalMemoryUsed;
        copy.physicalMemoryUsedByProcess += other.physicalMemoryUsedByProcess;
        return copy;
    }
};

ErrorOr<Stats> stats() noexcept;

}  // namespace ap::memory

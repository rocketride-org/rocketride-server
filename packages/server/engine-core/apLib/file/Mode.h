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

namespace ap::file {

APUTIL_DEFINE_ENUM(Mode, 0, 5, NONE = _begin, STAT, READ, WRITE, UPDATE);

inline auto isClosedMode(Mode mode) noexcept {
    switch (mode) {
        case Mode::STAT:
        case Mode::READ:
        case Mode::UPDATE:
        case Mode::WRITE:
            return false;
        case Mode::NONE:
            return true;
        default:
            dev::fatality(_location, "Invalid mode", _cast<int>(mode));
    }
}

inline auto isOpenedMode(Mode mode) noexcept { return !isClosedMode(mode); }

inline auto isCreateMode(Mode mode) noexcept {
    switch (mode) {
        case Mode::STAT:
        case Mode::READ:
        case Mode::NONE:
        case Mode::UPDATE:
            return false;

        case Mode::WRITE:
            return true;

        default:
            dev::fatality(_location, "Invalid mode", _cast<int>(mode));
    }
}

inline auto isReadMode(Mode mode) noexcept {
    switch (mode) {
        case Mode::STAT:
        case Mode::READ:
        case Mode::UPDATE:
            return true;

        case Mode::NONE:
        case Mode::WRITE:
            return false;

        default:
            dev::fatality(_location, "Invalid mode", _cast<int>(mode));
    }
}

inline auto isWriteMode(Mode mode) noexcept {
    switch (mode) {
        case Mode::WRITE:
        case Mode::UPDATE:
            return true;

        case Mode::NONE:
        case Mode::READ:
        case Mode::STAT:
            return false;

        default:
            dev::fatality(_location, "Invalid mode", _cast<int>(mode));
    }
}

inline auto isUpdateMode(Mode mode) noexcept { return mode == Mode::UPDATE; }

}  // namespace ap::file

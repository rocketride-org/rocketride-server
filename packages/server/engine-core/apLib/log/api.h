// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

//
//	The rocketride logger api declaration
//
#pragma once

namespace ap::log {

// Define the level state structure, it holds two booleans
// the enabled bit, and the sticky bit. If sticky is true
// then the level remains enabled unless explicitly disabled.
struct State {
    bool enabled = false;
    bool sticky = false;
};
using LvlStateArray = std::array<State, MaxLvls>;

// Define the apis used to detect if a file descriptor is a file or
// some kind of pipe, windows has different versions of the apis so
// normalize them into our own unified set of aliases
#if ROCKETRIDE_PLAT_WIN
#define FileNo _fileno
#define IsAtty _isatty
#else
#define FileNo fileno
#define IsAtty isatty
#endif

// This function holds a static instantiation of the levels array
LvlStateArray& LvlState() noexcept;

// Log level control apis
template <bool Sticky = true, typename... Levels>
Error disableLevel(Levels&&... levels) noexcept;

template <bool Sticky = false, typename... Levels>
Error enableLevel(Levels&&... levels) noexcept;

template <bool Conjunction = true, typename... Levels>
bool isLevelExplicitlyEnabled(Levels&&... levels) noexcept;

template <bool Conjunction = true, typename... Levels>
bool isLevelEnabled(Levels&&... levels) noexcept;

template <typename T = Text>
T getEnabledLevels() noexcept;

void disableAllLevels() noexcept;

void disableAllStrackTraces() noexcept;

void init() noexcept;
void deinit() noexcept;

Atomic<bool>& initialized() noexcept;

}  // namespace ap::log

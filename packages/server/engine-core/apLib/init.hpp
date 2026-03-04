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

#pragma once

namespace ap {

// Main entry point for apLib's global state
inline decltype(auto) init() noexcept {
    // Let the standard call us back if there's a problem with memory
    auto prevHandler = std::set_new_handler(
        [] { dev::fatality(_location, "Memory allocation attempt failed"); });

    return util::Guard{[] {
                           LOG(Init, "Init begin");
                           async::init();
                           application::init();
                           log::init();
                           async::work::init();
                           crypto::init();
                           plat::init();
                           LOG(Init, "Init end");
                       },
                       [prevHandler] {
                           LOG(Init, "Deinit begin");
                           async::work::deinit();
                           plat::deinit();
                           crypto::deinit();
                           application::deinit();
                           log::deinit();
                           async::deinit();
                           std::set_new_handler(prevHandler);
                           LOG(Init, "Deinit end");
                       }};
}

}  // namespace ap

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

namespace ap::plat {

// Simple object to init com on construction, and delete it
// on destruction, gets bound to our tls model
struct ComInit {
    ComInit() noexcept {
        hresult = ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    }

    ~ComInit() noexcept {
        if (hresult && SUCCEEDED(*hresult)) ::CoUninitialize();
    }

    ComInit(const ComInit&) = delete;
    ComInit& operator=(const ComInit&) = delete;

    ComInit(ComInit&&) = default;
    ComInit& operator=(ComInit&&) = default;

    // Initializes com on the current thread
    static Error init() noexcept {
        _thread_local async::Tls<ComInit> init(_location);
        if (FAILED(*init->hresult))
            return APERR(*init->hresult, "Failed to initialize COM");
        return {};
    }

    Opt<HRESULT> hresult;
};

}  // namespace ap::plat
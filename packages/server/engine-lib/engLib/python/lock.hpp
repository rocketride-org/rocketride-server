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

namespace engine::python {
namespace py = pybind11;

extern thread_local bool tls_thread_state_ref;

//-------------------------------------------------------------------------
/// @details
///		This class manages the GIL state and ensures that
///		1.	We are setup to call python on the current thread
///		2.	No matter what happens (exception, error, etc) the GIL is
///			released
//-------------------------------------------------------------------------
class LockPython : public py::gil_scoped_acquire {
public:
    LockPython() : py::gil_scoped_acquire() {
        // If we have not already incremented the thread state reference
        if (!tls_thread_state_ref) {
            // Do it now
            tls_thread_state_ref = true;
            inc_ref();

            // Get the current thread ID
            std::thread::id threadId = std::this_thread::get_id();

            // Output a message indicating the thread ID
            LOG(GIL, "LockPython: Incrementing context reference on thread ",
                threadId);
        }

        if (ap::log::isLevelEnabled(Lvl::GIL)) {
            // Get the current thread ID
            std::thread::id threadId = std::this_thread::get_id();

            // Output to console indicating the lock
            LOG(GIL, "LockPython: Acquiring GIL on thread ", threadId);
        }
    }

    ~LockPython() {
        if (ap::log::isLevelEnabled(Lvl::GIL)) {
            // Get the current thread ID
            std::thread::id threadId = std::this_thread::get_id();

            // Output to console indicating the unlock
            LOG(GIL, "LockPython: Releasing GIL on thread ", threadId);
        }
    }
};

//-------------------------------------------------------------------------
/// @details
///		This class manages the GIL state and ensures that
///		1.	We release python to other threads when we are busy
///		2.	No matter what happens (exception, error, etc) the GIL is
///			relocked when we leave
//-------------------------------------------------------------------------
class UnlockPython : public py::gil_scoped_release {
public:
    UnlockPython() : py::gil_scoped_release() {
        if (ap::log::isLevelEnabled(Lvl::GIL)) {
            // Get the current thread ID
            std::thread::id threadId = std::this_thread::get_id();

            // Output to console indicating the unlock
            LOG(GIL, "UnlockPython: Releasing GIL on thread ", threadId);
        }
    }

    ~UnlockPython() {
        if (ap::log::isLevelEnabled(Lvl::GIL)) {
            // Get the current thread ID
            std::thread::id threadId = std::this_thread::get_id();

            // Output to console indicating the lock
            LOG(GIL, "UnlockPython: Re-acquiring GIL on thread ", threadId);
        }
    }
};
}  // namespace engine::python

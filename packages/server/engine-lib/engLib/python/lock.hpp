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

namespace engine::python {
namespace py = pybind11;

// The GIL thread state reference flag. Behind an accessor as thread_local
// storage cannot cross a dynamic library boundary
ROCKETRIDE_CORE_API bool &threadStateRef() noexcept;

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
        if (!threadStateRef()) {
            // Do it now
            threadStateRef() = true;
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
///		Gives the calling thread one name in the engine and in Python,
///		once per thread.  Defined in init.cpp.  MUST be called with the
///		GIL held.
//-------------------------------------------------------------------------
void syncThreadName() noexcept;

//-------------------------------------------------------------------------
/// @details
///		This class manages the GIL state and ensures that
///		1.	We release python to other threads when we are busy
///		2.	No matter what happens (exception, error, etc) the GIL is
///			relocked when we leave
///		3.	A thread Python started, entering the engine here, is named
///			in the engine before the engine works on it
//-------------------------------------------------------------------------
class UnlockPython {
public:
    UnlockPython() {
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

private:
    // Members, not a base: they initialize in declaration order, so the name
    // is synced while the GIL is still held, before m_release lets it go
    struct SyncName {
        SyncName() noexcept { syncThreadName(); }
    } m_syncName;

    py::gil_scoped_release m_release;
};
}  // namespace engine::python

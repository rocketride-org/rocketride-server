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

namespace ap::async {
//-------------------------------------------------------------
/// @details
///		The class provides functionality of Event object of
/// 	Windows Synchronization API.
///
/// 	IMPORTANT:
///
/// 	The class provides limited functionality of native
/// 	Windows Event object. This limitation is required
/// 	to be aligned with Linux implementation of this class,
/// 	which is more specific due to Linux has no native
/// 	support of Windows Event semantic.
///
/// 	So, if you gonna use it, please ensure the usages
/// 	match supported cases. Or extend it with careful
/// 	support of Linux implementation.
///------------------------------------------------------------
class Event {
public:
    explicit Event(bool manualReset = false) noexcept {
        m_handle =
            ::CreateEventA(nullptr, manualReset ? TRUE : FALSE, FALSE, nullptr);
    }

    ~Event() noexcept { ::CloseHandle(m_handle); }

    Error set() noexcept {
        if (!::SetEvent(m_handle))
            return APERR(::GetLastError(), "failed to set event");
        return {};
    }

    Error reset() noexcept {
        if (!::ResetEvent(m_handle))
            return APERR(::GetLastError(), "failed to reset event");
        return {};
    }

    Error wait() {
        DWORD res = ::WaitForSingleObject(m_handle, INFINITE);

        switch (res) {
            case WAIT_OBJECT_0:
                return {};
            case WAIT_TIMEOUT:
                return APERR(Ec::Timeout, "wait timeout");
            case WAIT_ABANDONED:
                return APERR(Ec::AccessDenied, "wait abandoned");
            case WAIT_FAILED:
                return APERR(::GetLastError(), "wait failed");
            default:
                return APERR(Ec::Unexpected,
                             "wait failed with unexpected result", res);
        }
    }

    ErrorOr<bool> wait(time::Duration timeout) noexcept {
        DWORD ms_timeout = _cast<DWORD>(timeout.asMilliseconds().count());
        DWORD res = ::WaitForSingleObject(m_handle, ms_timeout);

        switch (res) {
            case WAIT_OBJECT_0:
                return true;
            case WAIT_TIMEOUT:
                return false;
            case WAIT_ABANDONED:
                return APERR(Ec::AccessDenied, "wait abandoned");
            case WAIT_FAILED:
                return APERR(::GetLastError(), "wait failed");
            default:
                return APERR(Ec::Unexpected,
                             "wait failed with unexpected result", res);
        }
    }

    static ErrorOr<size_t> waitAny(
        std::initializer_list<Ref<Event>> events) noexcept {
        return waitMany(events, false);
    }

    static ErrorOr<size_t> waitAll(
        std::initializer_list<Ref<Event>> events) noexcept {
        return waitMany(events, true);
    }

private:
    Event(const Event &) = delete;
    void operator=(const Event &) = delete;

    static ErrorOr<size_t> waitMany(std::initializer_list<Ref<Event>> events,
                                    bool waitAll) noexcept {
        if (!events.size())
            return APERR(Ec::InvalidParam, "require at least 1 event");

        auto handles =
            _cast<HANDLE *>(::_alloca(sizeof(HANDLE) * events.size()));
        std::transform(events.begin(), events.end(), handles,
                       [](Event &e) { return e.m_handle; });

        DWORD res =
            ::WaitForMultipleObjects(_cast<DWORD>(events.size()), handles,
                                     waitAll ? TRUE : FALSE, INFINITE);

        if (WAIT_OBJECT_0 <= res && res < WAIT_OBJECT_0 + events.size())
            return _cast<size_t>(res - WAIT_OBJECT_0);
        if (WAIT_ABANDONED_0 <= res && res < WAIT_ABANDONED_0 + events.size())
            return APERR(Ec::AccessDenied, "wait abandoned");
        if (res == WAIT_TIMEOUT) return APERR(Ec::Timeout, "wait timeout");
        if (res == WAIT_FAILED)
            return APERR(::GetLastError(), "wait failed");
        else
            return APERR(Ec::Unexpected, "wait failed with unexpected result",
                         res);
    }

    ::HANDLE m_handle = nullptr;
};
}  // namespace ap::async

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
///		The class provides functionality similar to
/// 	Event object of Windows Synchronization API.
///
/// 	IMPORTANT:
///
/// 	The class provides limited functionality of native
/// 	Windows Event object due to Unix has no native
/// 	support of Windows Event semantic and this
///  	implementation is more specific.
///------------------------------------------------------------
class Event {
public:
    explicit Event(bool manualReset = false) noexcept
        : m_manualReset(manualReset) {
        ::pthread_mutex_init(&m_mutex, nullptr);
        ::pthread_cond_init(&m_cond, nullptr);
    }

    ~Event() noexcept {
        ::pthread_cond_destroy(&m_cond);
        ::pthread_mutex_destroy(&m_mutex);
    }

    Error set() noexcept {
        return lockedCall([this]() noexcept -> Error {
            if (m_set) return {};
            if (0 != ::pthread_cond_signal(&m_cond))
                return APERR(errno, "failed to signal event");
            m_set = true;
            return {};
        });
    }

    Error reset() noexcept {
        return lockedCall([this]() noexcept -> Error {
            m_set = false;
            return {};
        });
    }

    Error wait() noexcept {
        return lockedCall([this]() noexcept -> Error {
            if (m_set) {
                if (!m_manualReset) m_set = false;
                return {};
            }
            if (0 != ::pthread_cond_wait(&m_cond, &m_mutex))
                return APERR(errno, "failed to wait for signal");
            if (!m_manualReset) m_set = false;
            return {};
        });
    }

    ErrorOr<bool> wait(time::Duration timeout) noexcept {
        return lockedCall<bool>([&]() noexcept -> ErrorOr<bool> {
            if (m_set) {
                if (!m_manualReset) m_set = false;
                return true;
            }

            _const long NSEC_IN_SEC = 1'000'000'000;

            ::timespec wait_time = {};
            if (0 != ::clock_gettime(CLOCK_REALTIME, &wait_time)) {
                return APERR(errno, "failed to get time");
            }
            long nsec = wait_time.tv_nsec + timeout.asNanoseconds().count();
            wait_time.tv_sec += nsec / NSEC_IN_SEC;
            wait_time.tv_nsec = nsec % NSEC_IN_SEC;

            int wait_res =
                ::pthread_cond_timedwait(&m_cond, &m_mutex, &wait_time);

            if (0 == wait_res) {
                if (!m_manualReset) m_set = false;
                return true;
            } else if (wait_res == ETIMEDOUT) {
                return false;
            } else {
                return APERR(errno, "failed to wait for signal");
            }
        });
    }

    static ErrorOr<size_t> waitAny(
        std::initializer_list<Ref<Event>> events) noexcept {
        if (!events.size())
            return APERR(Ec::InvalidParam, "require at least 1 event");

        for (;;) {
            size_t i = 0;
            for (Event &e : events) {
                bool isSet = false;
                if (auto isSetOr = e.wait(1ms); isSetOr.check())
                    return isSetOr.check();
                else
                    isSet = isSetOr.value();

                if (isSet) {
                    return i;
                }
                ++i;
            }
        }

        return {};
    }

    static ErrorOr<size_t> waitAll(
        std::initializer_list<Ref<Event>> events) noexcept {
        return APERR(Ec::NotSupported, "not implemented");
    }

private:
    Event(const Event &) = delete;
    void operator=(const Event &) = delete;

    Error lockedCall(Function<Error()> &&call) noexcept {
        if (0 != ::pthread_mutex_lock(&m_mutex))
            return APERR(errno, "failed to lock mutex");
        util::Guard lockGuard{
            [this]() noexcept { ::pthread_mutex_unlock(&m_mutex); }};

        return call();
    }

    template <class T>
    ErrorOr<T> lockedCall(Function<ErrorOr<T>()> &&call) noexcept {
        if (0 != ::pthread_mutex_lock(&m_mutex))
            return APERR(errno, "failed to lock mutex");
        util::Guard lockGuard{
            [this]() noexcept { ::pthread_mutex_unlock(&m_mutex); }};

        return call();
    }

    ::pthread_mutex_t m_mutex = {};
    ::pthread_cond_t m_cond = {};
    bool m_set = false;
    bool m_manualReset;
};
}  // namespace ap::async

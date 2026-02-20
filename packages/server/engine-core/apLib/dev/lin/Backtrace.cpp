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

#include <apLib/ap.h>
#include <backtrace.h>

extern "C" {

static int fullCb(void *data __attribute__((unused)), uintptr_t pc,
                  const char *filename, int lineno,
                  const char *function) noexcept {
    auto frames = static_cast<std::vector<Text> *>(data);

    if (filename && function) {
        int status = {};
        if (auto demangled =
                abi::__cxa_demangle(function, nullptr, nullptr, &status)) {
            frames->push_back(_ts(filename, " ", demangled, ":", lineno));
            free(demangled);
        }
    }

    return 0;
}

static void errorCb(void *data, const char *msg, int errnum) noexcept {
    LOG(Always, "Error", msg);
}

}  // extern "C"

std::vector<Text> createTrace() noexcept {
    static struct backtrace_state *lbstate = nullptr;
    static async::SpinLock lock;
    if (lbstate == nullptr) {
        auto guard = lock.acquire();
        if (lbstate == nullptr)
            lbstate = backtrace_create_state(nullptr, 1, errorCb, NULL);
    }

    std::vector<Text> frames;
    backtrace_full(lbstate, 0, fullCb, errorCb, &frames);
    return _mv(frames);
}

namespace ap::dev {

Backtrace::Backtrace() noexcept
    : m_cachedVec(createTrace()),
      m_threadName(async::getCurrentThreadName()),
      m_threadId(async::threadId()),
      m_processId(async::processId()) {}

const TextView Backtrace::toString() const noexcept {
    if (!m_cachedStr) {
        m_cachedStr = _ts("Process: ", m_processId, " Thread: ", m_threadId,
                          " (", m_threadName, ")\n");
        m_cachedStr += _ts("Trace: ", string::joinVector("\n", m_cachedVec));
    }
    return m_cachedStr;
}

}  // namespace ap::dev

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

//-----------------------------------------------------------------------------
//
//	The handles through which Python reaches an engine filter
//
//-----------------------------------------------------------------------------
#pragma once

#include <memory>
#include <mutex>
#include <utility>

namespace engine::store::pythonBase {
//-------------------------------------------------------------------------
/// @details
///		What Python holds in place of a filter. Python never owns or
///		outlives an engine filter: it owns a handle, and the handle
///		holds only a weak link to the filter. Every forwarded call goes
///		through lock(), which turns the link into a strong pointer for
///		the duration of that one call and refuses the call when the
///		filter is gone. The handle never keeps a strong pointer beyond
///		one forwarded call.
//-------------------------------------------------------------------------
class FilterHandle {
public:
    FilterHandle() = default;
    explicit FilterHandle(const ServiceInstanceWeak &target) noexcept
        : m_target(target) {}
    virtual ~FilterHandle() = default;

    //-----------------------------------------------------------------
    /// @details
    ///		Points the handle at a filter. Takes a weak link only.
    ///	@param target
    ///		The filter's own weak self link
    //-----------------------------------------------------------------
    void bind(const ServiceInstanceWeak &target) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Returns the filter as a strong pointer for the caller to use
    ///		during one call.
    ///	@returns
    ///		The filter
    ///	@throws
    ///		Ec::PipelineEnded "The pipeline has ended" when the handle is
    ///		not bound yet or the filter has been destroyed
    //-----------------------------------------------------------------
    ServiceInstance lock() const noexcept(false);

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Weak link to the filter, guarded by m_lock because bind()
    ///		and lock() may run on different threads
    //-----------------------------------------------------------------
    ServiceInstanceWeak m_target;
    mutable std::mutex m_lock;
};

//-------------------------------------------------------------------------
/// @details
///		The handle behind a node's self.instance
//-------------------------------------------------------------------------
class NodeHandle : public FilterHandle {
public:
    using FilterHandle::FilterHandle;
};

//-------------------------------------------------------------------------
/// @details
///		The handle behind a pipe borrowed from the endpoint, or the
///		next filter down a stack
//-------------------------------------------------------------------------
class PipeHandle : public FilterHandle {
public:
    using FilterHandle::FilterHandle;
};

//-------------------------------------------------------------------------
/// @details
///		Builds the Python-facing method that forwards a filter callback
///		through a handle. It is the one entry of a Python call into a
///		filter callback: the handle turns its weak link into a strong
///		pointer for this one call (and throws when the filter is gone),
///		the call gate counts the call or refuses it, then the callback
///		runs on that filter. The callbacks themselves do not enter the
///		gate. The argument list and the return conversion are those of
///		the callback itself.
///	@param fn
///		The callback (cb_*) of IServiceFilterInstance to forward to
///	@returns
///		A callable taking the handle followed by the callback's arguments
//-------------------------------------------------------------------------
template <typename R, typename... Args>
auto forwardTo(R (IServiceFilterInstance::*fn)(Args...)) {
    return [fn](FilterHandle &handle, Args... args) -> R {
        IServiceFilterInstance::CallGuard guard{handle.lock()};
        return ((*guard.filter()).*fn)(std::forward<Args>(args)...);
    };
}
}  // namespace engine::store::pythonBase

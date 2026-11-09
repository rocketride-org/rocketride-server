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
//	Declares the interface for services and their pipes
//
//-----------------------------------------------------------------------------
#pragma once

//-----------------------------------------------------------------------------
// Define the types for the pipe
//-----------------------------------------------------------------------------
namespace engine::store::filter::pipe {
class IFilterGlobal;
class IFilterInstance;

//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = "pipe"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServicePipe;

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter
//-------------------------------------------------------------------------
class IFilterGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterGlobal, Parent>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    virtual ~IFilterGlobal() noexcept {};
    IFilterGlobal(const FactoryArgs &args) noexcept : Parent(args) {};

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    Error beginFilterGlobal() noexcept override;
    Error endFilterGlobal() noexcept override;

    Error beginObjectMetrics(size_t pipeId, Entry &entry) noexcept;
    Error endObjectMetrics(size_t pipeId, Entry &entry) noexcept;

private:
    //-----------------------------------------------------------------
    // Private API
    //-----------------------------------------------------------------
    Error callMetrics(const Text &hookName, size_t pipeId = 0,
                      Entry *entry = nullptr) noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		The task id of this task
    //-----------------------------------------------------------------
    Text m_taskId;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our metrics object - this is used to notify the
    ///		metrics manager that we have started/ended an object
    //-----------------------------------------------------------------
    py::object m_metrics{};
};

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
class IFilterInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IFilterInstance(const FactoryArgs &args) noexcept;
    virtual ~IFilterInstance() noexcept;

    //-----------------------------------------------------------------
    // Target mode functions
    //-----------------------------------------------------------------
    virtual Error open(Entry &entry) noexcept override;
    virtual Error close() noexcept override;

    //-----------------------------------------------------------------
    ///		Our global data
    //-----------------------------------------------------------------
    SharedPtr<IFilterGlobal> global;

    //-----------------------------------------------------------------
    // Binding identity - set by IServiceEndpoint::getPipe() each time
    // this pipe is handed out. The slot `pipeId` is reused; the binding
    // id never is.
    //-----------------------------------------------------------------

    //-----------------------------------------------------------------
    /// @details
    ///		Monotonic id of the current binding of this pipe; 0 when the
    ///		pipe has never been handed out
    //-----------------------------------------------------------------
    uint64_t bindingId = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		The root of the binding tree: this binding's own id, or the
    ///		root of the parent binding it was opened from
    //-----------------------------------------------------------------
    uint64_t rootBindingId = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Trace level of the current binding - every trace gate on the
    ///		pipe reads this, never the endpoint default
    //-----------------------------------------------------------------
    PIPELINE_TRACE_LEVEL traceLevel = PIPELINE_TRACE_LEVEL::NONE;

    //-----------------------------------------------------------------
    /// @details
    ///		Nesting depth of Binder::callMethods on this pipe - the
    ///		recursion guard (CONST_MAX_BIND_DEPTH)
    //-----------------------------------------------------------------
    std::atomic<int> bindDepth{0};

    //-----------------------------------------------------------------
    /// @details
    ///		Emit one `>DBG` trace line for this binding, gated on
    ///		traceLevel >= METADATA. Fields, '*'-separated:
    ///		kind, pipeId, totalPipes, componentId, bindingId,
    ///		rootBindingId, trace json
    ///	@param[in]	kind
    ///		BEGIN / END / ENTER / LEAVE
    ///	@param[in]	componentId
    ///		The component the line refers to (the entry name for
    ///		BEGIN/END)
    ///	@param[in]	trace
    ///		The trace payload
    //-----------------------------------------------------------------
    void emitTrace(TextView kind, TextView componentId,
                   const json::Value &trace) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Emit a trace line for a filter instance (its pipeType.id is
    ///		the component)
    //-----------------------------------------------------------------
    void emitTrace(TextView kind, IServiceFilterInstance *pInstance,
                   const json::Value &trace) noexcept;
};

//-------------------------------------------------------------------------
/// @details
///		Maximum nesting of Binder::callMethods on one pipe before the
///		call fails with Ec::Recursion
//-------------------------------------------------------------------------
_const int CONST_MAX_BIND_DEPTH = 64;
}  // namespace engine::store::filter::pipe

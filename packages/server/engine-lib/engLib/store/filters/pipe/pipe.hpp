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
    // this pipe is handed out. The slot `pipeId` is reused; the trace
    // id never is.
    //-----------------------------------------------------------------

    //-----------------------------------------------------------------
    /// @details
    ///		The request tree this pipe currently serves: minted from the
    ///		process-wide counter when the pipe starts a tree, or the id of
    ///		the live tree it joined. Every pipe of one tree carries the
    ///		same id; 0 when the pipe has never been handed out
    //-----------------------------------------------------------------
    uint64_t traceId = 0;

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
    ///		The binding generation: bumped by every getPipe() that hands
    ///		this pipe out. Each instance of the chain binds to it on its
    ///		first touch and is ended by putPipe() (plan 4.1 rule 2);
    ///		0 = never handed out
    //-----------------------------------------------------------------
    uint64_t generation = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		The binding's caller context (plan 5.3): set by the opener
    ///		right after getPipe(), copied into each Python instance of
    ///		the chain when the binder constructs it, cleared by
    ///		putPipe(). A null handle means no caller (C++-driven work).
    ///		Never keyed, never indexed: a node reaches only its own
    //-----------------------------------------------------------------
    py::object caller;

    //-----------------------------------------------------------------
    /// @details
    ///		Emit one `>DBG` trace line for this binding, gated on
    ///		traceLevel >= METADATA. Fields, '*'-separated:
    ///		kind, pipeId, componentId, traceId, trace json. No engine-wide
    ///		pipe count: a holder of a shared engine must not learn it
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

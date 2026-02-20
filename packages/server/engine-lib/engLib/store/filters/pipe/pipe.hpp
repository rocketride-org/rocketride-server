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
    /// @details
    ///		Debugger support
    //-----------------------------------------------------------------
    Debugger debugger;
};
}  // namespace engine::store::filter::pipe

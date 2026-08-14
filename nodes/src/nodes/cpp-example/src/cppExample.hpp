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
//	The smallest useful C++ node: a data-lane filter that counts the tags of
//	each object passing through it and reports the total when the object
//	closes. Everything it receives is forwarded downstream unchanged, so it can
//	sit anywhere in a pipeline without altering the result.
//
//	It exists to demonstrate the shape of a C++ node rather than to do work:
//
//	Source Mode:
//		No source mode is needed
//
//	Target Mode:
//		open() resets the per-object counter, writeTag() counts and forwards,
//		close() reports. Nothing is written to the stream.
//
//	The two classes below are what every filter provides: IFilterGlobal holds
//	state shared by all instances of the node in a pipeline, IFilterInstance is
//	created once per pipe. Their Factory members are what initializeNode()
//	hands to the engine's registry - see node.cpp.
//
//-----------------------------------------------------------------------------
#pragma once

#include <engLib/eng.h>

namespace nodes::cppExample {
using namespace engine;
using namespace engine::store;

//-------------------------------------------------------------------------
/// @details
///		Declare our factory info. This must match the protocol declared in
///		services.cpp_example.json - a pipeline names a filter by its
///		protocol, and that is the name the factory is looked up under.
//-------------------------------------------------------------------------
_const auto Type = "cpp_example"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter. The example rides on ServicePipe so
///		that a single --trace=ServicePipe shows the node's own output
///		alongside the pipe lifecycle it is reacting to.
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServicePipe;

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
    // Public API
    //-----------------------------------------------------------------
    virtual Error open(Entry &entry) noexcept override;
    virtual Error writeTag(const TAG *pTag) noexcept override;
    virtual Error close() noexcept override;

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Tags seen since the current object was opened
    //-----------------------------------------------------------------
    size_t m_tagCount = 0;
};

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
};
}  // namespace nodes::cppExample

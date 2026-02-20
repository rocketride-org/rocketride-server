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
//	Declares the interface for nodes
//
//-----------------------------------------------------------------------------
#pragma once

//-----------------------------------------------------------------------------
// Include the interfaces we support
//-----------------------------------------------------------------------------
#include "../base/base.hpp"

namespace engine::store::filter::filesys::filesys {
using namespace engine::store::filter::filesys::base;

class IFilterEndpoint;
class IFilterGlobal;
class IFilterInstance;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceFilesys;

//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = IBaseEndpoint<Level>::Type;

//-------------------------------------------------------------------------
///	@details
///		This class defines the node interface to the file system
//-------------------------------------------------------------------------
class IFilterGlobal : public IBaseGlobal<Level> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to IFilterInstance
    //-----------------------------------------------------------------
    friend IFilterInstance;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterGlobal, Parent>(Type);
};

//-------------------------------------------------------------------------
///	@details
///		Filter class for handling file/smb I/O
//-------------------------------------------------------------------------
class IFilterInstance : public IBaseInstance<Level> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseInstance<Level>;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IFilterInstance(const FactoryArgs &args) noexcept : Parent(args) {}

    virtual ~IFilterInstance() {}
};

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
class IFilterEndpoint : public IBaseEndpoint<Level> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseEndpoint<Level>;
    using Parent::Parent;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterEndpoint, Parent>(Type);
};
}  // namespace engine::store::filter::filesys::filesys

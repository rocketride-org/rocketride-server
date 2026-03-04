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
//	Declares the object for working with Zip stream objects.
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::zip {
//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = "zip"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceZip;

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
class IFilterEndpoint : public IServiceEndpoint {
public:
    using Config = IServiceConfig;
    using Parent = IServiceEndpoint;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    explicit IFilterEndpoint(const FactoryArgs &args) noexcept
        : Parent(args) {};
    virtual ~IFilterEndpoint() {};

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterEndpoint, Parent>(Type);
};

class IFilterInstance;

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
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to
    ///		IFilterInstance
    //-----------------------------------------------------------------
    friend IFilterInstance;

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
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterGlobal() noexcept override;
    virtual Error endFilterGlobal() noexcept override;

private:
    //-----------------------------------------------------------------
    // Private API
    //-----------------------------------------------------------------

    //-----------------------------------------------------------------
    /// @details
    ///		Contains the Url from the service. This is common and
    ///		shared across all service instances
    //-----------------------------------------------------------------
    Url m_streamUrl;

    //-----------------------------------------------------------------
    /// @details
    ///		Pointer to the Data Stream used to transfer data
    //-----------------------------------------------------------------
    ErrorOr<StreamPtr> m_stream;
};

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
class IFilterInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IFilterInstance(const FactoryArgs &args) noexcept
        : Parent(args),
          endpoint((static_cast<IFilterEndpoint &>(*args.endpoint))),
          global((static_cast<IFilterGlobal &>(*args.global))) {};
    virtual ~IFilterInstance() {};

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
    // Private API
    //-----------------------------------------------------------------
    Error processStreamData(TAG_OBJECT_STREAM_DATA *pTag) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Returns Error for Zlib Error
    ///	@param[in]	error
    ///		Zlib error
    //-----------------------------------------------------------------
    Error zlibError(int error) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Reference to the bound pipe
    //-----------------------------------------------------------------
    IFilterGlobal &global;

    //-----------------------------------------------------------------
    /// @details
    ///		Reference to the bound endpoint
    //-----------------------------------------------------------------
    IFilterEndpoint &endpoint;

    //-----------------------------------------------------------------
    /// @details
    ///		Context info for our substream
    //-----------------------------------------------------------------
    void *m_pContext;

    //-----------------------------------------------------------------
    /// @details
    ///		Set when processing a stream
    //-----------------------------------------------------------------
    bool m_isPrimary = false;

    //-----------------------------------------------------------------
    /// @details
    ///		Contains the modified target path based on the
    ///		source path (generated by mapPath)
    //-----------------------------------------------------------------
    Url m_targetObjectUrl;
};

}  // namespace engine::store::filter::zip
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
//	Declares the object for working with Sharepoint
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::sharepoint {
using namespace utility;
using namespace web::http;
using namespace web::http::client;
using namespace engine::store::filter::msNode;
using namespace engine::store::filter::msNode::msSharepointNode;
//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = "ms-sharepointcpp"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceSharepoint;

class IFilterInstance;

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
    ///	    Allow the filter instance to see our private data. We can
    ///	    either make it public, or limit the scope to
    ///	    IFilterInstance
    ///     Generally, access to processPath is needed
    ///
    //-----------------------------------------------------------------
    friend IFilterInstance;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IFilterEndpoint(const FactoryArgs &args) noexcept : Parent(args) {};
    virtual ~IFilterEndpoint();

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterEndpoint, Parent>(Type);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginEndpoint(OPEN_MODE openMode) noexcept override;
    virtual Error setConfig(const json::Value &jobConfig,
                            const json::Value &taskConfig,
                            const json::Value &serviceConfig) noexcept override;
    virtual Error endEndpoint() noexcept override;
    std::shared_ptr<MsConfig> m_msConfig = std::make_shared<MsConfig>();
    virtual Error getConfigSubKey(Text &key) noexcept override;
    virtual Error scanObjects(Path &path,
                              const ScanAddObject &callback) noexcept override;
    // virtual Error commitScan() noexcept override;
    bool isSyncEndpoint() noexcept;
    ErrorOr<Text> getTargetSiteId(const Text &) noexcept;

private:
    //-----------------------------------------------------------------
    ///	@details
    ///		MsSharepointNode
    //-----------------------------------------------------------------
    std::shared_ptr<MsSharepointNode> m_msSharepointNode;

    ErrorOr<std::shared_ptr<MsSharepointNode>> createClient() noexcept;

    Text targetSiteId;
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
          global((static_cast<IFilterGlobal &>(*args.global))),
          m_uploadInParts(false),
          m_uploadSessionUrl(),
          m_targetObjectDataBuffer(),
          m_msSharepointNode(),
          body() {};
    virtual ~IFilterInstance() {};

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;
    virtual Error removeObject(Entry &object) noexcept override;
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;
    virtual ErrorOr<bool> stat(Entry &object) noexcept override;
    //-----------------------------------------------------------------
    /// @details
    ///		Public functions used for store
    //-----------------------------------------------------------------
    virtual Error open(Entry &entry) noexcept override;
    virtual Error writeTag(const TAG *pTag) noexcept override;
    virtual Error close() noexcept override;

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used for store
    //-----------------------------------------------------------------
    Error processObjectStreamData(const TAG_OBJECT_STREAM_DATA *pTag) noexcept;

    //-----------------------------------------------------------------
    // @details
    //      Implementation function used to render the object
    //-----------------------------------------------------------------
    Error renderStandardFile(ServicePipe &target, Entry &object) noexcept;
    Error sendTagBeginStream(ServicePipe &target, TAG *pTagBuffer,
                             Entry &object) noexcept;
    Error sendTagMetadata(ServicePipe &target, Entry &object) noexcept;
    Error sendTagEndStream(ServicePipe &target) noexcept override;

    Error isObjectUpdateNeeded() noexcept;
    Error processMetadata() noexcept;
    //-----------------------------------------------------------------
    // @details
    //      Update client and extract path
    //-----------------------------------------------------------------
    ErrorOr<Path> processPath(const Entry &object) noexcept {
        Path path;
        if (auto ccode = Url::toPath(object.url(), path)) return ccode;
        return {};
    }

private:
    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IFilterGlobal &global;

    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IFilterEndpoint &endpoint;

    //-----------------------------------------------------------------
    // upload in parts
    //-----------------------------------------------------------------
    bool m_uploadInParts = false;

    //-----------------------------------------------------------------
    ///	@details
    ///		Default size of the single part at multipart upload
    ///     Maximum single size can be 60_MiB
    ///     But as per another document,
    ///     https://learn.microsoft.com/en-us/graph/onenote-images-files#size-limitations-for-post-pages-requests
    ///     The Microsoft Graph REST API has a 4 MB request limit. Anything
    ///     above this will fail with the error message "request too large
    ///     (413)".
    //-----------------------------------------------------------------
    _const auto SharePointDefaultPartSize = 4_mb;

    //-----------------------------------------------------------------
    ///	@details
    ///		Multipart upload session url
    //-----------------------------------------------------------------
    Text m_uploadSessionUrl;

    //-----------------------------------------------------------------
    ///	@details
    ///		MsSharepointNode
    //-----------------------------------------------------------------
    std::shared_ptr<MsSharepointNode> m_msSharepointNode;

    //-----------------------------------------------------------------
    /// @details
    ///     Part data of the current target object to upload.
    //-----------------------------------------------------------------
    std::vector<unsigned char> body;

    memory::Data<Byte> m_targetObjectDataBuffer;

    // Private functions
    Error uploadWithSession() noexcept;
    Error uploadWithoutSession() noexcept;
    Error getClient() noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///     Flag that indicates if the object should be updated
    //-----------------------------------------------------------------
    bool m_updateObject = false;
};
}  // namespace engine::store::filter::sharepoint

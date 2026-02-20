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
//	Declares the object for working with MS Email
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::outlook {
using namespace utility;
using namespace web::http;
using namespace web::http::client;
using namespace engine::store::filter::msNode;
using namespace engine::store::filter::msNode::msEmailNode;
using namespace engine::store::filter::msNode::msEmailContainer;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceOutlook;

//-------------------------------------------------------------------------
/// @details
///		Define the Outlook path processing type
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(PATH_PROCESSING_TYPE, 0, 3, NONE = _begin, CONTAINER_ONLY,
                   ACCOUNT_AND_CONTAINER);

class IFilterInstance;

struct FoldersMap {
    Text m_userName;
    std::unordered_map<Text, Text> m_folders;
};

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
    IFilterEndpoint(const FactoryArgs& args) noexcept
        : Parent(args) {

          };
    virtual ~IFilterEndpoint();

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto FactoryEnterprise =
        Factory::makeFactory<IFilterEndpoint, Parent>(TypeEnterprise);
    _const auto FactoryPersonal =
        Factory::makeFactory<IFilterEndpoint, Parent>(TypePersonal);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginEndpoint(OPEN_MODE openMode) noexcept override;
    virtual Error validateConfig(bool syntaxOnly) noexcept override;
    virtual Error getConfigSubKey(Text& key) noexcept override;
    virtual Error setConfig(const json::Value& jobConfig,
                            const json::Value& taskConfig,
                            const json::Value& serviceConfig) noexcept override;
    virtual Error scanObjects(Path& path,
                              const ScanAddObject& callback) noexcept override;

    bool isSyncEndpoint() noexcept;
    virtual Error endEndpoint() noexcept override;
    std::mutex& getPathLock() noexcept;
    FoldersMap& getFolderMap() noexcept;

private:
    //-----------------------------------------------------------------
    /// Update client and return path info
    //-----------------------------------------------------------------
    ErrorOr<Path> processPath(PATH_PROCESSING_TYPE type,
                              const Path& path) noexcept {
        return path.subpth(_cast<uint32_t>(type));
    }

    //-----------------------------------------------------------------
    /// Process specific entry object
    //-----------------------------------------------------------------
    template <class T>
    Error processEntry(const T& blob, Entry& object,
                       const ScanAddObject& addObject) noexcept;

    //-----------------------------------------------------------------
    /// check permissions for outlook
    //-----------------------------------------------------------------
    Error checkOutlookPermissions() noexcept;
    //-----------------------------------------------------------------
    /// @details
    ///		Parsed configuration
    //-----------------------------------------------------------------
    std::shared_ptr<MsConfig> m_msConfig = std::make_shared<MsConfig>();

    //-----------------------------------------------------------------
    ///	@details
    ///		MsSharepointNode
    //-----------------------------------------------------------------
    std::shared_ptr<MsEmailNode> m_msEmailNode;

    ErrorOr<std::shared_ptr<MsEmailNode>> createClient(
        IFilterEndpoint* parent) noexcept;
    // folderMap
    FoldersMap m_folders;

    //-----------------------------------------------------------------
    /// @details
    ///     lock to get folder path cache
    //-----------------------------------------------------------------
    std::mutex m_pathLock;
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
    _const auto FactoryEnterprise =
        Factory::makeFactory<IFilterGlobal, Parent>(TypeEnterprise);
    _const auto FactoryPersonal =
        Factory::makeFactory<IFilterGlobal, Parent>(TypePersonal);
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
    IFilterInstance(const FactoryArgs& args) noexcept
        : Parent(args),
          endpoint((static_cast<IFilterEndpoint&>(*args.endpoint))),
          global((static_cast<IFilterGlobal&>(*args.global))) {};
    virtual ~IFilterInstance() {};

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto FactoryEnterprise =
        Factory::makeFactory<IFilterInstance, Parent>(TypeEnterprise);
    _const auto FactoryPersonal =
        Factory::makeFactory<IFilterInstance, Parent>(TypePersonal);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;
    virtual Error renderObject(ServicePipe& target,
                               Entry& object) noexcept override;
    virtual Error checkChanged(Entry& object) noexcept override;
    virtual ErrorOr<bool> stat(Entry& object) noexcept override;
    virtual Error prepareObject(Entry& entry) noexcept override;

    //-------------------------------------------------------------
    // Public function - Permissions support
    //-------------------------------------------------------------
    virtual Error getPermissions(Entry& entry) noexcept override;
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept override;
    Error mapId(TextView idStr, std::unordered_set<Text>& mappedIds) noexcept;

    Error getData(Entry& entry) noexcept;
    // No deletion supported for emails
    virtual Error removeObject(Entry& object) noexcept override {
        auto ccode =
            MONERR(warning, Ec::Warning, "Deletion not supported on emails");
        // mark object as failed
        object.completionCode.set(ccode);
        // task did not fail
        return {};
    }

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used for store
    //-----------------------------------------------------------------
    Error processObjectStreamData(const TAG_OBJECT_STREAM_DATA* pTag) noexcept;

    //-----------------------------------------------------------------
    // @details
    //      Implementation function used to render the object
    //-----------------------------------------------------------------
    Error renderStandardFile(ServicePipe& target, Entry& object) noexcept;
    Error sendTagBeginStream(ServicePipe& target, TAG* pTagBuffer,
                             Entry& object) noexcept;
    Error sendTagMetadata(ServicePipe& target, Entry& object) noexcept;
    Error sendTagEndStream(ServicePipe& target) noexcept override;

    //-----------------------------------------------------------------
    // @details
    //      Update client and extract path
    //-----------------------------------------------------------------
    ErrorOr<Path> processPath(const Entry& object) noexcept {
        Path path;
        if (auto ccode = Url::toPath(object.url(), path)) return ccode;
        return endpoint.processPath(PATH_PROCESSING_TYPE::ACCOUNT_AND_CONTAINER,
                                    path);
    }

private:
    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IFilterGlobal& global;

    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IFilterEndpoint& endpoint;

    //-----------------------------------------------------------------
    ///	@details
    ///		MsSharepointNode
    //-----------------------------------------------------------------
    std::shared_ptr<MsEmailNode> m_msEmailNode;
    Error getClient() noexcept;
    std::vector<unsigned char> m_data;
};

// helper function
time_t convertFromAzureDateTime(const utility::datetime& dt) noexcept;
}  // namespace engine::store::filter::outlook

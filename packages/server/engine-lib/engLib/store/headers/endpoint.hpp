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

#pragma once

namespace engine::task {
class IPipeTaskBase;
}

namespace engine::store {
//-------------------------------------------------------------------------
/// Declare our types
//-------------------------------------------------------------------------
namespace py = pybind11;
using ScanPaths = std::function<Error(std::vector<Path> &)>;
using ScanAddObject = std::function<Error(Entry &)>;
using IDict = engine::python::IDict;

struct ENDPOINT_PARAM {
    Opt<Ref<const json::Value>> jobConfig;
    Opt<Ref<const json::Value>> taskConfig;
    Opt<Ref<const json::Value>> serviceConfig;
    ENDPOINT_MODE endpointMode = ENDPOINT_MODE::NONE;
    OPEN_MODE openMode = OPEN_MODE::NONE;
    bool stackOnly = false;
    bool debug = false;
};

//-------------------------------------------------------------------------
/// @details
///		Define the return value IPipeFilters from the
///     endpoint.beginEndpoint. Note that it can return an array of filters
///     where each filter is either a string or a dict type object.
///     If it is a string, IPipeType names will be set to that string and
///     connConfig will be {}
//-------------------------------------------------------------------------
using IPipeFilterType = std::variant<Text, json::Value>;
using IPipeFilters = std::vector<IPipeFilterType>;

//-------------------------------------------------------------------------
/// @details
///		Define the pipe stack we build
//-------------------------------------------------------------------------
struct IPipeType {
    Text id;
    Text logicalType;
    Text physicalType;
    uint32_t capabilities = 0;
    json::Value connConfig = json::Value();

    // Default constructor
    IPipeType() {}

    // Constructor for three parameters
    IPipeType(const Text &identifier, const Text &logical, const Text &physical)
        : id(identifier), logicalType(logical), physicalType(physical) {}

    // Constructor for four parameters
    IPipeType(const Text &identifier, const uint32_t capabilities,
              const Text &logical, const Text &physical, json::Value &config)
        : id(identifier),
          capabilities(capabilities),
          logicalType(logical),
          physicalType(physical),
          connConfig(config) {}
};

using IPipeStack = std::vector<IPipeType>;
using IPipeConnections = std::vector<json::Value>;

//-------------------------------------------------------------------------
/// @details
///		Define the service endpoint
//-------------------------------------------------------------------------
class IServiceEndpoint {
public:
    //-----------------------------------------------------------------
    // Explicitly delete the default constructor
    //-----------------------------------------------------------------
    IServiceEndpoint() = delete;

    //-----------------------------------------------------------------
    // Delete copy constructor and copy assignment operator. If you
    // get compile errors, you need to figure out why you are copying
    //-----------------------------------------------------------------
    IServiceEndpoint(const IServiceEndpoint &) = delete;
    IServiceEndpoint &operator=(const IServiceEndpoint &) = delete;

    //-----------------------------------------------------------------
    // Delete move constructor and move assignment operator. If you
    // get compile errors, you need to figure out why you are moving
    //-----------------------------------------------------------------
    IServiceEndpoint(IServiceEndpoint &&) = delete;
    IServiceEndpoint &operator=(IServiceEndpoint &&) = delete;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::ServiceEndpoint;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory type
    //-----------------------------------------------------------------
    _const auto FactoryType = "iEndpoint";

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "[E]";
    }
    //-----------------------------------------------------------------
    /// @details
    ///		Factory args
    //-----------------------------------------------------------------
    struct FactoryArgs {
        IPipeType filter;
        uint32_t flags = 0;
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Static factory hook to create the appropriate type
    //-----------------------------------------------------------------
    static ErrorOr<ServiceEndpointPtr> __factory(Location location,
                                                 uint32_t requiredFlags,
                                                 FactoryArgs args) noexcept {
        return Factory::find<IServiceEndpoint>(location, requiredFlags,
                                               args.filter.physicalType, args);
    }

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    virtual ~IServiceEndpoint();
    explicit IServiceEndpoint(const FactoryArgs &args) noexcept
        : pipeType(args.filter) {
        LOGPIPE();
    };

    //-----------------------------------------------------------------
    // Public functions - these are callbacks into the task
    //-----------------------------------------------------------------
    virtual Error taskWriteText(const Text &text) noexcept;
    virtual Error taskWriteWarning(const Entry &entry,
                                   const Error &ccode) noexcept;

    //-----------------------------------------------------------------
    // Public functions
    //-----------------------------------------------------------------
    virtual Error beginEndpoint(OPEN_MODE openMode) noexcept;
    virtual Error signal(const Text &signal, json::Value &param) noexcept;
    virtual Error getConfigSubKey(Text &key) noexcept;
    virtual Error getConfig(json::Value &serviceConfig) noexcept;
    virtual Error mapPath(const Url &sourceUrl, Url &targetUrl) noexcept;
    virtual Error endEndpoint() noexcept;

    //-----------------------------------------------------------------
    // Public functions - configurations support
    //-----------------------------------------------------------------
    virtual Error validateConfig(bool syntaxOnly) noexcept;

    //-----------------------------------------------------------------
    // Public functions - pipe support
    //-----------------------------------------------------------------
    virtual int getPipeCount() noexcept;
    virtual ErrorOr<ServicePipe> getPipe() noexcept;
    virtual Error putPipe(ServicePipe &pipe) noexcept;

    //-----------------------------------------------------------------
    // Public functions - Statics to get a specified type and
    // allocate a new endpoint
    //-----------------------------------------------------------------
    static ErrorOr<Text> getLogicalType(
        const json::Value &serviceConfig) noexcept;
    static ErrorOr<Text> getPhysicalType(
        const json::Value &serviceConfig) noexcept;
    static ErrorOr<ServiceEndpoint> getEndpoint(ENDPOINT_MODE endpointMode,
                                                ENDPOINT_PARAM &param) noexcept;
    static ErrorOr<ServiceEndpoint> getSourceEndpoint(
        ENDPOINT_PARAM &&param) noexcept;
    static ErrorOr<ServiceEndpoint> getTargetEndpoint(
        ENDPOINT_PARAM &&param) noexcept;

    //-----------------------------------------------------------------
    // Public functions - Object/container scanner - may be
    // implemented if endpoint can act as a source
    //-----------------------------------------------------------------
    virtual Error scanObjects(Path &path,
                              const ScanAddObject &callback) noexcept;
    virtual Error commitScan() noexcept;
    virtual Error resetScan() noexcept;

    //-----------------------------------------------------------------
    // Public but private use APIs - used to configure and bind the
    // pipestack and task
    //-----------------------------------------------------------------
    virtual Error bindTask(task::IPipeTaskBase *pTask) noexcept;
    virtual Error getPipeFilters(IPipeFilters &filters) noexcept;
    virtual size_t getNumberFilters() noexcept { return m_numberFilters; }
    virtual Error insertFilter(const Text &filterName,
                               const json::Value &filterConfig);

    //-----------------------------------------------------------------
    // Public functions - Sync Tokens support
    //-----------------------------------------------------------------
    bool isSyncEndpoint() noexcept;
    ErrorOr<SYNC_SCAN_STATE> getSyncState() noexcept;
    Error setSyncState(SYNC_SCAN_STATE state) noexcept;
    Error beginSyncScan(TextView configurationToken) noexcept;
    Error endSyncScan() noexcept;
    ErrorOr<Text> getSyncToken(TextView key) noexcept;
    Error setSyncToken(TextView key, TextView value) noexcept;
    Error isKeyStoreInitialized() const noexcept;
    keystore::KeyStorePtr getKeyStore() const noexcept { return m_keyStore; }
    bool isPipeline() const noexcept { return m_isPipeline; }

    //-------------------------------------------------------------
    // Public function - Permissions support
    //-------------------------------------------------------------
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept;

    //-----------------------------------------------------------------
    // Our global stack an vector of instance stacks
    //-----------------------------------------------------------------
    ServiceGlobalStack m_globalStack;
    ServiceInstanceStacks m_instanceStacks;

    mutable async::Mutex m_stackLock;
    mutable async::Mutex m_pipeCreateLock;

    //-----------------------------------------------------------------
    // These are valid to be called during beginFilterGlobal and
    // can insert a filters into the pipe stack as it is being
    // initialized
    //-----------------------------------------------------------------
    ptrdiff_t pipeStackIndex = -1;

    //-----------------------------------------------------------------
    /// @details
    ///		The pipe stack we built
    //-----------------------------------------------------------------
    IPipeStack pipeStack;

    //-----------------------------------------------------------------
    /// @details
    ///		This is our connection table of what we need to connect
    //-----------------------------------------------------------------
    std::vector<std::tuple<int, int, std::string>> connections;

    //-----------------------------------------------------------------
    /// @details
    ///		This is our control/invoke table of what we need to connect
    //		for the control/invoke function
    //-----------------------------------------------------------------
    std::vector<std::tuple<int, int, std::string>> controls;

    //-----------------------------------------------------------------
    /// @details
    ///		Our parsed configuration
    //-----------------------------------------------------------------
    IServiceConfig config;

    //-----------------------------------------------------------------
    /// @details
    ///		Our configuration bag passed to/from all filters
    //-----------------------------------------------------------------
    IDict bag;

    //-----------------------------------------------------------------
    /// @details
    ///		Has the logical and physical name of the pipes
    //-----------------------------------------------------------------
    IPipeType pipeType;

    //-----------------------------------------------------------------
    /// @details
    ///		Information about permissions.
    //-----------------------------------------------------------------
    ServiceEndpointWeak endpoint;

    //-----------------------------------------------------------------
    /// @details
    ///		Save the target endpoint - only set by pipeline tasks
    //-----------------------------------------------------------------
    ServiceEndpoint target;

    //-----------------------------------------------------------------
    /// @details
    ///		Information about permissions.
    //-----------------------------------------------------------------
    perms::PermissionInformation permissionInfo;

    //-----------------------------------------------------------------
    /// @details
    ///		These functions are used for selections during a scan
    ///     only applicable on a source endpoint
    //-----------------------------------------------------------------
    ErrorOr<std::vector<Path>> initSelections() noexcept;
    Error deinitSelections() noexcept;
    bool isExcludedByFileName(const Path &path) noexcept;
    bool isIncluded(const Path &path, uint32_t &flags) noexcept;
    uint32_t getSelectionsHash() const noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Capabilities flags of this endpoint
    //-----------------------------------------------------------------
    uint32_t capabilities = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Ptr to the selection info (for scan operations)
    //-----------------------------------------------------------------
    file::Selections *m_pSelections = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		Has the taskId associated with this endpoint
    //-----------------------------------------------------------------
    std::string taskId = "";

    //-----------------------------------------------------------------
    // The debugger for this endpoint
    //-----------------------------------------------------------------
    Debugger debugger;

private:
    Error bindFilters(size_t pipeId, ServiceInstanceStack &filters) noexcept;
    Error buildGlobalPipe() noexcept;
    Error buildBreakpoints() noexcept;
    Error buildPipeStack() noexcept;
    Error buildConnections() noexcept;
    Error generatePipelineStack() noexcept;
    ErrorOr<ServicePipe> buildInstancePipe() noexcept;

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		If the pipeline data has the connections member, then we
    ///     use it to build the IEndpoint->connections table so we know
    ///     what to connect, this will be true. If there is no connection
    ///     table, this will be set to false and we will setup all the
    ///     drivers with all the lanes
    //-----------------------------------------------------------------
    bool m_isPipeline = false;

    //-----------------------------------------------------------------
    /// @details
    ///		Sets up the endpoint configuration after construction. Note
    ///		that the endpoint is not opened, nor has it begun yet. It
    ///		is the endpoints opportunity to examine/change any config
    ///		information needed
    //-----------------------------------------------------------------
    virtual Error setConfig(const json::Value &jobConfig,
                            const json::Value &taskConfig,
                            const json::Value &serviceConfig) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Opens keystore
    //-----------------------------------------------------------------
    virtual Error openKeyValueStorage() noexcept;

    //-----------------------------------------------------------------
    // If we are only supposed to build the stack, not actually begin it
    //-----------------------------------------------------------------
    bool m_stackOnly = false;

    //-----------------------------------------------------------------
    /// @details
    ///		Set by the build pipe stack - contains the number of
    ///		filters in the stack
    //-----------------------------------------------------------------
    size_t m_numberFilters = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Point to the controlling job so we an interact with it
    ///		if needed
    //-----------------------------------------------------------------
    task::IPipeTaskBase *m_task = nullptr;

    //-------------------------------------------------------------
    /// @details
    ///		Common key-value storage for the endpoint
    ///		and the pipe filters
    //-------------------------------------------------------------
    keystore::KeyStorePtr m_keyStore;
};
}  // namespace engine::store

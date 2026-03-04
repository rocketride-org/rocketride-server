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
//	The class definition for Windows file system node
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::pythonBase {
namespace py = pybind11;
using namespace pybind11::literals;

class IPythonGlobalBase;
class IPythonInstanceBase;

//-------------------------------------------------------------------------
/// @details
///		Defines flags for optional API pipe methods, indicating whether
///     the method is implemented by the underlying python node or not
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM_BITMASK(
    PythonInstanceMethod, 0, 24, None = 0,

    BeginInstance = BIT(0), EndInstance = BIT(1),

    CheckChanged = BIT(2), Control = BIT(3), Open = BIT(4), Closing = BIT(5),
    Close = BIT(6),

    WriteTag = BIT(7), WriteText = BIT(8), WriteTable = BIT(9),
    WriteWords = BIT(10), WriteAudio = BIT(11), WriteVideo = BIT(12),
    WriteImage = BIT(13), WriteQuestions = BIT(14), WriteAnswers = BIT(15),
    WriteClassifications = BIT(16), WriteClassificationContext = BIT(17),
    WriteDocuments = BIT(18),

    GetPermissions = BIT(19), OutputPermissions = BIT(20),
    GetPermissionsBulk = BIT(21), GetThreadCount = BIT(22));

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
class IPythonEndpointBase : public IServiceEndpoint {
public:
    using Config = IServiceConfig;
    using Parent = IServiceEndpoint;
    using Parent::Parent;

    friend IPythonGlobalBase;
    friend IPythonInstanceBase;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Python;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IPythonEndpointBase(const FactoryArgs &args) noexcept;
    virtual ~IPythonEndpointBase() noexcept;

    //-----------------------------------------------------------------
    // Public API	: python-endpoint.cpp
    //		Controls starting/stopping the endpoint
    //-----------------------------------------------------------------
    virtual Error beginEndpoint(OPEN_MODE openMode) noexcept override;
    virtual Error signal(const Text &signal,
                         json::Value &param) noexcept override;
    virtual Error endEndpoint() noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-endpoint.config.cpp
    //		Configuration and validation
    //-----------------------------------------------------------------
    virtual Error getConfigSubKey(Text &key) noexcept override;
    virtual Error validateConfig(bool syntaxOnly) noexcept override;
    virtual Error getPipeFilters(IPipeFilters &filters) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-endpoint.source.cpp
    // 		Source endpoint support
    //-----------------------------------------------------------------
    virtual Error scanObjects(Path &path,
                              const ScanAddObject &callback) noexcept override;

private:
    //-------------------------------------------------------------
    /// @details
    ///		Handle to our module object
    //-------------------------------------------------------------
    py::object m_pyModule;

    //-------------------------------------------------------------
    /// @details
    ///		Handle to our python IEndpoint object
    //-------------------------------------------------------------
    py::object m_pyEndpoint;

    //-------------------------------------------------------------
    /// @details
    ///        The result of binding python objects to handles.
    //-------------------------------------------------------------
    Error m_boundError;
};

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter
//-------------------------------------------------------------------------
class IPythonGlobalBase : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Python;

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to
    ///		IPythonInstanceBase
    //-----------------------------------------------------------------
    friend IPythonInstanceBase;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IPythonGlobalBase(const FactoryArgs &args) noexcept;
    virtual ~IPythonGlobalBase() noexcept;

    //-----------------------------------------------------------------
    // Public API	: python-global.cpp
    //-----------------------------------------------------------------
    virtual Error beginFilterGlobal() noexcept override;
    virtual Error endFilterGlobal() noexcept override;

    virtual Error validateConfig() noexcept override;

private:
    //-------------------------------------------------------------
    /// @details
    ///		Handle to our module object
    //-------------------------------------------------------------
    py::object m_pyModule;

    //-------------------------------------------------------------
    /// @details
    ///		Handle to our python IEndpoint object
    //-------------------------------------------------------------
    py::object m_pyEndpoint;

    //-------------------------------------------------------------
    /// @details
    ///		Handle to our python IGlobal object
    //-------------------------------------------------------------
    py::object m_pyGlobal;

    //-------------------------------------------------------------
    /// @details
    ///        The result of binding python objects to handles.
    //-------------------------------------------------------------
    Error m_boundError;
};

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
class IPythonInstanceBase : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;
    using PythonMethod = PythonInstanceMethod;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Python;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IPythonInstanceBase(const FactoryArgs &args) noexcept;
    virtual ~IPythonInstanceBase();

    //-----------------------------------------------------------------
    // Public API	: python-instance.cpp
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override;
    virtual Error endFilterInstance() noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.source.cpp
    //		Source mode support
    //-----------------------------------------------------------------
    virtual uint32_t getThreadCount(
        uint32_t currentThreadCount) const noexcept override;
    virtual ErrorOr<bool> stat(Entry &entry) noexcept override;
    virtual Error checkChanged(Entry &object) noexcept override;
    virtual Error removeObject(Entry &object) noexcept override;
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;

    //----------------------------------------------------------------
    // Public API	: python-instance.permissions.cpp
    //		Permissions support
    //-----------------------------------------------------------------
    virtual Error getPermissions(Entry &entry) noexcept override;
    virtual ErrorOr<size_t> getPermissions(
        std::vector<Entry> &entries) noexcept override;
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.target.cpp
    //		Supports target mode open/close
    //-----------------------------------------------------------------
    virtual Error control(py::object &control) noexcept override;
    virtual Error open(Entry &object) noexcept override;
    virtual Error closing() noexcept override;
    virtual Error close() noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.data.cpp
    //		Supports tag/data lanes
    //-----------------------------------------------------------------
    virtual Error writeTag(const TAG *pTag) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.text.cpp
    //		Supports text lane
    //-----------------------------------------------------------------
    virtual Error writeText(const Utf16View &text) noexcept override;
    virtual Error writeTable(const Utf16View &text) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.words.cpp
    //		Supports word lane
    //-----------------------------------------------------------------
    virtual Error writeWords(const WordVector &textWords) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.avi.cpp
    //		Supports avi lanes
    //-----------------------------------------------------------------
    virtual Error writeAudio(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override;
    virtual Error writeVideo(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override;
    virtual Error writeImage(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.classification.cpp
    //		Supports the classification lane
    //-----------------------------------------------------------------
    virtual Error writeClassifications(
        const json::Value &classifications,
        const json::Value &classificationPolicy,
        const json::Value &classificationRules) noexcept override;
    virtual Error writeClassificationContext(
        const json::Value &classifications) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.question.cpp
    //		Supports the question/answer lane
    //-----------------------------------------------------------------
    virtual Error writeQuestions(
        const pybind11::object &question) noexcept override;
    virtual Error writeAnswers(
        const pybind11::object &answers) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: python-instance.documents.cpp
    //		Supports documents lane
    //-----------------------------------------------------------------
    virtual Error writeDocuments(
        const pybind11::object &documents) noexcept override;

    //-----------------------------------------------------------------
    // Public API	: Utilities
    //-----------------------------------------------------------------
    py::object getPythonInstance() const noexcept { return m_pyInstance; }
    const Url &getTargetObjectUrl() const noexcept { return m_targetObjectUrl; }
    const Text &getTargetObjectPath() const noexcept {
        return m_targetObjectPath;
    }

private:
    //-------------------------------------------------------------
    // Reference to the bound global
    //-------------------------------------------------------------
    IPythonGlobalBase &m_global;

    //-------------------------------------------------------------
    // Reference to the bound pipe
    //-------------------------------------------------------------
    IPythonEndpointBase &m_endpoint;

    //-------------------------------------------------------------
    /// @details
    ///		Handle to our python IInstance object
    //-------------------------------------------------------------
    py::object m_pyInstance;

    //-------------------------------------------------------------
    /// @details
    ///		The list of the optional methods that the driver have.
    //-------------------------------------------------------------
    PythonMethod m_pyMethods{};

    //-------------------------------------------------------------
    /// @details
    ///		Path to current target object to upload.
    //-------------------------------------------------------------
    Text m_targetObjectPath;

    //-------------------------------------------------------------
    /// @details
    ///        The result of binding python objects to handles.
    //-------------------------------------------------------------
    Error m_boundError;
};
}  // namespace engine::store::pythonBase

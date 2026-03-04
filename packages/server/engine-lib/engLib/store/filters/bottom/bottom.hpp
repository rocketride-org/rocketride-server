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
//	The bottom filter driver is exactly that - the bottom of the pipe
//	stack. It doesn't do much except stop the forwarding of requests
//	on down the chain, since it is the bottom of the chain.
//
//	Some member functions specifically return errors if they are
//	reached due to the fact that they should never reach the bottom
//	of the stack. Others, like open, return {} because it is normal
//	and required that every driver calls Parent::open to pass the
//	call on to the next level.
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::bottom {
class IFilterGlobal;

//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = "bottom"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceBottom;

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
    // Common operations
    //-----------------------------------------------------------------
    virtual Error beginFilterInstance() noexcept override { return {}; }
    virtual Error endFilterInstance() noexcept override { return {}; }
    virtual Error ioControl(IOCTRL *pCommand) noexcept override { return {}; }

    //-----------------------------------------------------------------
    /// Source interface
    ///		Not the alternate forms of sendTag*. These should have
    ///		picked up by upper layers and converted over to sendTag
    //-----------------------------------------------------------------
    virtual uint32_t getThreadCount(
        uint32_t currentThreadCount) const noexcept override {
        return currentThreadCount;  // by default, use the current thread count
    }
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override {
        return {};
    }
    virtual Error checkChanged(Entry &object) noexcept override { return {}; }
    virtual Error getPermissions(Entry &entry) noexcept override { return {}; }
    virtual ErrorOr<size_t> getPermissions(
        std::vector<Entry> &entries) noexcept override {
        return APERR(Ec::NotSupported,
                     "not implemented");  // by default, bulk permissions are
                                          // not supported
    }
    virtual Error prepareObject(Entry &entry) noexcept override { return {}; }
    virtual Error checkPermissions(Entry &object) noexcept override {
        return {};
    }
    virtual ErrorOr<size_t> checkPermissions(
        std::vector<Entry> &objects) noexcept override {
        return APERR(Ec::NotSupported,
                     "not implemented");  // by default, bulk permissions are
                                          // not supported
    }
    virtual ErrorOr<bool> stat(Entry &entry) noexcept override {
        return filterError("stat"_tv);
    }
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept override {
        return {};
    }

    virtual Error sendOpen(ServicePipe &target,
                           Entry &object) noexcept override {
        return target->open(object);
    }
    virtual Error sendTag(ServicePipe &target,
                          const TAG *pTag) noexcept override {
        return target->writeTag(pTag);
    }
    virtual Error sendTagMetadata(ServicePipe &target,
                                  json::Value &metadata) noexcept override {
        return filterError("sendTagMetadata"_tv);
    }
    virtual Error sendTagBeginObject(ServicePipe &target) noexcept override {
        return filterError("sendTagBeginObject"_tv);
    }
    virtual Error sendTagBeginStream(ServicePipe &target) noexcept override {
        return filterError("sendTagBeginStream"_tv);
    }
    virtual Error sendTagData(ServicePipe &target, size_t size,
                              const void *pData) noexcept override {
        return filterError("sendTagData"_tv);
    }
    virtual Error sendTagEndStream(ServicePipe &target) noexcept override {
        return filterError("sendTagEndStream"_tv);
    }
    virtual Error sendTagEndObject(ServicePipe &target,
                                   Error completionCode) noexcept override {
        return filterError("sendTagEndObject"_tv);
    }
    virtual Error sendText(ServicePipe &target,
                           const Utf16View &text) noexcept override {
        return target->writeText(text);
    }
    virtual Error sendTable(ServicePipe &target,
                            const Utf16View &text) noexcept override {
        return target->writeTable(text);
    }
    virtual Error sendAudio(
        ServicePipe &target, const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override {
        return target->writeAudio(action, mimeType, streamData);
    }
    virtual Error sendVideo(
        ServicePipe &target, const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override {
        return target->writeVideo(action, mimeType, streamData);
    }
    virtual Error sendImage(
        ServicePipe &target, const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override {
        return target->writeImage(action, mimeType, streamData);
    }
    virtual Error sendQuestions(
        ServicePipe &target,
        const pybind11::object &question) noexcept override {
        return target->writeQuestions(question);
    }
    virtual Error sendAnswers(
        ServicePipe &target,
        const pybind11::object &answers) noexcept override {
        return target->writeAnswers(answers);
    }
    virtual Error sendClassifications(
        ServicePipe &target, const json::Value &classifications,
        const json::Value &classificationPolicy,
        const json::Value &classificationRules) noexcept override {
        return target->writeClassifications(
            classifications, classificationPolicy, classificationRules);
    }
    virtual Error sendClassificationContext(
        ServicePipe &target,
        const json::Value &classifications) noexcept override {
        return target->writeClassificationContext(classifications);
    }
    virtual Error sendDocuments(
        ServicePipe &target,
        const pybind11::object &documents) noexcept override {
        return target->writeDocuments(documents);
    }
    virtual Error sendClose(ServicePipe &target) noexcept override {
        return target->close();
    }

    //-----------------------------------------------------------------
    // Target interface
    //-----------------------------------------------------------------
    virtual Error control(py::object &control) noexcept override { return {}; }
    virtual Error open(Entry &entry) noexcept override { return {}; }
    virtual Error writeTag(const TAG *pTag) noexcept override { return {}; }
    virtual Error writeText(const Utf16View &text) noexcept override {
        return {};
    }
    virtual Error writeTable(const Utf16View &text) noexcept override {
        return {};
    }
    virtual Error writeWords(const WordVector &textWords) noexcept override {
        return {};
    }
    virtual Error writeAudio(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override {
        return {};
    }
    virtual Error writeVideo(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override {
        return {};
    }
    virtual Error writeImage(
        const AVI_ACTION action, Text &mimeType,
        const pybind11::bytes &streamData) noexcept override {
        return {};
    }
    virtual Error writeQuestions(
        const pybind11::object &question) noexcept override {
        return {};
    }
    virtual Error writeAnswers(
        const pybind11::object &answers) noexcept override {
        return {};
    }
    virtual Error writeDocuments(
        const pybind11::object &documents) noexcept override {
        return {};
    }
    virtual Error writeClassifications(
        const json::Value &classifications,
        const json::Value &classificationPolicy,
        const json::Value &classificationRules) noexcept override {
        return {};
    }
    virtual Error writeClassificationContext(
        const json::Value &classifications) noexcept override {
        return {};
    }
    virtual Error closing() noexcept override { return {}; }
    virtual Error close() noexcept override { return {}; }
    virtual Error removeObject(Entry &object) noexcept override {
        return filterError("removing objects"_tv);
    }

    //-----------------------------------------------------------------
    // Target lanes
    //-----------------------------------------------------------------
private:
    virtual Error filterError(TextView message) noexcept {
        return APERRT(Ec::InvalidCommand, "The", endpoint->config.protocol,
                      "service does not support", message);
    }
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
}  // namespace engine::store::filter::bottom

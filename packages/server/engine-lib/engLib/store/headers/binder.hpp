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

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Define the things we are using
//-------------------------------------------------------------------------
using WordVector = std::vector<StackText>;
using MemberMethods = std::vector<IServiceFilterInstance *>;

class Binder {
private:
    //-----------------------------------------------------------------
    ///	@details
    ///		Define a mapping from a method name to its dispatch table
    //-----------------------------------------------------------------
    typedef struct MethodMap {
        const char *methodName;
        std::unique_ptr<MemberMethods> &dispatch;
    } MethodMap;

    //-----------------------------------------------------------------
    ///	@details
    ///		Ptr to our parent instance
    //-----------------------------------------------------------------
    IServiceFilterInstance *m_pInstance = nullptr;

    //-----------------------------------------------------------------
    ///	@details
    ///		Contains the bound methods for this instance
    //-----------------------------------------------------------------
    std::unordered_map<std::string,
                       std::unique_ptr<std::vector<IServiceFilterInstance *>>>
        methodMap;

    //-----------------------------------------------------------------
    ///	@details
    ///		Conditional branching support.
    ///		m_activeBranch: -1 = normal fan-out (no filter),
    ///		               >= 0 = only dispatch to matching branch.
    ///		m_branchMap: maps each instance to its branch index
    ///		             (-1 = untagged, always dispatched).
    //-----------------------------------------------------------------
    int m_activeBranch = -1;
    std::unordered_map<IServiceFilterInstance *, int> m_branchMap;

public:
    static constexpr std::array<const char *, 17> MethodNames = {
        "open",
        "tags",
        "text",
        "table",
        "words",
        "audio",
        "video",
        "questions",
        "answers",
        "image",
        "classifications",
        "classificationContext",
        "documents",
        "closing",
        "close",
        "then",   // Conditional branch output (meta-lane)
        "else"};  // Conditional branch output (meta-lane)

    //-----------------------------------------------------------------
    ///	@details
    ///		Bind to our parent container instance
    //-----------------------------------------------------------------
    Binder(IServiceFilterInstance *pThis);

    //-----------------------------------------------------------------
    ///	@details
    ///		Bind an instance to another on the given lane
    //-----------------------------------------------------------------
    virtual Error bind(const std::string &methodName,
                       IServiceFilterInstance *pInstance) noexcept;
    virtual bool isPipeline() noexcept;
    virtual std::vector<std::string> getListeners() noexcept;
    virtual bool hasListener(const std::string &methodName) noexcept;

    static Error callMethods(
        Binder *pThis, const std::string &methodName,
        std::function<Error(IServiceFilterInstance *)> fcn,
        std::function<void(PIPELINE_TRACE_LEVEL, json::Value &)>
            serializeTrace) noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Conditional branch selection. selectBranch() sets which
    ///		branch receives subsequent write dispatches.
    ///		clearBranchSelection() restores normal fan-out.
    //-----------------------------------------------------------------
    void selectBranch(int branch) noexcept;
    void clearBranchSelection() noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Methods that we support
    //-----------------------------------------------------------------
    virtual Error open(Entry &entry) noexcept;
    virtual Error writeTag(const TAG *pTag) noexcept;
    virtual Error writeText(const Utf16View &text) noexcept;
    virtual Error writeTable(const Utf16View &text) noexcept;
    virtual Error writeWords(const WordVector &textWords) noexcept;
    virtual Error writeAudio(const AVI_ACTION action, Text &mimeType,
                             const pybind11::bytes &streamData) noexcept;
    virtual Error writeVideo(const AVI_ACTION action, Text &mimeType,
                             const pybind11::bytes &streamData) noexcept;
    virtual Error writeImage(const AVI_ACTION action, Text &mimeType,
                             const pybind11::bytes &streamData) noexcept;
    virtual Error writeQuestions(const pybind11::object &question) noexcept;
    virtual Error writeAnswers(const pybind11::object &answers) noexcept;
    virtual Error writeClassifications(
        const json::Value &classifications,
        const json::Value &classificationPolicy,
        const json::Value &classificationRules) noexcept;
    virtual Error writeClassificationContext(
        const json::Value &classifications) noexcept;
    virtual Error writeDocuments(const pybind11::object &documents) noexcept;
    virtual Error closing() noexcept;
    virtual Error close() noexcept;
};
}  // namespace engine::store

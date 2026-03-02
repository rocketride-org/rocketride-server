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

#pragma once

namespace engine::store {

/**
 * @brief Returns true if we are running a pipeline task
 */
bool Binder::isPipeline() noexcept {
    return m_pInstance->endpoint->isPipeline();
}

/**
 * @brief Binder constructor that initializes the method map with valid method
 * names.
 *
 * This ensures that all valid method names are pre-registered in the method
 * map, even if no instances are bound initially.
 *
 * @param pThis Pointer to the IServiceFilterInstance that owns this Binder.
 */
Binder::Binder(IServiceFilterInstance *pThis) {
    // Save the reference to the parent service filter instance
    m_pInstance = pThis;

    // Populate the method map with predefined method names, initially mapping
    // them to nullptr
    for (const char *name : MethodNames) {
        methodMap.emplace(name, nullptr);
    }
}

/**
 * @brief Binds a method name to a service filter instance.
 *
 * @param methodName The name of the method to bind.
 * @param pInstance A pointer to the IServiceFilterInstance to bind.
 */
Error Binder::bind(const std::string &methodName,
                   IServiceFilterInstance *pInstance) noexcept {
    auto it = methodMap.find(methodName);
    if (it == methodMap.end()) {
        return APERR(Ec::InvalidParam, "Invalid method name", methodName);
    }

    // Lazily initialize the vector when needed
    if (!it->second) {
        it->second = std::make_unique<std::vector<IServiceFilterInstance *>>();
    }

    // Add the instance to the dispatch vector
    it->second->push_back(pInstance);
    return {};  // Success
}

/**
 * @brief Invokes all bound service filter instances for the given method.
 *
 * This function checks whether the instance is in target mode and, if
 * applicable, iterates over the bound service filter instances, invoking the
 * provided callback. If no instances are bound, it returns success.
 *
 * @param pThis Pointer to the Binder instance.
 * @param methodName The name of the method to invoke.
 * @param callback A function to execute for each bound IServiceFilterInstance.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::callMethods(
    Binder *pThis, const std::string &methodName,
    std::function<Error(IServiceFilterInstance *)> callback,
    const json::Value &traceData) noexcept {
    Error ccode;

    // Ensure the instance is operating in target mode
    if (pThis->m_pInstance->endpoint->config.endpointMode !=
        ENDPOINT_MODE::TARGET)
        return APERR(Ec::InvalidParam,
                     "This function may only be called when in target mode");

    // If pipeline mode is disabled, directly invoke the next driver
    if (!pThis->isPipeline()) return callback(pThis->m_pInstance->pDown.get());

    // Locate the method in the method map
    auto it = pThis->methodMap.find(methodName);
    if (it == pThis->methodMap.end() || !it->second)
        return {};  // No bound instances, return success

    // Get the trace level
    auto traceLevel =
        pThis->m_pInstance->endpoint->config.pipelineTraceLevel;

    // Iterate over bound instances and invoke the callback
    for (auto *pInstance : *(it->second)) {
        // Build enter trace if tracing is enabled
        json::Value enterTrace;
        if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA)
            enterTrace["lane"] = methodName.c_str();
        if (traceLevel >= PIPELINE_TRACE_LEVEL::FULL && !traceData.isNull())
            enterTrace["data"] = traceData;

        // Signal to the debugger we are entering a level
        pThis->m_pInstance->pipe->debugger.debugEnter(pInstance, enterTrace);

        // Break if we need to
        pThis->m_pInstance->pipe->debugger.debugBreak(pThis->m_pInstance,
                                                      pInstance, methodName);

        // Call the function
        if (ccode = callback(pInstance)) {
            // If we got an error allow the debugger to handle it
            pThis->m_pInstance->pipe->debugger.debugError(
                pThis->m_pInstance, pInstance, methodName, ccode);

            // Build leave trace with error result
            json::Value leaveTrace;
            if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
                leaveTrace["lane"] = methodName.c_str();

                if (ccode.code() == Ec::PreventDefault) {
                    leaveTrace["result"] = "skip";
                } else {
                    leaveTrace["result"] = "error";
                    leaveTrace["error"] = ccode.message();
                }
            }

            // Signal to the debugger we are leaving a level
            pThis->m_pInstance->pipe->debugger.debugLeave(pInstance,
                                                          leaveTrace);

            // Stop on the first error
            break;
        } else {
            // Build leave trace with continue result
            json::Value leaveTrace;
            if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
                leaveTrace["lane"] = methodName.c_str();
                leaveTrace["result"] = "continue";
            }

            // Signal to the debugger we are leaving a level
            pThis->m_pInstance->pipe->debugger.debugLeave(pInstance,
                                                          leaveTrace);
        }
    }
    return ccode;
}

/**
 * @brief Retrieves a list of method names that have active listeners.
 *
 * If the instance is not in pipeline mode, all method names are returned.
 * Otherwise, only the method names with active listeners are included.
 *
 * @return std::vector<std::string> A list of method names with active listeners
 *                                  or all methods if not in pipeline mode.
 */
std::vector<std::string> Binder::getListeners() noexcept {
    std::vector<std::string> listeners;

    // If not in pipeline mode, return all method names
    if (!isPipeline()) {
        for (const auto &entry : methodMap) {
            listeners.push_back(entry.first);
        }
        return listeners;
    }

    // Otherwise, return only the methods with active listeners
    for (const auto &entry : methodMap) {
        if (entry.second && !entry.second->empty()) {
            listeners.push_back(entry.first);
        }
    }

    return listeners;
}

/**
 * @brief Checks if a given method has any registered listeners.
 *
 * This function searches for the specified method name in the `methodMap` and
 * verifies whether any listeners are bound to it.
 *
 * @param methodName The name of the method to check.
 * @return true if at least one listener is registered for the method, false
 * otherwise.
 */
bool Binder::hasListener(const std::string &methodName) noexcept {
    // Always return true if not in pipeline mode
    if (!isPipeline()) return true;

    // Attempt to find the method in the method map
    auto it = methodMap.find(methodName);

    // Ensure the method exists in the map and has at least one bound instance
    return it != methodMap.end() && it->second && !it->second->empty();
}

/**
 * @brief Opens an entry by delegating to all bound service filter instances.
 *
 * @param entry The entry to open.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::open(Entry &entry) noexcept {
    // Define the servicing function
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->open(entry);
    };

    // Call the methods
    return callMethods(this, "open", call);
}

/**
 * @brief Writes a tag to all bound service filter instances.
 *
 * @param pTag Pointer to the tag to write.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeTag(const TAG *pTag) noexcept {
    // Call the methods
    return callMethods(
        this, "tags",
        localfcn(auto pInstance)->Error { return pInstance->writeTag(pTag); });
}

/**
 * @brief Writes text to all bound service filter instances.
 *
 * @param text The text to write.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeText(const Utf16View &text) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeText(text);
    };
    json::Value data;

    auto traceLevel = m_pInstance->endpoint->config.pipelineTraceLevel;
    
    if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA)
        data["length"] = (int)text.length();
    if (traceLevel >= PIPELINE_TRACE_LEVEL::FULL) 
        data["text"] = _tr<Text>(text).substr(0, 2000);

    return callMethods(this, "text", call, data);
}

/**
 * @brief Writes a table to all bound service filter instances.
 *
 * @param text The table data as text.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeTable(const Utf16View &text) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeTable(text);
    };
    json::Value data;

    auto traceLevel = m_pInstance->endpoint->config.pipelineTraceLevel;
    if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA)
        data["length"] = (int)text.length();
    if (traceLevel >= PIPELINE_TRACE_LEVEL::FULL)
        data["table"] = _tr<Text>(text).substr(0, 2000);

    return callMethods(this, "table", call, data);
}

/**
 * @brief Writes words to all bound service filter instances.
 *
 * @param textWords A vector of words to write.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeWords(const WordVector &textWords) noexcept {
    // Call the methods
    return callMethods(
        this, "words", localfcn(auto pInstance)->Error {
            return pInstance->writeWords(textWords);
        });
}

/**
 * @brief Writes audio data to all bound service filter instances.
 *
 * @param action The action to perform on the audio.
 * @param mimeType The mime type of the audio.
 * @param streamData The audio stream data.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeAudio(const AVI_ACTION action, Text &mimeType,
                         const pybind11::bytes &streamData) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeAudio(action, mimeType, streamData);
    };
    json::Value data;

    if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
        data["action"] = (int)action;
        data["mimeType"] = mimeType;

        engine::python::LockPython lock;
        data["bufferSize"] = (int)PyBytes_GET_SIZE(streamData.ptr());
    }

    return callMethods(this, "audio", call, data);
}

/**
 * @brief Writes video data to all bound service filter instances.
 *
 * @param action The action to perform on the video.
 * @param mimeType The mime type of the video.
 * @param streamData The video stream data.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeVideo(const AVI_ACTION action, Text &mimeType,
                         const pybind11::bytes &streamData) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeVideo(action, mimeType, streamData);
    };
    json::Value data;

    if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
        data["action"] = (int)action;
        data["mimeType"] = mimeType;

        engine::python::LockPython lock;
        data["bufferSize"] = (int)PyBytes_GET_SIZE(streamData.ptr());
    }

    return callMethods(this, "video", call, data);
}

/**
 * @brief Writes image data to all bound service filter instances.
 *
 * @param action The action to perform on the image.
 * @param mimeType The mime type of the image.
 * @param streamData The image stream data.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeImage(const AVI_ACTION action, Text &mimeType,
                         const pybind11::bytes &streamData) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeImage(action, mimeType, streamData);
    };
    json::Value data;

    if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
        data["action"] = (int)action;
        data["mimeType"] = mimeType;

        engine::python::LockPython lock;
        data["bufferSize"] = (int)PyBytes_GET_SIZE(streamData.ptr());
    }

    return callMethods(this, "image", call, data);
}

/**
 * @brief Writes questions to all bound service filter instances.
 *
 * @param questions A Python object containing the questions.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeQuestions(const pybind11::object &question) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeQuestions(question);
    };
    json::Value data;

    if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::FULL) {
        engine::python::LockPython lock;
        data["questions"] = engine::python::pyjson::dictToJson(question.attr("model_dump")());
    }
    
    return callMethods(this, "questions", call, data);
}

/**
 * @brief Writes answers to all bound service filter instances.
 *
 * @param answers A Python object containing the answers.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeAnswers(const pybind11::object &answers) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeAnswers(answers);
    };
    json::Value data;

    if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::FULL) {
        engine::python::LockPython lock;
        data["answers"] = engine::python::pyjson::dictToJson(answers.attr("model_dump")());
    }
    return callMethods(this, "answers", call, data);
}

/**
 * @brief Writes classifications to all bound service filter instances.
 *
 * @param classifications A JSON value containing the classifications.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeClassifications(
    const json::Value &classifications, const json::Value &classificationPolicy,
    const json::Value &classificationRules) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeClassifications(
            classifications, classificationPolicy, classificationRules);
    };

    json::Value data;
    if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::SUMMARY) {
        data["count"] = (int)classifications.size();
    }

    return callMethods(this, "classifications", call, data);
}

/**
 * @brief Writes classification context to all bound service filter instances.
 *
 * @param classifications A JSON value containing the classification context.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeClassificationContext(
    const json::Value &classifications) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeClassificationContext(classifications);
    };
    json::Value data;

    if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::SUMMARY) {
        data["count"] = (int)classifications.size();
    }

    return callMethods(this, "classificationContext", call, data);
}

/**
 * @brief Writes documents to all bound service filter instances.
 *
 * @param documents A Python object containing the documents.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeDocuments(const pybind11::object &documents) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeDocuments(documents);
    };
    json::Value data;

    if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
        try {
            engine::python::LockPython lock;
            data["count"] = (int)py::len(documents);
            if (m_pInstance->endpoint->config.pipelineTraceLevel >= PIPELINE_TRACE_LEVEL::FULL) {
                py::list docDicts;
                for (auto doc : documents)
                    docDicts.append(doc.attr("toDict")());
                data["documents"] = engine::python::pyjson::dictToJson(docDicts);
            }
        } catch (...) {}
    }

    return callMethods(this, "documents", call, data);
}

/**
 * @brief Calls the closing operation on all bound service filter instances.
 *
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::closing() noexcept {
    // Call the methods
    return callMethods(
        this, "closing",
        localfcn(auto pInstance)->Error { return pInstance->closing(); });
}

/**
 * @brief Closes all bound service filter instances.
 *
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::close() noexcept {
    // Call the methods
    return callMethods(
        this, "close",
        localfcn(auto pInstance)->Error { return pInstance->close(); });
}

}  // namespace engine::store

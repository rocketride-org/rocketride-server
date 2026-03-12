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
 * @brief Dispatches a named method to all bound IServiceFilterInstance targets and records pipeline trace entries.
 *
 * Invokes the provided callback for each bound instance registered for methodName, emits enter/leave trace data
 * via serializeTrace according to the endpoint's pipeline trace level, and notifies the debugger about enter/leave/error
 * events. When pipeline mode is disabled the callback is invoked only on the downstream instance.
 *
 * @param pThis Binder instance owning the bindings.
 * @param methodName Name of the method/lane to dispatch.
 * @param callback Function executed for each bound IServiceFilterInstance; its returned Error is used to stop iteration.
 * @param serializeTrace Callback that populates a json::Value with trace data for a given PIPELINE_TRACE_LEVEL.
 * @return Error The last error returned by a callback, `success` if all callbacks completed, or an `InvalidParam` error
 * if the binder is not in target endpoint mode.
Error Binder::callMethods(
    Binder *pThis, const std::string &methodName,
    std::function<Error(IServiceFilterInstance *)> callback,
    std::function<void(PIPELINE_TRACE_LEVEL, json::Value &)>
        serializeTrace) noexcept {
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
    auto traceLevel = pThis->m_pInstance->endpoint->config.pipelineTraceLevel;

    // Iterate over bound instances and invoke the callback
    for (auto *pInstance : *(it->second)) {
        // Build enter trace
        json::Value enterTrace;
        if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
            enterTrace["lane"] = methodName.c_str();
            serializeTrace(traceLevel, enterTrace["data"]);
        }

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

            // Build leave trace with error/skip result
            json::Value leaveTrace;
            if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
                leaveTrace["lane"] = methodName.c_str();

                if (ccode.code() == Ec::PreventDefault) {
                    leaveTrace["result"] = "skip";
                    serializeTrace(traceLevel, leaveTrace["data"]);
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
                serializeTrace(traceLevel, leaveTrace["data"]);
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
 * @brief Dispatches an open operation to all bound service filter instances.
 *
 * @param entry The entry to open.
 * @return Error The last error returned by a bound instance; success if all instances succeeded.
 */
Error Binder::open(Entry &entry) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->open(entry);
    };

    auto serializeTrace = [](PIPELINE_TRACE_LEVEL, json::Value &) {};

    return callMethods(this, "open", call, serializeTrace);
}

/**
 * @brief Writes a tag to all bound service filter instances.
 *
 * @param pTag Pointer to the tag to write.
 * @return Error Error returned by the first instance that fails, or success if all instances succeed.
 */
Error Binder::writeTag(const TAG *pTag) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeTag(pTag);
    };

    auto serializeTrace = [](PIPELINE_TRACE_LEVEL, json::Value &) {};

    return callMethods(this, "tags", call, serializeTrace);
}

/**
 * @brief Dispatches the provided text to all bound service filter instances.
 *
 * The binder will invoke each bound instance's writeText method in sequence.
 * Pipeline tracing records the text length at METADATA level and up to the
 * first 2000 characters of the text at FULL level.
 *
 * @param text Text to send to bound instances.
 * @return Error The last error returned by a bound instance; success if none failed.
 */
Error Binder::writeText(const Utf16View &text) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeText(text);
    };

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::METADATA)
            out["length"] = (int)text.length();
        if (level >= PIPELINE_TRACE_LEVEL::FULL)
            out["text"] = _tr<Text>(text).substr(0, 2000);
    };

    return callMethods(this, "text", call, serializeTrace);
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

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::METADATA)
            out["length"] = (int)text.length();
        if (level >= PIPELINE_TRACE_LEVEL::FULL)
            out["table"] = _tr<Text>(text).substr(0, 2000);
    };

    return callMethods(this, "table", call, serializeTrace);
}

/**
 * @brief Writes words to all bound service filter instances.
 *
 * @param textWords A vector of words to write.
 * @return Error Returns an error code if any instance fails, otherwise success.
 */
Error Binder::writeWords(const WordVector &textWords) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeWords(textWords);
    };

    auto serializeTrace = [](PIPELINE_TRACE_LEVEL, json::Value &) {};

    return callMethods(this, "words", call, serializeTrace);
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

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::METADATA) {
            out["action"] = (int)action;
            out["mimeType"] = mimeType;

            engine::python::LockPython lock;
            out["bufferSize"] = (int)PyBytes_GET_SIZE(streamData.ptr());
        }
    };

    return callMethods(this, "audio", call, serializeTrace);
}

/**
 * @brief Dispatches a video write operation to all bound service filter instances.
 *
 * @param action Video action to perform.
 * @param mimeType MIME type of the video.
 * @param streamData Video data buffer.
 * @return Error Error from the first failing instance, or success if all instances completed.
 */
Error Binder::writeVideo(const AVI_ACTION action, Text &mimeType,
                         const pybind11::bytes &streamData) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeVideo(action, mimeType, streamData);
    };

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::METADATA) {
            out["action"] = (int)action;
            out["mimeType"] = mimeType;

            engine::python::LockPython lock;
            out["bufferSize"] = (int)PyBytes_GET_SIZE(streamData.ptr());
        }
    };

    return callMethods(this, "video", call, serializeTrace);
}

/**
 * @brief Dispatches an image write operation to all bound service filter instances.
 *
 * @param action The image action to perform (enum value).
 * @param mimeType The image MIME type.
 * @param streamData The image payload as Python bytes.
 * @return Error Error code returned by the first bound instance that fails, or success if all instances succeed.
 */
Error Binder::writeImage(const AVI_ACTION action, Text &mimeType,
                         const pybind11::bytes &streamData) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeImage(action, mimeType, streamData);
    };

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::METADATA) {
            out["action"] = (int)action;
            out["mimeType"] = mimeType;

            engine::python::LockPython lock;
            out["bufferSize"] = (int)PyBytes_GET_SIZE(streamData.ptr());
        }
    };

    return callMethods(this, "image", call, serializeTrace);
}

/**
 * @brief Sends the provided questions object to all bound service filter instances.
 *
 * The provided Python object is used as-is and, when tracing at FULL level, its model_dump() output
 * will be converted to JSON for pipeline traces.
 *
 * @param question Python object representing the questions; expected to implement `model_dump()`.
 * @return Error Error code from the first bound instance that fails, or success if all instances succeed.
 */
Error Binder::writeQuestions(const pybind11::object &question) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeQuestions(question);
    };

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::FULL) {
            engine::python::LockPython lock;
            out["questions"] = engine::python::pyjson::dictToJson(
                question.attr("model_dump")());
        }
    };

    return callMethods(this, "questions", call, serializeTrace);
}

/**
 * @brief Dispatches the provided answers object to all bound service filter instances.
 *
 * When pipeline tracing is enabled at FULL level, the function will serialize the answers
 * by calling the Python object's `model_dump()` and include that JSON in the pipeline trace.
 *
 * @param answers A Python object (expected to support `model_dump()`) containing the answers to dispatch.
 * @return Error Error code returned by the first failing bound instance, or success if all instances succeed.
 */
Error Binder::writeAnswers(const pybind11::object &answers) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeAnswers(answers);
    };

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::FULL) {
            engine::python::LockPython lock;
            out["answers"] = engine::python::pyjson::dictToJson(
                answers.attr("model_dump")());
        }
    };

    return callMethods(this, "answers", call, serializeTrace);
}

/**
 * @brief Dispatches classification data to all bound service filter instances.
 *
 * Sends the provided classifications, policy, and rules to each bound instance and aggregates the first error encountered.
 *
 * @param classifications JSON array or object with classification entries; the number of entries is recorded in pipeline traces at SUMMARY level.
 * @param classificationPolicy JSON object describing the classification policy applied to the classifications.
 * @param classificationRules JSON object describing additional classification rules.
 * @return Error `success` if all bound instances processed the classifications; otherwise the error returned by the first instance that failed.
 */
Error Binder::writeClassifications(
    const json::Value &classifications, const json::Value &classificationPolicy,
    const json::Value &classificationRules) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeClassifications(
            classifications, classificationPolicy, classificationRules);
    };

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::SUMMARY)
            out["count"] = (int)classifications.size();
    };

    return callMethods(this, "classifications", call, serializeTrace);
}

/**
 * @brief Dispatches classification context to all bound service filter instances.
 *
 * @param classifications JSON array or object containing classification entries; its size is used for tracing.
 * @return Error The first error returned by a bound instance, or success if all calls succeed.
 */
Error Binder::writeClassificationContext(
    const json::Value &classifications) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeClassificationContext(classifications);
    };

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::SUMMARY)
            out["count"] = (int)classifications.size();
    };

    return callMethods(this, "classificationContext", call, serializeTrace);
}

/**
 * @brief Writes a collection of documents to all bound service filter instances.
 *
 * @param documents A Python iterable of document objects to be written (each expected to expose a `toDict()` method).
 * @return Error The first error returned by a bound instance, or success if all instances complete without error.
 */
Error Binder::writeDocuments(const pybind11::object &documents) noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->writeDocuments(documents);
    };

    auto serializeTrace = [&](PIPELINE_TRACE_LEVEL level, json::Value &out) {
        if (level >= PIPELINE_TRACE_LEVEL::METADATA) {
            try {
                engine::python::LockPython lock;
                out["count"] = (int)py::len(documents);
                if (level >= PIPELINE_TRACE_LEVEL::FULL) {
                    py::list docDicts;
                    for (auto doc : documents)
                        docDicts.append(doc.attr("toDict")());
                    out["documents"] =
                        engine::python::pyjson::dictToJson(docDicts);
                }
            } catch (...) {
            }
        }
    };

    return callMethods(this, "documents", call, serializeTrace);
}

/**
 * @brief Dispatches the "closing" operation to all bound service filter instances.
 *
 * Calls each bound instance's closing() in pipeline order and returns the first error encountered,
 * or success if all instances complete successfully.
 *
 * @return Error The first non-success error returned by a bound instance, or success if none failed.
 */
Error Binder::closing() noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->closing();
    };

    auto serializeTrace = [](PIPELINE_TRACE_LEVEL, json::Value &) {};

    return callMethods(this, "closing", call, serializeTrace);
}

/**
 * @brief Close all bound service filter instances.
 *
 * @return Error The last error returned by a bound instance, or success if all instances closed successfully.
 */
Error Binder::close() noexcept {
    auto call = localfcn(auto pInstance)->Error {
        return pInstance->close();
    };

    auto serializeTrace = [](PIPELINE_TRACE_LEVEL, json::Value &) {};

    return callMethods(this, "close", call, serializeTrace);
}

}  // namespace engine::store

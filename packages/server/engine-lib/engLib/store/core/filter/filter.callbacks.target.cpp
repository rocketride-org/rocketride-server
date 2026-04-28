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

#include <engLib/eng.h>

namespace engine::store {
//-------------------------------------------------------------------------
// These are callbacks from python. If the endpoint is not target mode,
// we throw an error.
//
// open/close are special cases in that, normally, we forward off to the
// next set of services filters via the binder. However, we need pipe
// to actually get the open/close as well, so if we are the pipe, we
// call the open/close functions here, let it do it's processing and
// forward off to the binder. If we handled every function like this,
// there would be a possibility that the python could recurse into
// itself causing an endless loop. So, when python calls
// self.instance.writeText, it will not go to itelf, but rather through
// the binder
//-------------------------------------------------------------------------

bool IServiceFilterInstance::cb_hasListener(std::string lane) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use hasListener");

    return this->binder.hasListener(lane);
}

std::vector<std::string> IServiceFilterInstance::cb_getListeners() noexcept(
    false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use getListeners");

    return this->binder.getListeners();
}

std::vector<std::string> IServiceFilterInstance::cb_getControllerNodeIds(
    std::string &classType) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use getControllerNodeIds");

    std::vector<std::string> result;
    auto it = this->controller.find(classType);
    if (it != this->controller.end()) {
        for (auto idx : it->second) {
            auto &filter =
                this->endpoint->m_instanceStacks[this->pipeId][idx];
            result.push_back(filter->pipeType.id);
        }
    }
    return result;
}

// Returns the bound peer filter whose pipeType.id matches `nodeId`, or
// nullptr if no peer matches. Used by Python conditional routers to
// resolve a branch target id and then hand the chunk to that peer via
// peer.acceptXxx(...). The returned pointer is non-owning and only
// valid for the lifetime of the pipeline.
IServiceFilterInstance *IServiceFilterInstance::cb_getInstance(
    const std::string &nodeId) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use getInstance");

    auto &stack = this->endpoint->m_instanceStacks[this->pipeId];
    for (auto &filter : stack) {
        if (filter && filter->pipeType.id == nodeId) return filter.get();
    }
    return nullptr;
}

void IServiceFilterInstance::cb_control(std::string &classType,
                                        py::object &control,
                                        std::string nodeId) noexcept(false) {
    Error ccode;

    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use control");

    // Get the filters that are registered for this type of control
    auto controls = this->controller.find(classType);

    // If we don't have any, throw
    if (controls == this->controller.end())
        throw APERR(Ec::InvalidParam, "No control listeners registered for ",
                    classType);

    // Get the trace level
    auto traceLevel = endpoint->config.pipelineTraceLevel;

    // ---- Targeted dispatch: if nodeId is provided, call that node directly
    if (!nodeId.empty()) {
        for (auto filterId : controls->second) {
            ServiceInstance filter =
                this->endpoint->m_instanceStacks[this->pipeId][filterId];

            if (filter->pipeType.id != nodeId) continue;

            // Build enter trace
            json::Value enterTrace;
            if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
                enterTrace["lane"] = "invoke";
                enterTrace["invoke"] = classType.c_str();

                if (traceLevel >= PIPELINE_TRACE_LEVEL::FULL)
                    enterTrace["data"] = engine::python::pyjson::dictToJson(
                        control.attr("model_dump")());
            }

            this->pipe->debugger.debugEnter(filter.get(), enterTrace);

            ccode = filter->control(control);

            // Build leave trace
            json::Value leaveTrace;
            if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
                leaveTrace["lane"] = "invoke";
                leaveTrace["invoke"] = classType.c_str();
                leaveTrace["result"] = ccode ? "error" : "continue";

                if (ccode && ccode.code() != Ec::PreventDefault)
                    leaveTrace["error"] = ccode.message();

                if (traceLevel >= PIPELINE_TRACE_LEVEL::FULL)
                    leaveTrace["data"] = engine::python::pyjson::dictToJson(
                        control.attr("model_dump")());
            }

            this->pipe->debugger.debugLeave(filter.get(), leaveTrace);

            if (ccode) throw ccode;
            return;
        }

        throw APERR(Ec::InvalidParam, "Node '", nodeId,
                    "' not found for control type '", classType, "'");
    }

    // ---- Chain dispatch: walk all filters until one succeeds
    for (auto filterId : controls->second) {
        // Get a ptr to the specified filter
        ServiceInstance filter =
            this->endpoint->m_instanceStacks[this->pipeId][filterId];

        // Build enter trace if tracing is enabled
        json::Value enterTrace;
        if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
            enterTrace["lane"] = "invoke";
            enterTrace["invoke"] = classType.c_str();

            if (traceLevel >= PIPELINE_TRACE_LEVEL::FULL)
                enterTrace["data"] = engine::python::pyjson::dictToJson(
                    control.attr("model_dump")());
        }

        this->pipe->debugger.debugEnter(filter.get(), enterTrace);

        // Call the control function
        ccode = filter->control(control);

        // If we succeeded, we are done
        if (!ccode) {
            // Build leave trace
            json::Value leaveTrace;
            if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
                leaveTrace["lane"] = "invoke";
                leaveTrace["invoke"] = classType.c_str();
                leaveTrace["result"] = "continue";

                if (traceLevel >= PIPELINE_TRACE_LEVEL::FULL)
                    leaveTrace["data"] = engine::python::pyjson::dictToJson(
                        control.attr("model_dump")());
            }

            // And inform we are leaving
            this->pipe->debugger.debugLeave(filter.get(), leaveTrace);
            return;
        }

        // If it is preventDefault, continue on to the next driver
        if (ccode.code() == Ec::PreventDefault) {
            // Build leave trace
            json::Value leaveTrace;
            if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
                leaveTrace["lane"] = "invoke";
                leaveTrace["invoke"] = classType.c_str();
                leaveTrace["result"] = "skip";

                if (traceLevel >= PIPELINE_TRACE_LEVEL::FULL)
                    leaveTrace["data"] = engine::python::pyjson::dictToJson(
                        control.attr("model_dump")());
            }

            // And inform we are leaving
            this->pipe->debugger.debugLeave(filter.get(), leaveTrace);
            continue;
        }

        // Throw the error - it is not 0, and it is not prevent default
        // so it is a terminal error
        json::Value leaveTrace;
        if (traceLevel >= PIPELINE_TRACE_LEVEL::METADATA) {
            leaveTrace["lane"] = "invoke";
            leaveTrace["invoke"] = classType.c_str();
            leaveTrace["result"] = "error";
            leaveTrace["error"] = ccode.message();
        }

        this->pipe->debugger.debugLeave(filter.get(), leaveTrace);
        throw ccode;
    }

    // If we got here, we didn't get a valid response from any of the filters
    throw APERR(Ec::InvalidParam, "No driver accepted the ", classType,
                " invoke command");
}

void IServiceFilterInstance::cb_open(py::object entry) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam, "You must be in target mode to use open");

    // Cast a python object to the native object
    auto &object = py::cast<Entry &>(entry);

    // Keep a python reference to prevent it from being garbage collected
    pyCurrentEntry = entry;

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        // Open it
        Error ccode;

        // If we are the pipe filter, call it, otherwise the binder
        if (!this->filterLevel)
            ccode = this->open(object);
        else
            ccode = binder.open(object);

        if (ccode) throw ccode;
    }
}

void IServiceFilterInstance::cb_writeTagBeginObject() noexcept(false) {
    // Check to make sure target mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to us writeTagBeginObject");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        // Write an object begin
        auto objectBegin = TAG_OBJECT_BEGIN();
        objectBegin.setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

        // Write it
        if (auto ccode = binder.writeTag(&objectBegin)) throw ccode;
    }
};

void IServiceFilterInstance::cb_writeTagBeginStream() noexcept(false) {
    // Check to make sure target mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeTagBeginStream");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        // Get the internal tag buffer
        TAG *pTagBuffer;
        if (auto ccode = getTagBuffer(&pTagBuffer)) throw ccode;

        // Setup the default stream begin tag
        const auto pStreamBeginTag = TAG_OBJECT_STREAM_BEGIN::build(
            pTagBuffer, TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA);

        // Save the size and offset
        pStreamBeginTag->data.streamSize = 0;
        pStreamBeginTag->data.streamOffset = 0;

        // Write it
        if (auto ccode = binder.writeTag(pStreamBeginTag)) throw ccode;
    }
};

void IServiceFilterInstance::cb_writeTagData(py::object &data) noexcept(false) {
    // Check to make sure target mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeTagData");

    // Send it
    const auto send = localfcn(size_t size, const void *pData) {
        Error ccode;

        // Unlock python and send it along
        engine::python::UnlockPython unlock;

        // Get the internal tag buffer
        TAG *pTagBuffer;
        if (auto ccode = getTagBuffer(&pTagBuffer)) throw ccode;

        size_t offset = 0;
        while (size) {
            // Determine how much we can send
            auto chunk = size;
            if (chunk > MAX_IOSIZE) chunk = MAX_IOSIZE;

            // Get a generic ptr
            Byte *pSendBuffer = (Byte *)pData;

            // Build the tag
            const auto pDataTag = TAG_OBJECT_STREAM_DATA::build(pTagBuffer);

            // Save the tag data
            memcpy(pDataTag->data.data, &pSendBuffer[offset], chunk);

            // Set the data size
            pDataTag->setDataSize((Dword)chunk);

            // Write it
            if (auto ccode = binder.writeTag(pDataTag)) throw ccode;

            // Update the positions
            offset += chunk;
            size -= chunk;
        }
    };

    // Get the raw data ptr
    auto object = data.ptr();

    // If this is a string object
    if (PyUnicode_Check(object)) {
        LOGT("Sending string");

        // Get the string as a utf-8 string and it's size
        Py_ssize_t size;
        const char *value = PyUnicode_AsUTF8AndSize(object, &size);

        // If it couldn't be mapped, error out
        if (!value) throw APERR(Ec::InvalidParam, "Unable to convert to UTF8");

        // Send the data
        send(size, (void *)value);
        return;
    }

    // If this is a numeric object
    if (PyLong_Check(object)) {
        LOGT("Sending long");

        // Get the value
        long value = PyLong_AsLong(object);

        // Send the data
        send(sizeof(long), (void *)&value);
        return;
    }

    // If this is a dictonary object
    if (PyDict_Check(object)) {
        LOGT("Sending dict");

        auto str = engine::python::pyjson::dictToJson(data).stringify();
        send(str.size(), str.c_str());
        return;
    }

    // If this is a list object
    if (PyList_Check(object)) {
        LOGT("Sending list");

        auto str = engine::python::pyjson::dictToJson(data).stringify();
        send(str.size(), str.c_str());
        return;
    }

    // If this is a bytes object
    if (PyBytes_Check(object)) {
        LOGT("Sending bytes");

        auto size = PyBytes_Size(object);
        auto pBuffer = PyBytes_AsString(object);

        send(size, pBuffer);
        return;
    }

    throw APERR(Ec::InvalidParam, "Invalid writeTagData type");
}

void IServiceFilterInstance::cb_writeTag(py::bytes data) noexcept(false) {
    // Check to make sure target mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeTag");

    TAG *tag = nullptr;
    py::ssize_t length = 0;

    // Cast input bytes to TAG pointer
    if (PYBIND11_BYTES_AS_STRING_AND_SIZE(data.ptr(), _reCast<char **>(&tag),
                                          &length))
        throw APERR(Ec::InvalidParam, "Invalid bytes");

    // Сheck that enough bytes sent
    if (length < sizeof(*tag))
        throw APERR(Ec::InvalidParam, "Not enough tag bytes");

    // Сheck that the tag sent is valid
    switch (tag->tagId) {
        case TAG_ID::OBEG:
        case TAG_ID::SBGN:
        case TAG_ID::OMET:
        case TAG_ID::SDAT:
        case TAG_ID::OENC:
        case TAG_ID::SEND:
        case TAG_ID::OEND: {
            if (sizeof(*tag) + tag->size != _cast<size_t>(length))
                throw APERR(Ec::InvalidParam, "Invalid tag length");
            break;
        }
        default:
            throw APERR(Ec::InvalidParam, "Invalid tag id");
    }

    // Write it
    if (auto ccode = binder.writeTag(tag)) throw ccode;
}

void IServiceFilterInstance::cb_writeText(const std::u16string &text) noexcept(
    false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeText");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeText(text)) throw ccode;
    }
}

void IServiceFilterInstance::cb_writeTable(const std::u16string &text) noexcept(
    false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeTable");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeTable(text)) throw ccode;
    }
}

void IServiceFilterInstance::cb_writeWords(
    const WordVector &textWords) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeWords");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeWords(textWords)) throw ccode;
    }
}

void IServiceFilterInstance::cb_writeAudio(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeAudio");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeAudio(action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_writeVideo(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeVideo");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeVideo(action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_writeImage(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeImage");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeImage(action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_writeQuestions(
    const pybind11::object &question) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeQuestions");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeQuestions(question)) throw ccode;
    }
}

void IServiceFilterInstance::cb_writeAnswers(
    const pybind11::object &answers) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeAnswers");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeAnswers(answers)) throw ccode;
    }
}

void IServiceFilterInstance::cb_writeDocuments(
    const pybind11::object &documents) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeDocuments");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeDocuments(documents)) throw ccode;
    }
}

void IServiceFilterInstance::cb_writeClassifications(
    const json::Value &classifications, const json::Value &classificationPolicy,
    const json::Value &classificationRules) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeClassifications");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeClassifications(
                classifications, classificationPolicy, classificationRules))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_writeClassificationContext(
    const json::Value &context) noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(
            Ec::InvalidParam,
            "You must be in target mode to use writeClassificationContext");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = binder.writeClassificationContext(context))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_writeTagEndStream() noexcept(false) {
    // Check to make sure target mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeTagEndStream");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        // Create the tag
        const auto streamEndTag = TAG_OBJECT_STREAM_END();

        // Write it
        if (auto ccode = binder.writeTag(&streamEndTag)) throw ccode;
    }
};

void IServiceFilterInstance::cb_writeTagEndObject() noexcept(false) {
    // Check to make sure target mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use writeTagEndObject");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        // Write an object end
        auto objectEnd = TAG_OBJECT_END(currentEntry->completionCode());
        objectEnd.setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

        // Write it
        if (auto ccode = binder.writeTag(&objectEnd)) throw ccode;
    }
};

void IServiceFilterInstance::cb_close() noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use close");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        // Close  it
        Error ccode;

        // If we are the pipe filter, call it, otherwise the binder
        if (!this->filterLevel)
            ccode = this->close();
        else
            ccode = binder.close();

        // Once object closed, release a python reference
        _block() {
            engine::python::LockPython lock;
            pyCurrentEntry = py::none();
        }

        if (ccode) throw ccode;
    }
}

void IServiceFilterInstance::cb_closing() noexcept(false) {
    // Check to make sure target mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use closing");

    // Unlock python and send it along
    _block() {
        engine::python::UnlockPython unlock;

        // Close  it
        Error ccode;

        // If we are the pipe filter, call it, otherwise the binder
        if (!this->filterLevel)
            ccode = this->closing();
        else
            ccode = binder.closing();

        if (ccode) throw ccode;
    }
}

//-------------------------------------------------------------------------
// cb_acceptXxx — peer-direct delivery
//
// These differ from cb_writeXxx in WHO receives the chunk:
//   cb_writeXxx  : invokes this->binder.writeXxx → broadcasts to every
//                  listener bound on the lane (the normal upstream
//                  fan-out pattern).
//   cb_acceptXxx : invokes this->writeXxx() virtual directly → fires
//                  IPythonInstanceBase::writeXxx trampoline → calls
//                  this node's own Python writeXxx override.
//
// Used by `flow_*` conditional routers: after `peer = self.instance
// .getInstance(nodeId)`, the router calls `peer.acceptXxx(...)` to
// hand the chunk to that peer's own handler — bypassing peer's
// downstream binder so the peer actually processes the chunk.
//-------------------------------------------------------------------------

void IServiceFilterInstance::cb_acceptText(
    const std::u16string &text) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptText");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeText(text)) throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptTable(
    const std::u16string &text) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptTable");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeTable(text)) throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptWords(
    const WordVector &textWords) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptWords");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeWords(textWords)) throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptAudio(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptAudio");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeAudio(action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptVideo(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptVideo");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeVideo(action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptImage(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptImage");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeImage(action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptQuestions(
    const pybind11::object &question) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptQuestions");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeQuestions(question)) throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptAnswers(
    const pybind11::object &answers) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptAnswers");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeAnswers(answers)) throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptDocuments(
    const pybind11::object &documents) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptDocuments");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeDocuments(documents)) throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptClassifications(
    const json::Value &classifications, const json::Value &classificationPolicy,
    const json::Value &classificationRules) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(Ec::InvalidParam,
                    "You must be in target mode to use acceptClassifications");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeClassifications(
                classifications, classificationPolicy, classificationRules))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_acceptClassificationContext(
    const json::Value &context) noexcept(false) {
    if (endpoint->config.endpointMode != ENDPOINT_MODE::TARGET)
        throw APERR(
            Ec::InvalidParam,
            "You must be in target mode to use acceptClassificationContext");
    _block() {
        engine::python::UnlockPython unlock;
        if (auto ccode = this->writeClassificationContext(context))
            throw ccode;
    }
}
}  // namespace engine::store

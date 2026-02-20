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

#include <engLib/eng.h>

namespace engine::store {
//-------------------------------------------------------------------------
// These methods are used for sending data to the target. They can only
// be used by an pipe where the endpoint is in source mode
//-------------------------------------------------------------------------

Error IServiceFilterInstance::sendOpen(ServicePipe &target,
                                       Entry &object) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->sendOpen(target, object);
}

Error IServiceFilterInstance::sendTag(ServicePipe &target,
                                      const TAG *pTag) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->sendTag(target, pTag);
}

Error IServiceFilterInstance::sendTagBeginObject(ServicePipe &target) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Write an object beginls
    auto objectBegin = TAG_OBJECT_BEGIN();
    objectBegin.setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

    // Write it
    return sendTag(target, &objectBegin);
};

Error IServiceFilterInstance::sendTagMetadata(ServicePipe &target,
                                              json::Value &metadata) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (auto ccode = getTagBuffer(&pTagBuffer)) return ccode;

    // Stringify the json object
    auto metadataString = metadata.stringify(true);

    // Build the tag
    const auto pMetadata =
        TAG_OBJECT_METADATA::build(pTagBuffer, &metadataString)
            ->setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

    // Write it
    return sendTag(target, pMetadata);
};

Error IServiceFilterInstance::sendTagBeginStream(ServicePipe &target) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (auto ccode = getTagBuffer(&pTagBuffer)) return ccode;

    // Setup the default stream begin tag
    const auto pStreamBeginTag = TAG_OBJECT_STREAM_BEGIN::build(
        pTagBuffer, TAG_OBJECT_STREAM_BEGIN::STREAM_TYPE::STREAM_DATA);

    // Save the size and offset
    pStreamBeginTag->data.streamSize = 0;
    pStreamBeginTag->data.streamOffset = 0;

    // Write it
    return sendTag(target, pStreamBeginTag);
}

Error IServiceFilterInstance::sendTagData(ServicePipe &target, size_t size,
                                          const void *pData) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Get the internal tag buffer
    TAG *pTagBuffer;
    if (auto ccode = getTagBuffer(&pTagBuffer)) return ccode;

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
        if (auto ccode = sendTag(target, pDataTag)) return ccode;

        // if failed with completion code -> return success preserving
        // completion code
        if (currentEntry->completionCode()) return {};

        // Update the positions
        offset += chunk;
        size -= chunk;
    }

    return {};
}

Error IServiceFilterInstance::sendTagEndStream(ServicePipe &target) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Create the tag
    const auto streamEndTag = TAG_OBJECT_STREAM_END();

    // Write the stream end tag
    return sendTag(target, &streamEndTag);
};

Error IServiceFilterInstance::sendTagEndObject(ServicePipe &target,
                                               Error completionCode) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Write an object end
    auto objectEnd = TAG_OBJECT_END(completionCode);
    objectEnd.setAttributes(TAG_ATTRIBUTES::INSTANCE_DATA);

    return sendTag(target, &objectEnd);
}

Error IServiceFilterInstance::sendText(ServicePipe &target,
                                       const Utf16View &text) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendText(target, text);
}

Error IServiceFilterInstance::sendTable(ServicePipe &target,
                                        const Utf16View &text) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendTable(target, text);
}

Error IServiceFilterInstance::sendWords(ServicePipe &target,
                                        const WordVector &textWords) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendWords(target, textWords);
}

Error IServiceFilterInstance::sendAudio(
    ServicePipe &target, const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendAudio(target, action, mimeType, streamData);
}

Error IServiceFilterInstance::sendVideo(
    ServicePipe &target, const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendVideo(target, action, mimeType, streamData);
}

Error IServiceFilterInstance::sendImage(
    ServicePipe &target, const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendImage(target, action, mimeType, streamData);
}

Error IServiceFilterInstance::sendQuestions(
    ServicePipe &target, const pybind11::object &question) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendQuestions(target, question);
}

Error IServiceFilterInstance::sendAnswers(
    ServicePipe &target, const pybind11::object &answers) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendAnswers(target, answers);
}

Error IServiceFilterInstance::sendClassifications(
    ServicePipe &target, const json::Value &classifications,
    const json::Value &classificationsPolicies,
    const json::Value &classificationsRules) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendClassifications(
        target, classifications, classificationsPolicies, classificationsRules);
}

Error IServiceFilterInstance::sendClassificationContext(
    ServicePipe &target, const json::Value &classifications) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendClassificationContext(target, classifications);
}

Error IServiceFilterInstance::sendDocuments(
    ServicePipe &target, const pybind11::object &documents) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->sendDocuments(target, documents);
}

uint32_t IServiceFilterInstance::getThreadCount(
    uint32_t currentThreadCount) const noexcept {
    // By default, just return the current thread count
    return pDown->getThreadCount(currentThreadCount);
}

Error IServiceFilterInstance::renderObject(ServicePipe &target,
                                           Entry &object) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    // Send it along
    return pDown->renderObject(target, object);
}

Error IServiceFilterInstance::checkChanged(Entry &object) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->checkChanged(object);
}

Error IServiceFilterInstance::getPermissions(Entry &entry) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->getPermissions(entry);
}

ErrorOr<size_t> IServiceFilterInstance::getPermissions(
    std::vector<Entry> &entries) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->getPermissions(entries);
}

Error IServiceFilterInstance::prepareObject(Entry &entry) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->prepareObject(entry);
}

Error IServiceFilterInstance::checkPermissions(Entry &object) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    preprocessPermissions(object);

    // Get permissions
    if (auto ccode = pDown->getPermissions(object)) return ccode;

    return {};
}

ErrorOr<size_t> IServiceFilterInstance::checkPermissions(
    std::vector<Entry> &entries) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    for (auto &entry : entries) {
        preprocessPermissions(entry);
    }

    return pDown->getPermissions(entries);
}

ErrorOr<bool> IServiceFilterInstance::stat(Entry &entry) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->stat(entry);
}

ErrorOr<std::list<Text>> IServiceFilterInstance::outputPermissions() noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->outputPermissions();
}

Error IServiceFilterInstance::sendClose(ServicePipe &target) noexcept {
    // Check the mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        return APERR(Ec::InvalidParam, "This function requires source mode");

    return pDown->sendClose(target);
}

//-------------------------------------------------------------------------
// Private methods
//-------------------------------------------------------------------------
void IServiceFilterInstance::preprocessPermissions(Entry &object) noexcept {
    // Defaut to no change
    object.changed(false);

    // Check if we already have stored permissions
    auto storedPerms = _fjc<perms::PermissionSet>(object.permissions.get());
    if (storedPerms.hasCcode()) object.changed(true);
}
}  // namespace engine::store

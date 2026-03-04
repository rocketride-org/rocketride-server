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
// These are callbacks from python. If the endpoint is in target mode,
// we forward off to the next binder. If we are in source mode, we call
// the target pipe
//-------------------------------------------------------------------------
void IServiceFilterInstance::cb_sendOpen(Entry &object) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendOpen");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendOpen(*m_pTarget, object)) throw ccode;
    }
}

void IServiceFilterInstance::cb_sendTagMetadata(py::dict &metadata) noexcept(
    false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendTagMetadata");

    // Make sure we have not written our metadata
    if (m_metadataWritten)
        throw APERR(Ec::InvalidCommand, "Metadata has already been written");

    // Get the metadata passed into a json
    auto value = engine::python::pyjson::dictToJson(metadata);

    // Merge it into the metdata values
    const auto members = value.getMemberNames();
    for (const auto &member : members) m_metadata[member] = value[member];

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        // Write it
        if (auto ccode = sendTagMetadata(*m_pTarget, m_metadata)) throw ccode;
    }
}

void IServiceFilterInstance::cb_sendTagBeginObject() noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendTagBeginObject");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        // Write it
        if (auto ccode = sendTagBeginObject(*m_pTarget)) throw ccode;
    }
};

void IServiceFilterInstance::cb_sendTagBeginStream() noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendTagBeginStream");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        // Write it
        if (auto ccode = sendTagBeginStream(*m_pTarget)) throw ccode;
    }
};

void IServiceFilterInstance::cb_sendTagData(py::object &data) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendTagData");

    // Send it
    const auto send = localfcn(size_t size, const void *pData) {
        // Unlock python and sent it along
        engine::python::UnlockPython unlock;

        // Send the data, throw an error if it fails
        if (auto ccode = sendTagData(*m_pTarget, size, pData)) throw ccode;
    };

    // @@HACK We should not be looking at metadata. The python driver should
    // be written correctly so it sets these in the current entry structure.
    // This also makes the assumption that the sendTagMetadata will be called
    // before any calls to sendTagData, which is essentially incorrect and not a
    // requirement of a drive to do
    // Send the metadata if we need to
    if (!m_metadataWritten) {
        // Unlock python and sent it along
        engine::python::UnlockPython unlock;

        if (auto ccode = sendTagMetadata(*m_pTarget, m_metadata)) throw ccode;

        if (currentEntry->objectFailed()) return;

        // Update current object with metadata
        if (m_metadata.isMember("accessTime"))
            currentEntry->accessTime(m_metadata["accessTime"].asInt64());
        if (m_metadata.isMember("createTime"))
            currentEntry->createTime(m_metadata["createTime"].asInt64());
        if (m_metadata.isMember("changeTime"))
            currentEntry->changeTime(m_metadata["changeTime"].asInt64());
        if (m_metadata.isMember("modifyTime"))
            currentEntry->modifyTime(m_metadata["modifyTime"].asInt64());
        if (m_metadata.isMember("size"))
            currentEntry->size(m_metadata["size"].asInt64());
        if (m_metadata.isMember("size"))
            currentEntry->storeSize(m_metadata["size"].asInt64());
        // all that is inside `metadata` JSON node - is assigned to the
        // `metadata` field of current entry
        if (m_metadata.isMember("metadata") &&
            m_metadata["metadata"].isObject())
            currentEntry->metadata(m_metadata["metadata"]);

        m_metadataWritten = true;
    }

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

    throw APERR(Ec::InvalidParam, "Invalid sendTagData type");
}

void IServiceFilterInstance::cb_sendText(const std::u16string &text) noexcept(
    false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendText");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendText(*m_pTarget, text)) throw ccode;
    }
}

void IServiceFilterInstance::cb_sendTable(const std::u16string &text) noexcept(
    false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendTable");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendTable(*m_pTarget, text)) throw ccode;
    }
}

void IServiceFilterInstance::cb_sendAudio(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendAudio");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendAudio(*m_pTarget, action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_sendVideo(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendVideo");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendVideo(*m_pTarget, action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_sendImage(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendImage");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendImage(*m_pTarget, action, mimeType, streamData))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_sendQuestions(
    const pybind11::object &question) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendQuestions");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendQuestions(*m_pTarget, question)) throw ccode;
    }
}

void IServiceFilterInstance::cb_sendAnswers(
    const pybind11::object &answers) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendAnswers");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendAnswers(*m_pTarget, answers)) throw ccode;
    }
}

void IServiceFilterInstance::cb_sendClassifications(
    const json::Value &classifications,
    const json::Value &classificationsPolicies,
    const json::Value &classificationsRules) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendClassifications");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendClassifications(*m_pTarget, classifications,
                                             classificationsPolicies,
                                             classificationsRules))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_sendClassificationContext(
    const json::Value &classifications) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(
            Ec::InvalidParam,
            "You must be in source mode to use sendClassificationContext");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendClassificationContext(*m_pTarget, classifications))
            throw ccode;
    }
}

void IServiceFilterInstance::cb_sendDocuments(
    const pybind11::object &documents) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendDocuments");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendDocuments(*m_pTarget, documents)) throw ccode;
    }
}

void IServiceFilterInstance::cb_sendTagEndStream() noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendTagEndStream");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        // Write it
        if (auto ccode = sendTagEndStream(*m_pTarget)) throw ccode;
    }
};

void IServiceFilterInstance::cb_sendTagEndObject() noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendTagEndObject");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        // Write it
        if (auto ccode =
                sendTagEndObject(*m_pTarget, currentEntry->completionCode()))
            throw ccode;
    }
};

void IServiceFilterInstance::cb_sendClose() noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use sendClose");

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        if (auto ccode = sendClose(*m_pTarget)) throw ccode;
    }
}

int IServiceFilterInstance::cb_addPermissions(
    py::dict &dict, bool throwOnError) noexcept(false) {
    //
    // NOTE: This does not unlock python so make it quick!!!
    //

    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use addPermissions");

    // Get the permissions passed into a json
    auto perms = engine::python::pyjson::dictToJson(dict);

    perms::PermissionSet permissionSet;
    Error err = _fja(perms, permissionSet);
    if (err.code()) {
        LOGT(err.message());
        if (throwOnError) throw err;
        return -1;
    }

    // Unlock python and sent it along
    _block() {
        engine::python::UnlockPython unlock;

        return endpoint->permissionInfo.add(_mv(permissionSet));
    }
}

bool IServiceFilterInstance::cb_addUserGroupInfo(
    bool isUser, py::object &id, py::object &authority, py::object &name,
    py::object &local,
    py::object groupMembers /* = py::none() */) noexcept(false) {
    //
    // NOTE: This does not unlock python so make it quick!!!
    //

    bool status = false;

    // Check to make sure source mode
    if (endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use addUserGroupInfo");

    do {
        const auto convertToString =
            [&](TextView what, py::object &pythonObject, auto &result) -> bool {
            if (!py::isinstance<py::str>(pythonObject)) {
                LOGT(what, "is of type",
                     py::cast<std::string>(py::str(pythonObject.get_type())),
                     "while string is expected");
                return false;
            }
            result = py::cast<std::string>(pythonObject);
            return true;
        };

        const auto convertToBool = [&](TextView what, py::object &pythonObject,
                                       bool &result) -> bool {
            if (!py::isinstance<py::bool_>(pythonObject)) {
                LOGT(what, "is of type",
                     py::cast<std::string>(py::str(pythonObject.get_type())),
                     "while boolean is expected");
                return false;
            }
            result = py::cast<bool>(pythonObject);
            return true;
        };

        Text idValue;
#if ROCKETRIDE_PLAT_WIN
        Utf16 authorityValue, nameValue;
#else
        Text authorityValue, nameValue;
#endif
        if (!convertToString("Id", id, idValue) ||
            !convertToString("Authority", authority, authorityValue) ||
            !convertToString("Name", name, nameValue))
            break;

        bool localValue;
        if (!convertToBool("Local", local, localValue)) break;

        std::vector<Text> memberIds;
        if (!isUser) {
            if (!groupMembers.is_none()) {
                // process only when parameter is specified
                try {
                    py::list py_list = groupMembers.cast<py::list>();
                    std::vector<std::string> mids =
                        py_list.cast<std::vector<std::string>>();
                    std::transform(
                        mids.begin(), mids.end(), std::back_inserter(memberIds),
                        [](const std::string &s) { return Text(s); });
                } catch (const py::cast_error &e) {
                    MONERR(warning, Ec::Warning,
                           "Could not process group members, using empty group "
                           "members list",
                           e.what());
                }
            }
        }

        // Unlock python and sent it along
        _block() {
            engine::python::UnlockPython unlock;

            if (isUser) {
                perms::UserRecord userRecord{
                    .id = idValue,
                    .local = localValue,
                    .authority = authorityValue,
                    .name = nameValue,
                };
                endpoint->permissionInfo.add(userRecord);
            } else {
                perms::GroupRecord groupRecord{
                    .id = idValue,
                    .local = localValue,
                    .authority = authorityValue,
                    .name = nameValue,
                    .memberIds = memberIds,
                };
                endpoint->permissionInfo.add(groupRecord);
            }

            // Set the status
            status = true;
        }
    } while (false);

    // Return the status
    return status;
}

bool IServiceFilterInstance::cb_addUserInfo(py::object &id,
                                            py::object &authority,
                                            py::object &name,
                                            py::object &local) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use addUserInfo");

    return cb_addUserGroupInfo(true, id, authority, name, local);
}

bool IServiceFilterInstance::cb_addGroupInfo(
    py::object &id, py::object &authority, py::object &name, py::object &local,
    py::object groupMembers /* = py::none() */) noexcept(false) {
    // Check to make sure source mode
    if (this->endpoint->config.endpointMode != ENDPOINT_MODE::SOURCE)
        throw APERR(Ec::InvalidParam,
                    "You must be in source mode to use addGroupInfo");

    return cb_addUserGroupInfo(false, id, authority, name, local, groupMembers);
}

}  // namespace engine::store

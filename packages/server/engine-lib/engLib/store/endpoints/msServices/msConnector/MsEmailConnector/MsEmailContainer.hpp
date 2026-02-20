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

namespace engine::store::filter::msNode::msEmailContainer {

using namespace utility;
using namespace web::http;
using namespace web::http::client;
using namespace engine::store::filter::msNode;

static const Text PROPERTY_ID_FOR_SIZE("Long 0xe08");

class MsEmailContainer : public MsContainer {
public:
    MsEmailContainer() noexcept;
    ~MsEmailContainer() noexcept;
    MsEmailContainer(const MsEmailContainer&) noexcept;
    MsEmailContainer(MsEmailContainer&&) noexcept;

    //---------------------------------------------------------------------
    /// @details
    ///        Processes a MsContainer to the list of folder Entry
    ///    @param[in]  msContainer
    ///        The msContainer containing folders
    ///    @returns
    ///        list of folder entry
    //---------------------------------------------------------------------
    static ErrorOr<Entry> getFolderEntry(web::json::value value) noexcept {
        Entry entry;
        entry.reset();
        entry.operation("A");
        entry.isContainer(true);
        if (value.has_field(U_STRING_T("displayName"))) {
            entry.name(value[U_STRING_T("displayName")].as_string());
        } else
            return MONERR(warning, Ec::InvalidJson, "Value is not valid");

        entry.uniqueName(value[U_STRING_T("id")].as_string());

        Text parentId = Text(value[U_STRING_T("parentFolderId")].as_string());

        entry.parentUniqueName(parentId);
        return entry;
    }

    //---------------------------------------------------------------------
    /// @details
    ///        Processes a MsContainer to the list of Entry
    ///    @param[in]  msContainer
    ///        The msContainer containing emails or folders
    ///    @param[in]   url
    ///        The url of the parent
    ///    @param[in]    parentId
    ///        The id of the parent
    ///    @returns
    ///        list of entry
    //---------------------------------------------------------------------
    static std::list<Entry> getEntries(MsContainer msContainer,
                                       const Entry& rootEntry = Entry(),
                                       Text url = Text(),
                                       Text parentId = Text()) noexcept {
        std::list<Entry> m_entries;

        // set sync type
        auto syncType = msContainer.isDelta() ? Entry::SyncScanType::DELTA
                                              : Entry::SyncScanType::FULL;

        for (auto values : msContainer.getValues()) {
            for (auto value : values) {
                Entry entry;
                entry.reset();
                entry.operation("A");
                Text parentIdvalue;

                // Value has parentFolderId
                if (value.has_field(U_STRING_T("parentFolderId"))) {
                    Text tempParentId =
                        value[U_STRING_T("parentFolderId")].as_string();
                    // root entry name is changed to site id, so set site id as
                    // parentId for its children
                    if (tempParentId == rootEntry.uniqueName())
                        parentIdvalue = parentId;
                    else
                        parentIdvalue =
                            value[U_STRING_T("parentFolderId")].as_string();
                } else
                    parentIdvalue = parentId;

                entry.parentUniqueName(parentIdvalue);

                // Value is deleted
                if (value.has_field(U_STRING_T("@removed"))) {
                    entry.isContainer(false);
                    entry.uniqueName(value[U_STRING_T("id")].as_string());
                    entry.operation("D");
                }  // Folder entry
                else if (value.has_field(U_STRING_T("childFolderCount"))) {
                    entry.isContainer(true);
                    entry.name(value[U_STRING_T("displayName")].as_string());
                    entry.uniqueName(value[U_STRING_T("id")].as_string());

                    // Got parent back, add the sync type
                    if (entry.uniqueName() == parentId)
                        entry.syncScanType(syncType);
                } else {
                    // Email entry
                    entry.isContainer(false);

                    Text name(value[U_STRING_T("subject")].as_string());
                    Text forbidden("*?><|/\\:\"");
                    for (TextChr& c : name) {
                        if (forbidden.contains(c)) {
                            c = '_';
                        }
                    }

                    // set UUID as name
                    Text emailId(value[U_STRING_T("id")].as_string());
                    entry.uniqueName(emailId);

                    // get crc32 to make the email display name unique
                    // we can append id, as it is unique but this id is long 64
                    // chars and crc32 is 8 chars for export we need a unique
                    // name, else same subject emails will override each other
                    const auto data =
                        memory::viewCast<uint8_t>(emailId.toView());
                    auto output = crypto::crc32(data);
                    Text uniqueId = _tso(Format::HEX | Format::FILL, output);

                    // append eml as the extension since email will be rendered
                    // in eml format no subject line do not append -
                    if (name.empty())
                        entry.name(_ts(uniqueId, ".eml"));
                    else
                        entry.name(_ts(name, "-", uniqueId, ".eml"));

                    // set the url so that it is picked by included logic
                    time_t createTime = convertFromGraphAPIDateTime(
                        utility::datetime::from_string(
                            value[U_STRING_T("createdDateTime")].as_string(),
                            utility::datetime::date_format::ISO_8601));
                    entry.createTime(createTime);
                    time_t modifyTime = convertFromGraphAPIDateTime(
                        utility::datetime::from_string(
                            value[U_STRING_T("lastModifiedDateTime")]
                                .as_string(),
                            utility::datetime::date_format::ISO_8601));
                    entry.modifyTime(modifyTime);
                    time_t accessTime = convertFromGraphAPIDateTime(
                        utility::datetime::from_string(
                            value[U_STRING_T("sentDateTime")].as_string(),
                            utility::datetime::date_format::ISO_8601));
                    entry.accessTime(accessTime);

                    // get the size of email, singleValueExtendedProperties
                    // provides different values from Exchange Server Protocols
                    // Master Property List, the id PROPERTY_ID_FOR_SIZE
                    // provides size
                    size_t sizeEntry = 0;
                    if (value.has_array_field(
                            U_STRING_T("singleValueExtendedProperties"))) {
                        for (auto fields :
                             value[U_STRING_T("singleValueExtendedProperties")]
                                 .as_array()) {
                            if (Text(fields[U_STRING_T("id")].as_string()) ==
                                PROPERTY_ID_FOR_SIZE) {
                                // size comes as string
                                sizeEntry = std::stoi(
                                    fields[U_STRING_T("value")].as_string());
                                break;
                            }
                        }
                    }
                    entry.size.set(sizeEntry);
                    entry.storeSize.set(sizeEntry);
                    entry.changeKey(_ts(modifyTime, ";", sizeEntry));
                }
                m_entries.push_back(entry);
            }
        }
        return m_entries;
    }
};
}  // namespace engine::store::filter::msNode::msEmailContainer
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

namespace engine::store::filter::msNode::msSharepointNode {
using namespace utility;
using namespace web::http;
using namespace web::http::client;
using namespace engine::store::filter::msNode;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceSharepoint;

using Path = ap::file::Path;
using ScanAddObject = std::function<Error(Entry &)>;
// Max retries
static const unsigned short int SHAREPOINT_MAX_RETRIES = 10;

// SiteName Position
static const unsigned short int SITENAME_POS = 0;

static const unsigned short int DRIVE_POS = 1;

// Filepath starting Position
static const unsigned short int FILE_PATH_POS = 2;

// SiteId Position
static const unsigned short int SITEID_POS = 0;

// FileId  Position
static const unsigned short int FILE_ID_POS = 1;

//-----------------------------------------------------------------
///	@details
///		Default size of the single part at multipart download
//-----------------------------------------------------------------
static const auto SharePointDownloadDefaultPartSize = 50_mb;

// delta key
static const Text DELTA_KEY_SHAREPOINT = "token=";

struct SiteInfo {
    Text siteId;
    Text siteName;
};

struct DriveInfo {
    Text driveId;
    Text driveName;
};

//-------------------------------------------------------------------------
// Define sharepoint configuration info
//-------------------------------------------------------------------------

struct SharePointCppConfig : public MsConfig {
    SharePointCppConfig() : MsConfig() {}

    //---------------------------------------------------------------------
    /// @details
    ///		Parse the service information from the given json
    ///	@param[in]	serviceConfig
    ///		json to parse from
    ///	@param[out]	outlookConfig
    ///		configuration object to set
    ///	@returns
    //---------------------------------------------------------------------
    static Error __fromJson(engine::store::IServiceConfig &serviceConfig,
                            std::shared_ptr<MsConfig> msConfig) noexcept {
        if (auto ccode = serviceConfig.parameters.lookupAssign(
                             "tenant", msConfig->m_tenantId) ||
                         serviceConfig.parameters.lookupAssign(
                             "clientId", msConfig->m_clientId) ||
                         serviceConfig.parameters.lookupAssign(
                             "clientSecret", msConfig->m_clientSecret))
            return ccode;

        if (!msConfig->m_clientId)
            return APERR(Ec::InvalidParam, "Missing required clientId");
        if (!msConfig->m_clientSecret)
            return APERR(Ec::InvalidParam, "Missing required clientSecret");
        if (!msConfig->m_tenantId)
            return APERR(Ec::InvalidParam, "Missing required tenantId");

        // Done
        return {};
    }
};

class MsSharepointNode : public MsNode {
    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

public:
    MsSharepointNode();
    MsSharepointNode(std::shared_ptr<MsConfig> msConfig);
    virtual ~MsSharepointNode();

    Error setConfig(engine::store::IServiceConfig &serviceConfig) noexcept;
    Error createConnection() noexcept;
    ErrorOr<Text> getUploadSession(const Entry *entry, const Text &siteId,
                                   const file::Path &filePath) noexcept;
    Error uploadFile(const Entry *entry, const Text &siteId,
                     const file::Path &filePath,
                     memory::Data<Byte> &body) noexcept;
    ErrorOr<std::vector<unsigned char>> downloadFile(
        const file::Path &filePath) noexcept;
    ErrorOr<Text> getDownloadUrl(const Entry &entry) noexcept;
    ErrorOr<std::vector<unsigned char>> downloadInChunksFile(
        const Text &url) noexcept;
    Error uploadFileInParts(const Text &Url, memory::Data<Byte> &body) noexcept;
    ErrorOr<Text> getSiteId(const Text &siteName) noexcept;
    ErrorOr<Text> getDriveRoot(const Text &siteId,
                               const Text &driveId) noexcept;
    ErrorOr<const std::list<Text>> getItemIds(const file::Path &filePath,
                                              const Text &startsWith) noexcept;
    Error deleteFileWithId(const Text &siteId, const Text &id) noexcept;
    void setTotalSize(const size_t &totalSize) noexcept;
    const size_t &getPartUploaded() const noexcept;
    void clearSizes() noexcept;
    Error getItems(const Path &path, const ScanAddObject &callback,
                   const msNode::SetSyncTokenCallBack &,
                   const msNode::GetSyncTokenCallBack &) noexcept;
    Error getItemsAndFolders(std::list<Entry> &entries,
                             const DriveInfo &driveInfo, const Path &path,
                             const Text &siteId, const ScanAddObject &callback,
                             const msNode::SetSyncTokenCallBack &,
                             const msNode::GetSyncTokenCallBack &) noexcept;
    Error getAllSitesAndItems(const ScanAddObject &callback,
                              const msNode::SetSyncTokenCallBack &,
                              const msNode::GetSyncTokenCallBack &) noexcept;
    ErrorOr<Entry> getMetaData(const Text &userId,
                               const Text &messageId) noexcept;
    ErrorOr<Text> getItemPath(const Text &siteId, const Text &driveId,
                              const Text &messageId) noexcept;
    Error deleteItem(const Entry &object) noexcept;
    ErrorOr<Entry> getMetaDataUsingPath(const Text &siteId,
                                        const Text &itemPath) noexcept;
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
    static std::list<Entry> getEntries(
        MsContainer &msContainer, const Text &rootId = Text(),
        Text url = Text(), Text parentId = Text(), Text itemId = Text(),
        Entry::SyncScanType scanType = Entry::SyncScanType::FULL) noexcept {
        std::list<Entry> m_entries;
        for (auto values : msContainer.getValues()) {
            for (auto value : values) {
                Entry entry;
                entry.reset();
                entry.operation.set(Entry::OPERATION::ADD);

                // get parentid
                web::json::value parentIdObject = web::json::value::object();
                if (value.has_field(U_STRING_T("parentReference")))
                    parentIdObject = value[U_STRING_T("parentReference")];
                Text entryUrl;
                if (value.has_field(U_STRING_T("url"))) {
                    entryUrl = value[U_STRING_T("url")].as_string();
                } else {
                    if (parentIdObject.has_field(U_STRING_T("path"))) {
                        Text tempUrl =
                            parentIdObject[U_STRING_T("path")].as_string();
                        auto pos = tempUrl.find(":");
                        // set the path as url, so that it is picked up by scan
                        if (pos == tempUrl.length() - 1)
                            entryUrl = url;
                        else
                            entryUrl = url + tempUrl.substr(pos + 1);
                    }
                }

                Text parentIdvalue;
                if (value.has_field(U_STRING_T("parentFolderId"))) {
                    parentIdvalue =
                        value[U_STRING_T("parentFolderId")].as_string();
                } else if (parentIdObject.has_field(U_STRING_T("id")))
                    parentIdvalue =
                        parentIdObject[U_STRING_T("id")].as_string();
                else
                    parentIdvalue = parentId;

                // change parentId if parent is root
                if (parentIdvalue == rootId) parentIdvalue = parentId;

                entry.parentUniqueName(parentIdvalue);

                // entry deleted
                if (value.has_field(U_STRING_T("deleted"))) {
                    entry.isContainer(false);
                    entry.uniqueName(value[U_STRING_T("id")].as_string());

                    entry.operation("D");
                }  // Folder entry
                else if (value.has_field(U_STRING_T("folder"))) {
                    entry.isContainer(true);
                    entry.name(value[U_STRING_T("name")].as_string());
                    entry.uniqueName(value[U_STRING_T("id")].as_string());
                    // do not add root
                    if (rootId == entry.uniqueName()) continue;
                    if (itemId && entry.uniqueName() == itemId)
                        entry.syncScanType.set(scanType);
                } else {
                    entry.isContainer(false);

                    Text name(value[U_STRING_T("name")].as_string());
                    Text forbidden("*?><|/\\:\"");
                    for (TextChr &c : name) {
                        if (forbidden.contains(c)) {
                            c = '_';
                        }
                    }
                    entry.name(name);
                    entry.uniqueName(value[U_STRING_T("id")].as_string());
                    time_t createTime =
                        MsContainer::convertFromGraphAPIDateTime(
                            utility::datetime::from_string(
                                value[U_STRING_T("createdDateTime")]
                                    .as_string(),
                                utility::datetime::date_format::ISO_8601));
                    entry.createTime(createTime);
                    time_t modifyTime =
                        MsContainer::convertFromGraphAPIDateTime(
                            utility::datetime::from_string(
                                value[U_STRING_T("lastModifiedDateTime")]
                                    .as_string(),
                                utility::datetime::date_format::ISO_8601));
                    entry.modifyTime(modifyTime);

                    auto sizeEntry = value[U_STRING_T("size")].as_number();
                    size_t sizeT = sizeEntry.to_uint64();
                    entry.size.set(sizeT);
                    entry.storeSize.set(sizeT);

                    auto &file_value = value[U_STRING_T("file")];
                    entry.changeKey(
                        file_value.has_object_field(U_STRING_T("hashes")) &&
                                file_value[U_STRING_T("hashes")]
                                    .has_string_field(
                                        U_STRING_T("quickXorHash"))
                            ? _ts(file_value[U_STRING_T("hashes")]
                                            [U_STRING_T("quickXorHash")]
                                                .as_string()
                                                .c_str())
                            : _ts(modifyTime, ";", sizeT));
                }
                m_entries.push_back(entry);
            }
        }
        return m_entries;
    }

private:
    Error getSiteIdAndPath(const file::Path &filePath, Text &path,
                           Text &siteId) noexcept;
    Text findSiteId(web::json::value &value, const Text &siteName) noexcept;
    ErrorOr<const std::list<SiteInfo>> getAllSites() noexcept;
    ErrorOr<const std::list<DriveInfo>> getAllDrives(const Text &) noexcept;
    ErrorOr<MsContainer> getItems(const Text &siteId, const Text &driveId,
                                  const Text &path,
                                  const ScanCallBack &callback,
                                  const Text &syncToken) noexcept;
    ErrorOr<Entry> getRootInfo(const Text &siteId, const DriveInfo &drive,
                               const Path &path) noexcept;
    ErrorOr<Entry> getSiteEntry(const Text &siteId,
                                const Text &siteName) noexcept;
    ErrorOr<Entry> getDriveInfo(const Text &siteId,
                                const DriveInfo &drive) noexcept;
    ErrorOr<Text> getItemId(const Text &siteId, const DriveInfo &drive,
                            const Path &path) noexcept;
    Error getParents(const Text &siteId, const DriveInfo &drive,
                     const Text &pathId, const Path &path,
                     MsContainer &parentsContainer) noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		start of byte
    //-----------------------------------------------------------------
    size_t m_startOfByte;

    //-----------------------------------------------------------------
    ///	@details
    ///		end of byte
    //-----------------------------------------------------------------
    size_t m_endOfByte;

    //-----------------------------------------------------------------
    ///	@details
    ///		end of byte
    //-----------------------------------------------------------------
    size_t m_totalSize;
};
}  // namespace engine::store::filter::msNode::msSharepointNode
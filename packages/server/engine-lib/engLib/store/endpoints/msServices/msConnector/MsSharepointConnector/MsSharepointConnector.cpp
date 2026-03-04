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

namespace engine::store::filter::msNode::msSharepointNode {
MsSharepointNode::MsSharepointNode() : MsNode() {}

MsSharepointNode::MsSharepointNode(std::shared_ptr<MsConfig> msConfig)
    : MsNode(msConfig, nullptr) {}

MsSharepointNode::~MsSharepointNode() {}

//-----------------------------------------------------------------
/// @details
///		This function is to create connection to MS
///	@returns
///		creates a connection or Error
//-----------------------------------------------------------------
Error MsSharepointNode::createConnection() noexcept {
    if (auto ccode = requestToken()) return ccode;
    return {};
}

//------------------------------------------------------------------
/// @details
///		Get upload Session for file upload
///	@param[in]	filePath
///		Path to the file
///	@returns
///		Upload session url
//------------------------------------------------------------------
ErrorOr<Text> MsSharepointNode::getUploadSession(
    const Entry *entry, const Text &siteId,
    const file::Path &filePath) noexcept {
    Text encodedPath;
    if (siteId.empty())
        return MONERR(warning, Ec::Warning, "Site id not found");

    // Get the file path, path format "/siteName/filepath"
    file::Path filePathUpload = filePath.subpth(FILE_PATH_POS);
    encodedPath = urlEncode(filePathUpload.str(), true);

    utility::string_t uploadUrl =
        utility::string_t() +
        U_STRING_T(Text("sites/" + siteId + "/drive/root:/" + encodedPath +
                        ":/createUploadSession"));
    http_headers header;
    header.set_content_type(U_STRING_T("application/json"));
    web::json::value body;
    web::json::value item;
    web::json::value fileSystemInfo;
    item[U_STRING_T("@microsoft.graph.conflictBehavior")] =
        web::json::value::string(U_STRING_T("replace"));
    item[U_STRING_T("name")] =
        web::json::value::string(U_STRING_T(Text(filePath.fileName())));
    fileSystemInfo[U_STRING_T("lastModifiedDateTime")] =
        web::json::value::string(U_STRING_T(ap::time::formatDateTime(
            entry->modifyTime.get(), ap::time::ISO_8601_DATE_TIME_FMT)));
    fileSystemInfo[U_STRING_T("createdDateTime")] =
        web::json::value::string(U_STRING_T(ap::time::formatDateTime(
            entry->createTime.get(), ap::time::ISO_8601_DATE_TIME_FMT)));
    item[U_STRING_T("fileSystemInfo")] = fileSystemInfo;
    body[U_STRING_T("item")] = item;

    http_response response;
    const RequestCallBack requestCallBack =
        [this, &uploadUrl, &body, &header]() -> ErrorOr<const http_response> {
        return request(methods::POST, uploadUrl, body, header);
        ;
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not uploaded");
    response = ccode.value();

    web::json::value values = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    if (!hasField(values, "uploadUrl"))
        return MONERR(warning, Ec::Warning, "request failed to upload");

    return getValue(values, "uploadUrl").as_string();
}

//------------------------------------------------------------------
/// @details
///		upload a file at filePath
///	@param[in]	filePath
///		Path to the file
///	@param[in]	body
///		content of the file
///	@returns
///		Error
//------------------------------------------------------------------
Error MsSharepointNode::uploadFile(const Entry *entry, const Text &siteId,
                                   const file::Path &filePath,
                                   memory::Data<Byte> &body) noexcept {
    Text encodedPath;
    if (siteId.empty())
        return MONERR(warning, Ec::Warning, "Site id not found");

    // Get the file path, path format "/siteName/filepath"
    file::Path filePathUpload = filePath.subpth(FILE_PATH_POS);
    encodedPath = urlEncode(filePathUpload.str(), true);

    utility::string_t batchUrl = utility::string_t() + U_STRING_T("$batch");

    http_headers header;
    header.set_content_type(U_STRING_T("application/json"));
    header.add(U_STRING_T("Accept"), U_STRING_T("application/json"));

    // use batch api to batch put for upload file and patch to set modify time
    web::json::value batchBody = web::json::value::array();
    web::json::value putRequest;
    putRequest[U_STRING_T("id")] = web::json::value::string(U_STRING_T("1"));
    putRequest[U_STRING_T("method")] =
        web::json::value::string(U_STRING_T("PUT"));
    putRequest[U_STRING_T("url")] = web::json::value::string(U_STRING_T(
        Text("sites/" + siteId + "/drive/root:/" + encodedPath + ":/content")));
    putRequest[U_STRING_T("body")] = web::json::value::string(
        U_STRING_T(ap::crypto::base64Encode(body.toTextView())));
    web::json::value putHeader;
    putHeader[U_STRING_T("Content-Type")] =
        web::json::value::string(U_STRING_T("application/octet-stream"));
    putRequest[U_STRING_T("headers")] = putHeader;
    batchBody[0] = putRequest;

    web::json::value patchRequest;
    patchRequest[U_STRING_T("id")] = web::json::value::string(U_STRING_T("2"));
    patchRequest[U_STRING_T("method")] =
        web::json::value::string(U_STRING_T("PATCH"));
    patchRequest[U_STRING_T("url")] = web::json::value::string(
        U_STRING_T(Text("sites/" + siteId + "/drive/root:/" + encodedPath)));
    web::json::value fileSystemInfo;
    fileSystemInfo[U_STRING_T("lastModifiedDateTime")] =
        web::json::value::string(U_STRING_T(ap::time::formatDateTime(
            entry->modifyTime.get(), ap::time::ISO_8601_DATE_TIME_FMT)));
    fileSystemInfo[U_STRING_T("createdDateTime")] =
        web::json::value::string(U_STRING_T(ap::time::formatDateTime(
            entry->createTime.get(), ap::time::ISO_8601_DATE_TIME_FMT)));
    web::json::value test;
    test[U_STRING_T("fileSystemInfo")] = fileSystemInfo;
    patchRequest[U_STRING_T("body")] = test;
    web::json::value patchHeader;
    patchHeader[U_STRING_T("Content-Type")] =
        web::json::value::string(U_STRING_T("application/json"));
    patchRequest[U_STRING_T("headers")] = patchHeader;
    web::json::value dependsOnArray = web::json::value::array();
    dependsOnArray[0] = web::json::value::string(U_STRING_T("1"));
    patchRequest[U_STRING_T("dependsOn")] = dependsOnArray;
    batchBody[1] = patchRequest;

    web::json::value requestJson;
    requestJson[U_STRING_T("requests")] = batchBody;

    http_response response;
    const RequestCallBack requestCallBack =
        [this, &batchUrl, &requestJson,
         &header]() -> ErrorOr<const http_response> {
        return request(methods::POST, batchUrl, requestJson, header);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODES_FOR_FILE_CREATED,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not uploaded");

    return {};
}

//------------------------------------------------------------------
/// @details
///		downloads a file at filePath
///	@param[in]	filePath
///		file to be downloaded
///	@returns
///		Content of the file
//------------------------------------------------------------------
ErrorOr<std::vector<unsigned char>> MsSharepointNode::downloadFile(
    const file::Path &filePath) noexcept {
    Text encodedPath;
    Text siteId;

    if (auto ccode = getSiteIdAndPath(filePath, encodedPath, siteId))
        return ccode;

    utility::string_t urlMessages =
        utility::string_t() +
        U_STRING_T(Text("sites/" + siteId + "/drive/root:/" + encodedPath +
                        ":/content"));
    http_headers header;
    header.set_content_type(U_STRING_T("text/plain"));
    http_response response;
    const RequestCallBack requestCallBack =
        [this, &urlMessages, &header]() -> ErrorOr<const http_response> {
        return request(methods::GET, urlMessages, header);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not uploaded");
    response = ccode.value();

    std::vector<unsigned char> vectorData =
        extract_data<std::vector<unsigned char>>(
            response, [](http_response &res) { return res.extract_vector(); });

    return vectorData;
}

//------------------------------------------------------------------
/// @details
///		downloads a file at filePath using chuncks
///	@param[in]	filePath
///		file to be downloaded
///	@returns
///		Content of the file
//------------------------------------------------------------------
ErrorOr<std::vector<unsigned char>> MsSharepointNode::downloadInChunksFile(
    const Text &url) noexcept {
    unsigned short int retries = 0;
    web::http::status_code statusCode;
    while (retries < SHAREPOINT_MAX_RETRIES) {
        http_client downloadClient(U_STRING_T(url));

        m_endOfByte = m_startOfByte + SharePointDownloadDefaultPartSize;
        m_endOfByte = m_endOfByte <= m_totalSize ? m_endOfByte : m_totalSize;

        // Response header : Range: bytes={start}-{end}
        http_headers header;
        header.add(U_STRING_T("Range"),
                   utility::string_t() + U_STRING_T("bytes=") +
                       U_STRING_T(std::to_string(m_startOfByte)) +
                       U_STRING_T("-") +
                       U_STRING_T(std::to_string(m_endOfByte - 1)));

        auto ccode = request(downloadClient, methods::GET, header);
        if (ccode.hasCcode()) return ccode.ccode();
        http_response response = ccode.value();
        statusCode = response.status_code();
        // response code can be 200 or 206
        if (!(statusCode == status_codes::OK ||
              statusCode == status_codes::PartialContent)) {
            retries++;
        } else {
            m_startOfByte = m_endOfByte;

            std::vector<unsigned char> data =
                extract_data<std::vector<unsigned char>>(
                    response,
                    [](http_response &res) { return res.extract_vector(); });

            return data;
        }
    }
    return APERR(Ec::Failed,
                 "Download of file failed with response:", statusCode);
}

//------------------------------------------------------------------
/// @details
///		downloads a file at filePath using chuncks
///	@param[in]	filePath
///		file to be downloaded
///	@returns
///		Content of the file
//------------------------------------------------------------------
ErrorOr<Text> MsSharepointNode::getDownloadUrl(const Entry &entry) noexcept {
    auto fullPath = entry.uniqueUrl().path();

    // Get the siteName, path format "/siteName/filepath"
    Text siteId = fullPath.at(SITENAME_POS);

    Text driveId = fullPath.at(DRIVE_POS);

    utility::string_t downloadUrl =
        utility::string_t() +
        U_STRING_T(Text("sites/") + siteId + "/drives/" + driveId + "/items/" +
                   entry.uniqueName() +
                   "?select=id,@microsoft.graph.downloadUrl");

    http_response response;
    const RequestCallBack requestCallBack =
        [this, &downloadUrl]() -> ErrorOr<const http_response> {
        return request(methods::GET, downloadUrl);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not uploaded");
    response = ccode.value();

    web::json::value data = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    if (data.has_field(U_STRING_T("@microsoft.graph.downloadUrl"))) {
        return data[U_STRING_T("@microsoft.graph.downloadUrl")].as_string();
    }
    return APERR(Ec::InvalidDocument, "Does not exists");
}

//------------------------------------------------------------------
/// @details
///		upload a file at filePath in parts
///		format
///		PUT URL
///		Content-Length: 26
///		Content-Range: bytes 0 - 25 / 128
///		< bytes 0 - 25 of the file >
///	@param[in]	url
///		Path to the file
///	@param[in]	body
///		content of the file
///	@returns
///		Error
//------------------------------------------------------------------
Error MsSharepointNode::uploadFileInParts(const Text &url,
                                          memory::Data<Byte> &body) noexcept {
    m_endOfByte += body.size();
    http_client uploadClient(U_STRING_T(url));
    http_headers header;
    header.add(U_STRING_T("Content-Range"),
               utility::string_t() + U_STRING_T("bytes ") +
                   U_STRING_T(std::to_string(m_startOfByte)) + U_STRING_T("-") +
                   U_STRING_T(std::to_string(m_endOfByte - 1)) +
                   U_STRING_T("/") + U_STRING_T(std::to_string(m_totalSize)));
    header.add(U_STRING_T("Content-Type"), U_STRING_T("text/plain"));

    http_response response;
    const RequestCallBack requestCallBack =
        [this, &uploadClient, &body,
         &header]() -> ErrorOr<const http_response> {
        return request(uploadClient, methods::PUT, body, header);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODES_FOR_FILE_CREATED,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not uploaded");

    m_startOfByte = m_endOfByte;
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function fetches children folders from a path
///	@param[in]	userId
///		The userId of the intended user
///	@param[in]	path
///		The path to fetch emails from
///	@param[in]	parentUrl
///		The parentUrl, to create URL
///	@returns
///		Error or childfolders
//-----------------------------------------------------------------
Error MsSharepointNode::setConfig(
    engine::store::IServiceConfig &serviceConfig) noexcept {
    if (auto ccode = SharePointCppConfig::__fromJson(serviceConfig, m_msConfig))
        return ccode;

    return {};
}

//-----------------------------------------------------------------
/// @details
///		get the site id, this is case insensitive
///	@param[in]	siteName
///		Display name of the site
///	@param[in]	body
///		content of the file
///	@returns
///		Error
//------------------------------------------------------------------
ErrorOr<Text> MsSharepointNode::getSiteId(const Text &siteName) noexcept {
    http_response response;

    const RequestCallBack requestCallBack =
        [this]() -> ErrorOr<const http_response> {
        return request(methods::GET,
                       Text("sites/?$select=id,displayName,name"));
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode()) return MONERR(warning, Ec::Warning, "Site id failed");

    response = ccode.value();

    web::json::value responseValues = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    if (!hasField(responseValues, "value")) {
        return MONERR(warning, Ec::Warning, "There are no sites");
    }
    web::json::array values = getValue(responseValues, "value").as_array();
    for (auto &value : values) {
        Text siteId = findSiteId(value, siteName);
        if (!siteId.empty()) return siteId;
    }
    while (hasField(responseValues, "@odata.nextLink")) {
        http_client tempClient(
            getValue(responseValues, "@odata.nextLink").as_string(),
            getHttpConfig());
        http_response responseNextLink;
        const RequestCallBack requestCallBackNextLink =
            [this, &tempClient]() -> ErrorOr<const http_response> {
            return request(tempClient, methods::GET);
        };

        auto ccode = requestWithCallBack(requestCallBackNextLink, CODE_FOR_OK,
                                         SHAREPOINT_MAX_RETRIES);
        if (ccode.hasCcode())
            return MONERR(warning, Ec::Warning, "Site id failed");

        response = ccode.value();

        web::json::value responseValues = extract_data<web::json::value>(
            response, [](http_response &res) { return res.extract_json(); });

        values = getValue(responseValues, "value").as_array();
        for (auto &value : values) {
            Text siteId = findSiteId(value, siteName);
            if (!siteId.empty()) return siteId;
        }
    }
    return MONERR(warning, Ec::Warning, "Site with name:", siteName,
                  " not found");
}

//-----------------------------------------------------------------
/// @details
///		get root of the site
///	@param[in]	siteId
///		Id of the site
///	@returns
///		Root id
//------------------------------------------------------------------
ErrorOr<Text> MsSharepointNode::getDriveRoot(const Text &siteId,
                                             const Text &driveId) noexcept {
    http_response response;
    const RequestCallBack requestCallBack =
        [this, &siteId, &driveId]() -> ErrorOr<const http_response> {
        return request(methods::GET, Text("sites/" + siteId + "/drives/" +
                                          driveId + "/root"));
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode()) return MONERR(warning, Ec::Warning, "Root not found");
    response = ccode.value();

    web::json::value values = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    if (!hasField(values, "id")) {
        return MONERR(warning, Ec::Warning, "Root does not exists for ",
                      siteId);
    }
    return getValue(values, "id").as_string();
}

//-----------------------------------------------------------------
/// @details
///		delete an item with a id
///	@param[in]	siteId
///		Id of the site
///	@param[in]	id
///		id of the file
///	@returns
///		Error
//------------------------------------------------------------------
Error MsSharepointNode::deleteFileWithId(const Text &siteId,
                                         const Text &id) noexcept {
    http_response response;
    const RequestCallBack requestCallBack =
        [this, &siteId, &id]() -> ErrorOr<const http_response> {
        return request(methods::DEL,
                       Text("sites/" + siteId + "/drive/items/" + id));
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_DELETED,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Item not deleted");

    return {};
}

//-----------------------------------------------------------------
/// @details
///		get all items that matches startswith
///	@param[in]	filePath
///		filePath of the file
///	@param[in]	startsWith
///		items startswith name
///	@returns
///		list of ids
//------------------------------------------------------------------
ErrorOr<const std::list<Text>> MsSharepointNode::getItemIds(
    const file::Path &filePath, const Text &startsWith) noexcept {
    std::list<Text> ids;

    // Get the file path, path format "/siteName/filepath"
    file::Path filePathIds = filePath.subpth(FILE_PATH_POS);
    Text encodedPath = urlEncode(filePathIds.str(), true);
    Text filter = Text("(name,'") + startsWith + "')";
    Text encodedFilter = urlEncode(filter, true);

    // Get the sitename, path format "/siteName/filepath"
    Text siteName = filePath.at(SITENAME_POS);
    auto siteIdCcode = getSiteId(siteName);
    if (siteIdCcode.hasCcode())
        return APERR(Ec::Failed, "Site not found", filePath.at(0));

    Text siteId = siteIdCcode.value();
    http_response response;

    const RequestCallBack requestCallBack =
        [this, &siteId, &encodedPath,
         &encodedFilter]() -> ErrorOr<const http_response> {
        return request(methods::GET,
                       Text("sites/" + siteId + "/drive/root:/" + encodedPath +
                            ":/children?$filter=startswith" + encodedFilter +
                            "&$select=id"));
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not found");
    response = ccode.value();

    web::json::value responseValues = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    if (!hasField(responseValues, "value")) {
        return APERR(Ec::Failed, "There are no sites");
    }

    web::json::array values = getValue(responseValues, "value").as_array();

    for (auto &value : values) {
        if (!hasField(value, "id")) {
            continue;
        }
        ids.push_back(getValue(value, "id").as_string());
    }

    while (hasField(responseValues, "@odata.nextLink")) {
        http_request requestNextLink(methods::GET);
        http_client tempClient(
            getValue(responseValues, "@odata.nextLink").as_string(),
            getHttpConfig());
        http_response responseNextLink;
        const RequestCallBack requestCallBackNextLink =
            [this, &tempClient]() -> ErrorOr<const http_response> {
            return request(tempClient, methods::GET);
        };

        auto ccode = requestWithCallBack(requestCallBackNextLink, CODE_FOR_OK,
                                         SHAREPOINT_MAX_RETRIES);
        if (ccode.hasCcode())
            return MONERR(warning, Ec::Warning, "Items not found");
        response = ccode.value();

        web::json::value responseValues = extract_data<web::json::value>(
            response, [](http_response &res) { return res.extract_json(); });

        values = getValue(responseValues, "value").as_array();
        for (auto &value : values) {
            if (!hasField(value, "id")) {
                continue;
            }
            ids.push_back(getValue(value, "id").as_string());
        }
    }
    return ids;
}

//------------------------------------------------------------------
/// @details
///		get site Id and the path id
///	@param[in]	filePath
///		filePath of the file
///	@param[out]	path
///		id of the path
///	@param[out]	siteId
///		id of the site
///	@returns
///		Error
//------------------------------------------------------------------
Error MsSharepointNode::getSiteIdAndPath(const file::Path &filePath, Text &path,
                                         Text &siteId) noexcept {
    // Get the siteName, path format "/siteName/filepath"
    Text sharepointName = filePath.at(SITENAME_POS);
    // Get the file path, path format "/siteName/filepath"
    file::Path filePathUpload = filePath.subpth(FILE_PATH_POS);
    path = urlEncode(filePathUpload.str(), true);

    auto siteIdCcode = getSiteId(sharepointName);
    if (siteIdCcode.hasCcode() || !siteIdCcode.hasValue())
        return MONERR(warning, Ec::Warning, "failed site not found");
    siteId = siteIdCcode.value();
    return {};
}

//------------------------------------------------------------------
/// @details
///		set the total size of the file
///	@param[in]	totalSize
///		size of the file
//------------------------------------------------------------------
void MsSharepointNode::setTotalSize(const size_t &totalSize) noexcept {
    m_totalSize = totalSize;
}

//-----------------------------------------------------------------
/// @details
///		get the last part uploaded of the file
///	@returns
///		m_endOfByte
//------------------------------------------------------------------
const size_t &MsSharepointNode::getPartUploaded() const noexcept {
    return m_endOfByte;
}

//------------------------------------------------------------------
/// @details
///		cleans sizes
//------------------------------------------------------------------
void MsSharepointNode::clearSizes() noexcept {
    m_endOfByte = 0;
    m_startOfByte = 0;
    m_totalSize = 0;
}

//------------------------------------------------------------------
/// @details
///		get site id from sitename
//------------------------------------------------------------------
Text MsSharepointNode::findSiteId(web::json::value &value,
                                  const Text &siteName) noexcept {
    if (!hasField(value, "id")) {
        return {};
    }
    if (hasField(value, "displayName")) {
        if (0 == Utf8icmp(siteName,
                          Text(getValue(value, "displayName").as_string())))
            return getValue(value, "id").as_string();
    } else if (hasField(value, "name")) {
        if (0 == Utf8icmp(siteName, Text(getValue(value, "name").as_string())))
            return getValue(value, "id").as_string();
    }
    return {};
}

//------------------------------------------------------------------
/// @details
///		get all items and folders
///	@param[in]	filePath
///		file to be downloaded
///	@returns
///		Content of the file
//------------------------------------------------------------------
Error MsSharepointNode::getItemsAndFolders(
    std::list<Entry> &entries, const DriveInfo &driveInfo, const Path &path,
    const Text &siteId, const ScanAddObject &callback,
    const msNode::SetSyncTokenCallBack &setSyncToken,
    const msNode::GetSyncTokenCallBack &getSyncToken) noexcept {
    // Paths are /SiteName/path/
    if (!path.count()) return APERR(Ec::InvalidFormat, "SiteName missing");

    // Get the siteName, path format "/siteName/filepath"
    Text siteName = path.at(SITENAME_POS);
    MsContainer allItems;
    Entry driveEntry = getDriveInfo(siteId, driveInfo);
    entries.push_back(driveEntry);
    // Create a root entry, root entry name is changed at the end to siteId
    // SiteId is needed for requests
    auto rootId = getRootInfo(siteId, driveInfo, path);
    if (rootId.hasCcode()) return rootId.ccode();
    Entry rootEntry = rootId.value();
    // entries.push_back(rootEntry);
    //  holds all the parent folders for a path
    MsContainer parentsContainer;
    Text itemId;
    Text rootUniqueId = rootEntry.uniqueName();

    // change root entry name to siteId
    // rootEntry.uniqueName(siteId);
    // push root entry to front

    // If no path, then get all items from root
    if (path.count() == 2) {
        itemId = rootUniqueId;
    } else {
        auto ccodeItemId = getItemId(siteId, driveInfo, path);
        if (ccodeItemId.hasCcode()) return ccodeItemId.ccode();
        itemId = ccodeItemId.value();
        if (auto ccode =
                getParents(siteId, driveInfo, itemId, path, parentsContainer))
            return ccode;
        entries.splice(entries.end(),
                       getEntries(parentsContainer, rootUniqueId, path.str(),
                                  driveEntry.uniqueName()));
    }

    auto syncTokenPath = getSyncToken(itemId);
    auto syncToken = syncTokenPath.hasValue() ? syncTokenPath.value() : Text();

    // call back to add entries
    const ScanCallBack &callbackfn = [&](MsContainer &msContainer) -> Error {
        auto valuesPath = getEntries(msContainer, rootUniqueId, path.str(),
                                     driveEntry.uniqueName(), itemId);

        // Set the delta type for root
        if (entries.size())
            entries.back().syncScanType.set(msContainer.isDelta()
                                                ? Entry::SyncScanType::DELTA
                                                : Entry::SyncScanType::FULL);

        entries.splice(entries.end(), valuesPath);
        // for all entries call the callback
        while (!entries.empty()) {
            if (auto ccode = callback(entries.front())) {
                // OneNote item can cause callback to fail
                LOGT("callback failed, continue", ccode);
            }
            entries.pop_front();
        }
        return {};
    };

    // Get all items for the itemId
    auto items =
        getItems(siteId, driveInfo.driveId, itemId, callbackfn, syncToken);
    if (items.hasCcode()) return items.ccode();
    auto itemValues = items.value();

    setSyncToken(itemId, itemValues.syncToken());

    return {};
}
ErrorOr<const std::list<DriveInfo>> MsSharepointNode::getAllDrives(
    const Text &siteId) noexcept {
    if (m_msConfig->m_expires_at <= std::time(0))
        if (auto ccode = requestToken()) return ccode;

    std::list<DriveInfo> drives;
    http_headers header;
    header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=1000"));

    auto ccode = requestValues(methods::GET,
                               Text("sites/" + siteId + "/drives"), header);
    if (ccode.hasCcode()) return ccode.ccode();

    MsContainer values = ccode.value();
    if (values.getStatusCode() != status_codes::OK) {
        return APERR(Ec::Failed,
                     "Request failed with error code:", values.getStatusCode());
    }

    for (auto &allValues : values.getValues()) {
        for (auto &it : allValues) {
            DriveInfo drive;
            if (hasField(it, "id") && hasField(it, "name")) {
                drive.driveId = it[U_STRING_T("id")].as_string();
                drive.driveName = it[U_STRING_T("name")].as_string();
                drives.push_back(drive);
            }
        }
    }
    return drives;
}
//-----------------------------------------------------------------
/// @details
///		get all sites
///	@returns
///		list of all the sites
//------------------------------------------------------------------
ErrorOr<const std::list<SiteInfo>> MsSharepointNode::getAllSites() noexcept {
    if (m_msConfig->m_expires_at <= std::time(0))
        if (auto ccode = requestToken()) return ccode;

    std::list<SiteInfo> sites;
    http_headers header;
    header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=1000"));

    auto ccode = requestValues(methods::GET, Text("sites/"), header);
    if (ccode.hasCcode()) return ccode.ccode();

    MsContainer values = ccode.value();
    if (values.getStatusCode() != status_codes::OK) {
        return APERR(Ec::Failed,
                     "Request failed with error code:", values.getStatusCode());
    }

    for (auto &allValues : values.getValues()) {
        for (auto &it : allValues) {
            SiteInfo site;
            if (hasField(it, "id") && hasField(it, "displayName")) {
                site.siteId = it[U_STRING_T("id")].as_string();
                site.siteName = it[U_STRING_T("displayName")].as_string();
                sites.push_back(site);
            }
        }
    }
    return sites;
}

//-----------------------------------------------------------------
/// @details
///		Get all items from sites
///	@param[in]	callback
///		callback to add entry into scan
///	@param[in]	m_tokenStorage
///		sync token storage
///	@returns
///		items
//------------------------------------------------------------------
Error MsSharepointNode::getAllSitesAndItems(
    const ScanAddObject &callback,
    const msNode::SetSyncTokenCallBack &setSyncToken,
    const msNode::GetSyncTokenCallBack &getSyncToken) noexcept {
    auto sites = getAllSites();
    if (sites.hasCcode()) return sites.ccode();
    for (auto site : sites.value()) {
        // skip the onedrive, if siteId contains my.sharepoint.com then it is
        // onedrive
        if (site.siteId.contains("my.sharepoint.com")) continue;
        Path path(site.siteName);
        std::list<Entry> entries;
        Entry siteEntry = getSiteEntry(site.siteId, site.siteName);
        entries.push_back(siteEntry);
        auto allDrives = getAllDrives(site.siteId);
        if (allDrives.hasCcode()) {
            MONERR(warning, Ec::Warning,
                   "No drives found in site:", site.siteName);
            continue;
        }
        for (auto drive : allDrives.value()) {
            if (auto ccode =
                    getItemsAndFolders(entries, drive, path, site.siteId,
                                       callback, setSyncToken, getSyncToken))
                continue;
        }
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Get all items from a path
///	@param[in]	path
///		path to get items from
///	@param[in]	callback
///		callback to add entry into scan
///	@param[in]	m_tokenStorage
///		sync token storage
///	@returns
///		items
//------------------------------------------------------------------
Error MsSharepointNode::getItems(
    const Path &path, const ScanAddObject &callback,
    const msNode::SetSyncTokenCallBack &setSyncToken,
    const msNode::GetSyncTokenCallBack &getSyncToken) noexcept {
    if (path.count()) {
        // Get the sitename, path format "/siteName/filepath"
        Text siteName = path.at(SITENAME_POS);
        auto siteCcode = getSiteId(siteName);
        if (siteCcode.hasCcode()) return siteCcode.ccode();

        std::list<Entry> entries;
        Entry siteEntry =
            getSiteEntry(siteCcode.value(), path.at(SITENAME_POS));
        entries.push_back(siteEntry);
        auto allDrives = getAllDrives(siteCcode.value());
        if (allDrives.hasCcode()) {
            MONERR(warning, Ec::Warning, "No Drives found: ", siteName);
            return allDrives.ccode();
        }
        if (path.length() == 1) {
            for (auto drive : allDrives.value()) {
                if (auto ccode = getItemsAndFolders(entries, drive, path,
                                                    siteCcode.value(), callback,
                                                    setSyncToken, getSyncToken))
                    return ccode;
            }
        } else {
            // find drive id
            Text driveName = path.at(DRIVE_POS);
            bool driveFound = false;
            for (auto drive : allDrives.value()) {
                // When asking for all drives, Graph api returns name as
                // Documents. But it's also called as Shared Documents
                if (drive.driveName == driveName ||
                    (drive.driveName == "Shared Documents" &&
                     driveName == "Documents")) {
                    driveFound = true;
                    if (auto ccode = getItemsAndFolders(
                            entries, drive, path, siteCcode.value(), callback,
                            setSyncToken, getSyncToken))
                        return ccode;
                    break;
                }
            }
            if (!driveFound) {
                MONERR(warning, Ec::Warning, "Drive ", driveName, " not found");
                return {};
            }
        }
    } else if (auto ccode =
                   getAllSitesAndItems(callback, setSyncToken, getSyncToken))
        return ccode;
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Get meta data of an item
///	@param[in]	siteId
///		siteId of the site
///	@param[in]	itemId
///		itemId of the entry
///	@returns
///		metadata of an item
//------------------------------------------------------------------
ErrorOr<Entry> MsSharepointNode::getMetaData(const Text &siteId,
                                             const Text &itemId) noexcept {
    utility::string_t urlMeta =
        U_STRING_T(Text("sites/" + siteId + "/drive/items/" + itemId +
                        "?&$select=createdDateTime,size,lastModifiedDateTime,"
                        "id,name,parentReference"));
    auto requests = requestValue(methods::GET, urlMeta);
    if (requests.hasCcode()) return requests.ccode();
    auto itemEntry = MsSharepointNode::getEntries(requests.value());
    if (itemEntry.size() == 1) return itemEntry.back();
    return APERR(Ec::RequestFailed, "Item not found", itemId);
}

//-----------------------------------------------------------------
/// @details
///		Get meta data of an item
///	@param[in]	siteId
///		siteId of the site
///	@param[in]	itemId
///		itemId of the entry
///	@returns
///		metadata of an item
//------------------------------------------------------------------
ErrorOr<Text> MsSharepointNode::getItemPath(const Text &siteId,
                                            const Text &driveId,
                                            const Text &itemId) noexcept {
    Text urlMeta =
        U_STRING_T(Text("sites/" + siteId + "/drives/" + driveId + "/items/" +
                        itemId + "?&$select=parentReference"));
    http_response response;

    const RequestCallBack requestCallBack =
        [this, &siteId, &urlMeta]() -> ErrorOr<const http_response> {
        return request(methods::GET, urlMeta);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not found");
    response = ccode.value();
    if (response.status_code() != status_codes::OK) {
        return MONERR(warning, Ec::Warning, "Items not found",
                      response.status_code());
    }
    web::json::value value = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    web::json::value parentIdObject;
    if (value.has_field(U_STRING_T("parentReference")))
        parentIdObject = value[U_STRING_T("parentReference")];
    else
        return MONERR(warning, Ec::Warning, "Items not found");

    if (parentIdObject.has_field(U_STRING_T("path"))) {
        Text tempUrl = parentIdObject[U_STRING_T("path")].as_string();
        auto pos = tempUrl.find(":");
        // set the path as url, so that it is picked up by scan
        if (pos == tempUrl.length() - 1)
            return MONERR(warning, Ec::Warning, "Items not found");
        else
            return tempUrl.substr(pos + 1);
    }
    return MONERR(warning, Ec::Warning, "Items not found");
}

//------------------------------------------------------------------
/// @details
///		get items from a path
///	@param[in]	siteId
///		siteId of the site
///	@param[in]	path
///		path to get items from
///	@param[in]	syncToken
///		syncToken for the path
///	@returns
///		items from the path
//------------------------------------------------------------------
ErrorOr<MsContainer> MsSharepointNode::getItems(
    const Text &siteId, const Text &driveId, const Text &path,
    const ScanCallBack &callback, const Text &syncToken) noexcept {
    utility::string_t getItemsUrl;
    bool isDelta = false;
    if (syncToken.empty())
        getItemsUrl =
            utility::string_t() +
            U_STRING_T(Text("sites/" + siteId + "/drives/" + driveId +
                            "/items/" + path +
                            "/delta?top=1000&select=id%2cname%"
                            "2clastModifiedDateTime%2ccreatedDateTime%2cfolder%"
                            "2cfile%2cdeleted%2cparentReference%2csize"));
    else {
        getItemsUrl =
            utility::string_t() +
            U_STRING_T(Text("sites/" + siteId + "/drives/" + driveId +
                            "/items/" + path +
                            "/delta?top=1000&select=id%2cname%"
                            "2clastModifiedDateTime%2ccreatedDateTime%2cfolder%"
                            "2cfile%2cdeleted%2cparentReference%2csize" +
                            "&token=" + syncToken));
        isDelta = true;
    }
    unsigned int retries = 0;

    web::http::status_code code;
    do {
        http_headers header;
        header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=1000"));

        auto ccode =
            requestValuesWithCallBack(methods::GET, getItemsUrl, callback,
                                      isDelta, header, DELTA_KEY_SHAREPOINT);
        if (ccode.hasCcode()) return ccode;

        code = ccode.value().getStatusCode();
        // request again
        if (code == status_codes::Gone) {
            isDelta = false;
            getItemsUrl =
                utility::string_t() +
                U_STRING_T(
                    Text("sites/" + siteId + "/drives/" + driveId + "/items/" +
                         path +
                         "/delta?top=1000&select=id%2cname%"
                         "2clastModifiedDateTime%2ccreatedDateTime%2cfolder%"
                         "2cfile%2cdeleted%2cparentReference%2csize"));
            retries++;
            continue;
        } else {
            ccode.value().setIsDelta(isDelta);
            return ccode;
        }
    } while (retries < SHAREPOINT_MAX_RETRIES);

    return APERR(Ec::Failed, "Could not get items for", path);
}

ErrorOr<Entry> MsSharepointNode::getSiteEntry(const Text &siteId,
                                              const Text &siteName) noexcept {
    Text pathId;
    Entry entry;

    entry.uniqueName(siteId);
    entry.isContainer(true);
    entry.operation.set(Entry::OPERATION::ADD);
    entry.name(siteName);
    return entry;
}

ErrorOr<Entry> MsSharepointNode::getDriveInfo(const Text &siteId,
                                              const DriveInfo &drive) noexcept {
    Text pathId;
    Entry entry;

    entry.uniqueName(drive.driveId);
    entry.parentUniqueName(siteId);
    entry.isContainer(true);
    entry.operation.set(Entry::OPERATION::ADD);
    entry.name(drive.driveName);
    return entry;
}
//------------------------------------------------------------------
/// @details
///		get root info for a site
///	@param[in]	siteId
///		siteId of the site
///	@param[in]	path
///		path to get siteName
///	@returns
///		items from the path
//------------------------------------------------------------------
ErrorOr<Entry> MsSharepointNode::getRootInfo(const Text &siteId,
                                             const DriveInfo &drive,
                                             const Path &path) noexcept {
    Text pathId;
    Entry entry;
    std::shared_ptr<http_request> req =
        std::make_shared<http_request>(methods::GET);

    auto rootCcode = getDriveRoot(siteId, drive.driveId);
    if (rootCcode.hasCcode()) return rootCcode.ccode();

    entry.uniqueName(rootCcode.value());
    entry.isContainer(true);
    entry.operation.set(Entry::OPERATION::ADD);
    entry.name("root");
    entry.parentUniqueName(drive.driveId);
    return entry;
}

//-----------------------------------------------------------------
/// @details
///		get itemsId for a path
///	@param[in]	siteId
///		siteId of the site
///	@param[in]	path
///		path to get items from
///	@returns
///		itemId of the path
//------------------------------------------------------------------
ErrorOr<Text> MsSharepointNode::getItemId(const Text &siteId,
                                          const DriveInfo &drive,
                                          const Path &path) noexcept {
    http_response response;

    // Get the file path, path format "/siteName/filepath"
    Text encodedPath = urlEncode(path.subpth(FILE_PATH_POS).str(), true);
    const RequestCallBack requestCallBack =
        [this, &siteId, &drive,
         &encodedPath]() -> ErrorOr<const http_response> {
        return request(methods::GET,
                       Text("sites/" + siteId + "/drives/" + drive.driveId +
                            "/root:/" + encodedPath));
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode() ||
        ccode.value().status_code() != web::http::status_codes::OK)
        return MONERR(warning, Ec::Warning, "Item not found", siteId, path);
    response = ccode.value();

    web::json::value jsonData = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    if (hasField(jsonData, "id")) return getValue(jsonData, "id").as_string();
    return {};
}

//-----------------------------------------------------------------
/// @details
///		get parents of a path
///	@param[in]	siteId
///		siteId of the site
///	@param[in]	path
///		path to get items from
///	@param[out]	parentsContainer
///		parentsContainer
///	@returns
///		parents of the path
//-----------------------------------------------------------------
Error MsSharepointNode::getParents(const Text &siteId, const DriveInfo &drive,
                                   const Text &itemPathId, const Path &path,
                                   MsContainer &parentsContainer) noexcept {
    // Get the siteName, path format "/siteName/driveName/filepath"
    Text folderName(path.at(SITENAME_POS));
    Text currentPath;

    for (int i = FILE_PATH_POS; i < path.count(); i++) {
        // Get the file path, path format "/siteName/filepath"
        currentPath.append(path.at(i));
        Text encodedPath = urlEncode(currentPath, true);
        const RequestCallBack requestCallBack =
            [this, &siteId, &drive,
             &encodedPath]() -> ErrorOr<const http_response> {
            return request(methods::GET,
                           Text("sites/" + siteId + "/drives/" + drive.driveId +
                                "/root:/" + encodedPath));
        };

        auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK,
                                         SHAREPOINT_MAX_RETRIES);
        if (ccode.hasCcode())
            return MONERR(warning, Ec::Warning, "Item not found");
        http_response response = ccode.value();

        web::json::value values = extract_data<web::json::value>(
            response, [](http_response &res) { return res.extract_json(); });

        if (!hasField(values, "parentReference")) {
            return MONERR(warning, Ec::Warning,
                          "Path does not exists: ", path.str());
        }
        auto parentObject = getValue(values, "parentReference").as_object();

        web::json::value value = web::json::value::array(1);
        folderName.append("/");
        folderName.append(path.at(i));
        values[U_STRING_T("parentFolderId")] = parentObject[U_STRING_T("id")];
        values[U_STRING_T("url")] =
            web::json::value::string(U_STRING_T(folderName));

        value[0] = values;
        parentsContainer.pushValues(value.as_array());
        currentPath.append("/");
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		delete the object
///	@param[in]	object
///		object to be deleted
//------------------------------------------------------------------
Error MsSharepointNode::deleteItem(const Entry &object) noexcept {
    const Path &path = object.uniquePath();

    // sitename is at 0, path format "/siteName/filepath"
    Text url = Text("sites/" + path.at(SITENAME_POS) + "/drive/items/") +
               object.uniqueName();
    const RequestCallBack requestCallBack =
        [this, &url]() -> ErrorOr<const http_response> {
        return request(methods::DEL, url);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_DELETED,
                                     SHAREPOINT_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Item not deleted");

    return {};
}

ErrorOr<Entry> MsSharepointNode::getMetaDataUsingPath(
    const Text &siteId, const Text &itemPath) noexcept {
    // sitename is at 0, path format "/siteName/filepath"
    Text encodedPath = urlEncode(itemPath, true);
    Text url = Text("sites/" + siteId + "/drive/root/:/") + encodedPath +
               Text(
                   "?&$select=createdDateTime,size,lastModifiedDateTime,id,"
                   "name,parentReference");
    auto ccode = requestValue(methods::GET, url);
    if (ccode.hasCcode()) return ccode.ccode();
    auto request = ccode.value();
    auto itemEntry = MsSharepointNode::getEntries(request);
    if (itemEntry.size() == 1) return itemEntry.back();
    return {};
}
}  // namespace engine::store::filter::msNode::msSharepointNode

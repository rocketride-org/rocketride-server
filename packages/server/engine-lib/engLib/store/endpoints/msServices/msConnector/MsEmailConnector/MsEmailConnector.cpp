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

namespace engine::store::filter::msNode::msEmailNode {

MsEmailNode::MsEmailNode() : MsNode() {}

MsEmailNode::MsEmailNode(std::shared_ptr<MsConfig> msConfig,
                         IServiceEndpoint *parentEndpoint)
    : MsNode(msConfig, parentEndpoint) {}

MsEmailNode::~MsEmailNode() {}

//-----------------------------------------------------------------
/// @details
///		This function is to create connection to MS
///	@returns
///		Error
//-----------------------------------------------------------------
Error MsEmailNode::createConnection() noexcept {
    if (auto ccode = requestToken(false)) return ccode;
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function fetches emails for a path
///	@param[in]	userId
///		The userId of the intended user
///	@param[in]	pathId
///		The pathId to fetch emails from
///	@param[in]	syncToken
///		The delta token
///	@returns
///		Error or Emails
//-----------------------------------------------------------------
ErrorOr<MsContainer> MsEmailNode::getEmails(const Text &userId,
                                            const Text &pathId,
                                            const Text &syncToken) noexcept {
    utility::string_t urlMessages;
    bool isDelta = false;
    Text encodedUserId = urlEncode(userId, true);
    // no sync token present, get deltaToken and values
    if (syncToken.empty())
        urlMessages = utility::string_t() +
                      U_STRING_T(Text(
                          "users/" + encodedUserId + "/mailFolders/" + pathId +
                          "/messages/"
                          "delta?$select=sender,subject,createdDateTime,from,"
                          "receivedDateTime,lastModifiedDateTime,sentDateTime,"
                          "sender,toRecipients,parentFolderId"));
    else {
        urlMessages = utility::string_t() +
                      U_STRING_T(Text(
                          "users/" + encodedUserId + "/mailFolders/" + pathId +
                          "/messages/delta?$deltatoken=" + syncToken +
                          "&$select=sender,subject,createdDateTime,from,"
                          "receivedDateTime,lastModifiedDateTime,sentDateTime,"
                          "sender,toRecipients,parentFolderId"));
        isDelta = true;
    }

    http_headers header;
    header.add(U_STRING_T("Prefer"),
               U_STRING_T("outlook.body-content-type=\"text\""));
    // get 200 values, maximum is 200
    header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=200"));
    do {
        auto ccode =
            requestValues(methods::GET, urlMessages, header, DELTA_KEY_OUTLOOK);
        if (ccode.hasCcode()) return ccode;

        web::http::status_code code = ccode.value().getStatusCode();
        // request again without token, if delta token has failed
        if (code == status_codes::Gone) {
            isDelta = false;
            urlMessages =
                utility::string_t() +
                U_STRING_T(
                    Text("users/" + encodedUserId + "/mailFolders/" + pathId +
                         "/messages/"
                         "delta?$select=sender,subject,createdDateTime,from,"
                         "receivedDateTime,lastModifiedDateTime,sentDateTime,"
                         "sender,toRecipients,parentFolderId"));
            continue;
        } else {
            ccode.value().setIsDelta(isDelta);
            return ccode;
        }
    } while (true);
}

//-----------------------------------------------------------------
/// @details
///		This function fetches children folders from a path
///	@param[in]	userId
///		The userId of the intended user
///	@param[in]	pathId
///		The pathId to fetch paths from
///	@param[in]	parentUrl
///		The parentUrl, to create URL
///	@returns
///		Error or childfolders
//-----------------------------------------------------------------
ErrorOr<MsContainer> MsEmailNode::getPaths(const Text &userId,
                                           const Text &pathId,
                                           const Text &parentUrl) noexcept {
    MsContainer msContainerV;
    Text url;
    Text encodedUserId = urlEncode(userId, true);
    utility::string_t urlMessages =
        utility::string_t() +
        U_STRING_T(Text("users/" + encodedUserId + "/mailFolders/" + pathId +
                        "/childFolders"));

    http_headers header;
    header.add(U_STRING_T("Prefer"),
               U_STRING_T("outlook.body-content-type=\"text\""));
    header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=200"));
    auto ccode = requestValues(methods::GET, urlMessages, header);

    if (ccode.hasCcode()) return ccode.ccode();

    auto values = ccode.value();
    auto foldersLists = values.getValues();

    for (auto folders : foldersLists) {
        for (auto &folder : folders) {
            ErrorOr<MsContainer> childValuesCcode;
            url = parentUrl + "/" +
                  Text(folder[U_STRING_T("displayName")].as_string());
            web::json::value value = web::json::value::array(1);
            folder[U_STRING_T("url")] =
                web::json::value::string(U_STRING_T(url));
            value[0] = folder;
            msContainerV.pushValues(value.as_array());
            if (folder[U_STRING_T("childFolderCount")].as_integer() > 0) {
                childValuesCcode =
                    getPaths(userId, folder[U_STRING_T("id")].as_string(), url);
            }
            if (childValuesCcode.hasCcode()) return childValuesCcode.ccode();
            if (childValuesCcode.hasValue()) {
                auto childValues = childValuesCcode.value().getValues();
                msContainerV.insertList(childValues);
            }
        }
    }
    return msContainerV;
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
Error MsEmailNode::setConfig(
    engine::store::IServiceConfig &serviceConfig) noexcept {
    if (auto ccode = OutlookConfig::__fromJson(
            serviceConfig, m_msConfig,
            serviceConfig.logicalType == outlook::TypeEnterprise))
        return ccode;

    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function fetches children folders and emails from all users
///	@param[in]	callback
///		The callback to process entry
///	@param[in/out]	tokenStorage
///		The tokenStorage to fetch sync tokens and update them
///	@returns
///		Error or childfolders
//-----------------------------------------------------------------
Error MsEmailNode::getAllUsersEmailsAndFolders(
    const ScanAddObject &callback,
    const msNode::SetSyncTokenCallBack &setSyncToken,
    const msNode::GetSyncTokenCallBack &getSyncToken) noexcept {
    auto users = getAllUsers();
    if (users.hasCcode()) return users.ccode();
    for (auto user : users.value()) {
        Path path(user);
        if (auto ccode =
                getEmailsAndFolders(path, callback, setSyncToken, getSyncToken))
            continue;
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function fetches children folders and emails from a path
///	@param[in] path
///		The path to fetch emails and folders
///	@param[in]	callback
///		The callback to process entry
///	@param[in/out]	tokenStorage
///		The tokenStorage to fetch sync tokens and update them
///	@returns
///		Error or childfolders
//-----------------------------------------------------------------
Error MsEmailNode::getEmailsAndFolders(
    const Path &path, const ScanAddObject &callback,
    const msNode::SetSyncTokenCallBack &setSyncToken,
    const msNode::GetSyncTokenCallBack &getSyncToken) noexcept {
    // Paths are /username/path/
    if (!path.count()) return APERR(Ec::InvalidFormat, "Username missing");

    // Paths are /username/path/
    Text userName = path.at(USERNAME_POS);

    if (auto ccode = hasActiveMailBox(userName)) return ccode;

    MsContainer emails;
    std::list<Entry> entries;

    // get all the paths
    MsContainer parentsContainer;
    Text parentUrl = path.str();

    // create rootEntry
    auto rootId = getRootInfo(userName, parentUrl);
    if (rootId.hasCcode()) return rootId.ccode();
    Entry rootEntry = rootId.value();

    // get all the parent containers for a path, and get id of the path
    auto pathId =
        findPathIdAndGetParentsContainer(rootEntry, path, parentsContainer);
    if (pathId.hasCcode()) return APERR(Ec::Failed, "Path not found");

    // Add parents
    Text pathIdValue;
    if (!pathId.value().empty()) {
        pathIdValue = pathId.value();
        entries.splice(
            entries.end(),
            msEmailContainer::MsEmailContainer::getEntries(parentsContainer));
    } else {
        pathIdValue = rootEntry.uniqueName();
    }
    auto syncTokenPath = getSyncToken(pathIdValue);

    auto syncToken = syncTokenPath.hasValue() ? syncTokenPath.value() : Text();

    // Get emails from the path
    auto emailPath = getEmails(userName, pathIdValue, syncToken);
    if (emailPath.hasValue()) {
        // create entries for emails from pathId and append to the list
        auto emailValuesPath =
            msEmailContainer::MsEmailContainer::getEntries(emailPath.value());
        auto scanType = emailPath.value().isDelta() ? Entry::SyncScanType::DELTA
                                                    : Entry::SyncScanType::FULL;
        if (entries.empty())
            rootEntry.syncScanType.set(scanType);
        else
            entries.back().syncScanType.set(scanType);

        // append to the list
        entries.splice(entries.end(), emailValuesPath);
    }
    // Set new delta token
    setSyncToken(pathIdValue, emailPath.value().syncToken());

    // Get emails from the childPaths
    auto containers = getPaths(userName, pathIdValue, parentUrl);
    if (containers.hasCcode()) return containers.ccode();

    // For all child paths get email
    for (auto values : containers.value().getValues()) {
        for (auto folder : values) {
            Text folderId(folder[U_STRING_T("id")].as_string());
            Text pathUrl(folder[U_STRING_T("url")].as_string());
            auto folderEntry =
                msEmailContainer::MsEmailContainer::getFolderEntry(folder);

            // folder failed, get next entry
            if (folderEntry.hasCcode()) {
                continue;  // Go to next entry
            }

            Entry &folderValueEntry = folderEntry.value();

            auto syncTokenFolder = getSyncToken(folderId);
            auto syncTokenValue =
                syncTokenFolder.hasValue() ? syncTokenFolder.value() : Text();

            // get email for this child
            auto email = getEmails(
                userName, folder[U_STRING_T("id")].as_string(), syncTokenValue);

            if (email.hasValue()) {
                MsContainer emailValues = email.value();
                if (emailValues.isDelta())
                    folderValueEntry.syncScanType.set(
                        Entry::SyncScanType::DELTA);
                else
                    folderValueEntry.syncScanType.set(
                        Entry::SyncScanType::FULL);
                entries.push_back(folderEntry.value());
                auto emailEntries =
                    msEmailContainer::MsEmailContainer::getEntries(
                        emailValues, rootEntry, pathUrl, folderId);
                if (emailEntries.size())
                    entries.splice(entries.end(), emailEntries);
                setSyncToken(folderId, emailValues.syncToken());
            } else {
                return email.ccode();
            }
        }
    }

    // get all deleted folders
    // Note: It will only get parent folders not its childrens
    auto deltaFolders = getDeltaFolders(userName, pathIdValue, getSyncToken);
    if (!deltaFolders.hasCcode()) {
        auto deltaFolderValues = deltaFolders.value();
        setSyncToken(_ts(pathIdValue, FOLDER_DELTA_POSTFIX),
                     deltaFolderValues.syncToken());
        for (auto deltaFolderValue : deltaFolderValues.getValues()) {
            for (auto deltaFolder : deltaFolderValue) {
                if (deltaFolder.has_field(U_STRING_T("@removed"))) {
                    Entry folderRemoved;
                    Text removedFolderId =
                        deltaFolder[U_STRING_T("id")].as_string();
                    // No information about name in @removed
                    // so set Id as name, so that this entry is picked up for
                    // scan output
                    folderRemoved.name(removedFolderId);
                    folderRemoved.uniqueName(removedFolderId);
                    folderRemoved.operation.set(Entry::OPERATION::REMOVE);
                    folderRemoved.isContainer(true);
                    folderRemoved.syncScanType(Entry::SyncScanType::FULL);
                    entries.push_back(folderRemoved);
                }
            }
        }
    }
    // set rootEntry name as the username

    entries.push_front(rootEntry);

    while (!entries.empty()) {
        callback(entries.front());
        entries.pop_front();
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function creates entry for root
///	@param[in] userId
///		The path to fetch emails and folders
///	@param[in]	path
///		The path of folder
///	@returns
///		Error or Entry
//-----------------------------------------------------------------
ErrorOr<Entry> MsEmailNode::getRootInfo(const Text &userId,
                                        const Text &path) noexcept {
    Text pathId;
    Entry entry;
    Text encodedUserId = urlEncode(userId, true);
    utility::string_t urlMessages =
        U_STRING_T(Text("users/" + encodedUserId + "/mailFolders"));

    http_headers header;
    header.add(U_STRING_T("Prefer"),
               U_STRING_T("outlook.body-content-type=\"text\""));
    header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=200"));
    auto requestValue = requestValues(methods::GET, urlMessages, header);

    if (requestValue.hasCcode()) return requestValue.ccode();
    auto value = requestValue.value().getValues();
    if (!value.size() ||
        !value.front()[0].has_field(U_STRING_T("parentFolderId"))) {
        return APERR(Ec::InvalidCommand, "User has no folders");
    }

    entry.uniqueName(
        value.front()[0][U_STRING_T("parentFolderId")].as_string());
    entry.isContainer(true);
    entry.operation.set(Entry::OPERATION::ADD);
    entry.name(userId);
    return entry;
}

//-----------------------------------------------------------------
/// @details
///		This function find id of the path and fetches all its parents
///	@param[in] rootEntry
///		The root entry
///	@param[in]	path
///		The path of folder
/// @param[out]	parentsContainer
///		Contains all parent containers
///	@returns
///		Error or id of the path
//-----------------------------------------------------------------
ErrorOr<Text> MsEmailNode::findPathIdAndGetParentsContainer(
    const Entry &rootEntry, const Path &path,
    MsContainer &parentsContainer) noexcept {
    Text pathId;
    const Text userId = path.at(0);
    Text encodedUserId = urlEncode(userId, true);
    // std::shared_ptr<http_request> req =
    // std::make_shared<http_request>(methods::GET);
    utility::string_t urlMessages =
        U_STRING_T(Text("users/" + encodedUserId + "/mailFolders/"));

    for (int i = 1; i < path.count(); i++) {
        http_headers header;
        header.add(U_STRING_T("Prefer"),
                   U_STRING_T("outlook.body-content-type=\"text\""));
        header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=200"));
        auto requestValue = requestValues(methods::GET, urlMessages, header);

        if (requestValue.hasCcode()) return requestValue.ccode();
        auto values = requestValue.value();
        auto foldersLists = values.getValues();

        // path is empty or all at i
        if (path.at(i) == "" || path.at(i) == "*") {
            // This is root
            if (pathId.empty()) {
                if (foldersLists.size()) {
                    web::json::array val = foldersLists.front();
                    if (val.size()) {
                        return val[0][U_STRING_T("parentFolderId")].as_string();
                    }
                }
            } else
                return pathId;
        }

        bool found = false;
        Text folderName(userId);
        for (auto folders : foldersLists) {
            for (auto &folder : folders) {
                if (Text(folder[U_STRING_T("displayName")].as_string()) ==
                    path.at(i)) {
                    pathId = folder[U_STRING_T("id")].as_string();
                    // create array of 1, since the container works with arrays
                    web::json::value value = web::json::value::array(1);
                    folderName.append(path.at(i));
                    folder[U_STRING_T("url")] =
                        web::json::value::string(U_STRING_T(folderName));
                    value[0] = folder;
                    parentsContainer.pushValues(value.as_array());
                    found = true;
                    break;
                }
            }
            if (found) break;
        }
        if (!found) return APERR(Ec::Failed, "Path not found");

        urlMessages =
            utility::string_t() +
            U_STRING_T(Text("users/" + encodedUserId + "/mailFolders/" +
                            pathId + "/childFolders"));
    }

    return pathId;
}

//-----------------------------------------------------------------
/// @details
///		This function gets delta of folders
///	@param[in] userId
///		userId
///	@param[in]	pathId
///		The path of folder
/// @param[in]	tokenStorage
///		token
///	@returns
///		delta of folders
//-----------------------------------------------------------------
ErrorOr<MsContainer> MsEmailNode::getDeltaFolders(
    const Text &userId, const Text &pathId,
    const msNode::GetSyncTokenCallBack &getSyncToken) noexcept {
    auto token = getSyncToken(_ts(pathId, FOLDER_DELTA_POSTFIX));
    auto tokenValue = token.hasValue() ? token.value() : Text();
    Text encodedUserId = urlEncode(userId, true);
    utility::string_t urlChildFolders;
    if (tokenValue.empty())
        urlChildFolders =
            utility::string_t() +
            U_STRING_T(Text("users/" + encodedUserId + "/mailFolders/" +
                            pathId + "/childFolders/delta"));
    else
        urlChildFolders =
            utility::string_t() +
            U_STRING_T(Text("users/" + encodedUserId + "/mailFolders/" +
                            pathId +
                            "/childFolders/delta?$deltatoken=" + tokenValue));

    http_headers header;
    header.add(U_STRING_T("Prefer"),
               U_STRING_T("outlook.body-content-type=\"text\""));
    // get 200 values, maximum is 200
    header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=200"));
    do {
        auto ccode = requestValues(methods::GET, urlChildFolders, header,
                                   DELTA_KEY_OUTLOOK);
        if (ccode.hasCcode()) return ccode;

        web::http::status_code code = ccode.value().getStatusCode();
        // request again without token, if delta token has failed
        if (code == status_codes::Gone) {
            urlChildFolders =
                utility::string_t() +
                U_STRING_T(Text("users/" + encodedUserId + "/mailFolders/" +
                                pathId + "/childFolders/delta"));
            continue;
        }
        return ccode;

    } while (true);
}

//-----------------------------------------------------------------
/// @details
///		This function gets message in the MIME format (EML)
///	@param[in] entry
///		The entry to get MIME message
///	@returns
///		Error or MIME message
//-----------------------------------------------------------------
ErrorOr<std::vector<unsigned char>> MsEmailNode::getMessageInMime(
    const Entry &entry) noexcept {
    http_headers header;
    header.set_content_type(U_STRING_T("text/plain"));
    auto fullPath = entry.url().path();
    Text userName = fullPath.at(0);
    Text encodedUserId = urlEncode(userName, true);
    utility::string_t urlMime =
        U_STRING_T(Text("users/" + encodedUserId + "/messages/" +
                        entry.uniqueName() + "/$value"));
    http_response response;
    const RequestCallBack requestCallBack =
        [this, &urlMime, &header]() -> ErrorOr<const http_response> {
        return request(methods::GET, urlMime, header);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     MS_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Message not found", urlMime);

    response = ccode.value();

    if (response.status_code() != web::http::status_codes::OK)
        return MONERR(warning, Ec::Warning, "Message not found", urlMime);

    std::vector<unsigned char> vectorData =
        extract_data<std::vector<unsigned char>>(
            response, [](http_response &res) { return res.extract_vector(); });

    return vectorData;
}

//-----------------------------------------------------------------
/// @details
///		This function gets metadata of the message
///	@param[in] userId
///		The  userId of the user
/// @param[in] messageId
///		The messageId of the message
///	@returns
///		Error or Entry
//-----------------------------------------------------------------
ErrorOr<Entry> MsEmailNode::getMetaData(const Text &userId,
                                        const Text &messageId) noexcept {
    Text encodedUserId = urlEncode(userId, true);
    utility::string_t urlMeta = U_STRING_T(
        Text("users/" + encodedUserId + "/messages/" + messageId +
             "?&$select=sender,subject,createdDateTime,from,receivedDateTime,"
             "lastModifiedDateTime,sentDateTime,sender,toRecipients,"
             "parentFolderId&$expand=singleValueExtendedProperties($filter=Id%"
             "20eq%20'LONG%200x0E08')"));
    /*req->set_request_uri(urlMeta);*/
    auto requests = requestValue(methods::GET, urlMeta);
    if (requests.hasCcode()) return requests.ccode();

    auto emailEntry =
        msEmailContainer::MsEmailContainer::getEntries(requests.value());
    if (emailEntry.size() == 1) return emailEntry.back();
    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function gets rawData of the message
///	@param[in] request
///		request
///	@returns
///		Error or raw data
//-----------------------------------------------------------------
Error MsEmailNode::hasActiveMailBox(const Text &user) noexcept {
    Text encodedUserId = urlEncode(user, true);
    // url to get mailBox settings of a user
    utility::string_t urlMailBox =
        U_STRING_T(Text("users/" + encodedUserId + "/mailBoxsettings/"));

    const RequestCallBack requestCallBack =
        [this, &urlMailBox]() -> ErrorOr<const http_response> {
        return request(methods::GET, urlMailBox);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODES_FOR_MAILBOX_SETTING,
                                     OUTLOOK_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "No mailbox for:", user);

    http_response response = ccode.value();
    if (response.status_code() == status_codes::NotFound)
        return MONERR(warning, Ec::Warning, "No mailbox for:", user);

    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function fetches children folders and emails from a path
///	@param[in] path
///		The path to fetch emails and folders
///	@param[in]	callback
///		The callback to process entry
///	@param[in/out]	tokenStorage
///		The tokenStorage to fetch sync tokens and update them
///	@returns
///		Error or childfolders
//-----------------------------------------------------------------
Error MsEmailNode::getValidPaths(
    const Text &userName, std::unordered_map<Text, Text> &folders) noexcept {
    // Paths are /username/path/
    if (userName.empty()) return APERR(Ec::InvalidFormat, "Username missing");

    if (auto ccode = hasActiveMailBox(userName)) return ccode;

    // get all the paths
    MsContainer parentsContainer;
    Text parentUrl = userName;

    // create rootEntry
    auto rootId = getRootInfo(userName, parentUrl);
    if (rootId.hasCcode()) return rootId.ccode();
    Entry rootEntry = rootId.value();

    folders[rootEntry.uniqueName()] = userName;

    auto containers = getPaths(userName, rootEntry.uniqueName(), parentUrl);
    if (containers.hasCcode()) return containers.ccode();

    // Add all childpath to map
    for (auto values : containers.value().getValues()) {
        for (auto folder : values) {
            Text folderId(folder[U_STRING_T("id")].as_string());
            Text pathUrl(folder[U_STRING_T("url")].as_string());
            folders[folderId] = pathUrl;
        }
    }

    return {};
}

//-----------------------------------------------------------------
/// @details
///		This function gets parentId of the message
///	@param[in] userId
///		The  userId of the user
/// @param[in] messageId
///		The messageId of the message
///	@returns
///		Error or Entry
//-----------------------------------------------------------------
ErrorOr<Text> MsEmailNode::getMessageParent(const Text &userId,
                                            const Text &messageId) noexcept {
    Text encodedUserId = urlEncode(userId, true);
    Text urlMeta = U_STRING_T(Text("users/" + encodedUserId + "/messages/" +
                                   messageId + "?&$select=parentFolderId"));
    http_response response;

    const RequestCallBack requestCallBack =
        [this, &urlMeta]() -> ErrorOr<const http_response> {
        return request(methods::GET, urlMeta);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     OUTLOOK_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not found");
    response = ccode.value();
    if (response.status_code() != status_codes::OK) {
        return MONERR(warning, Ec::Warning, "Items not found",
                      response.status_code());
    }

    web::json::value jsonData = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    web::json::value value = jsonData;

    if (value.has_field(U_STRING_T("parentFolderId")))
        return Text(value[U_STRING_T("parentFolderId")].as_string());

    return MONERR(warning, Ec::Warning, "Items not found");
}

//-----------------------------------------------------------------
/// @details
///		This function gets service principal information by client ID
///	@param[in] clientId
///		The application client ID to look up
///	@returns
///		ErrorOr<Text> containing the service principal ID
//-----------------------------------------------------------------
ErrorOr<Text> MsEmailNode::getServicePrincipalId(
    const Text &clientId) noexcept {
    utility::string_t servicePrincipalUrl =
        U_STRING_T(Text("servicePrincipals?$filter=appId%20eq%20%27" +
                        clientId + "%27&$count=true"));

    const RequestCallBack requestCallBack =
        [this, &servicePrincipalUrl]() -> ErrorOr<const http_response> {
        return request(methods::GET, servicePrincipalUrl);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     MS_MAX_RETRIES);
    if (ccode.hasCcode())
        return APERR(Ec::RequestFailed,
                     "Failed to retrieve service principal information");

    http_response response = ccode.value();
    if (response.status_code() != status_codes::OK) {
        return APERR(Ec::RequestFailed,
                     "Failed to retrieve service principal information",
                     response.status_code());
    }

    web::json::value jsonData = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    if (jsonData.has_field(U_STRING_T("value"))) {
        web::json::array values = jsonData[U_STRING_T("value")].as_array();
        if (values.size() && values[0].has_field(U_STRING_T("id")))
            return Text(values[0][U_STRING_T("id")].as_string());
        else
            return APERR(
                Ec::NotFound,
                "Application with client ID '{}' has no service principal",
                clientId);
    } else
        return APERR(Ec::NotFound, "Application with client ID '{}' not found",
                     clientId);
}

//-----------------------------------------------------------------
/// @details
///		This function gets app role assignments for a service principal
///	@param[in] clientId
///		The application client ID to look up
///	@param[in] servicePrincipalId
///		The service principal ID to get role assignments for
///	@returns
///		ErrorOr<std::vector<Text>> containing the app role IDs
//-----------------------------------------------------------------
ErrorOr<std::vector<Text>> MsEmailNode::getAppRoleAssignments(
    const Text &clientId, const Text &servicePrincipalId) noexcept {
    std::vector<Text> appRoleIds;

    utility::string_t roleAssignmentsUrl = U_STRING_T(Text(
        "servicePrincipals/" + servicePrincipalId + "/appRoleAssignments"));

    const RequestCallBack requestCallBack =
        [this, &roleAssignmentsUrl]() -> ErrorOr<const http_response> {
        return request(methods::GET, roleAssignmentsUrl);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     MS_MAX_RETRIES);
    if (ccode.hasCcode())
        return APERR(Ec::RequestFailed, "Failed to retrieve role assignments");

    http_response response = ccode.value();
    if (response.status_code() != status_codes::OK) {
        return APERR(Ec::RequestFailed,
                     "Failed to retrieve role assignments: HTTP {}",
                     response.status_code());
    }

    web::json::value jsonData = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    if (jsonData.has_field(U_STRING_T("value"))) {
        web::json::array values = jsonData[U_STRING_T("value")].as_array();
        for (auto &role : values) {
            if (role.has_field(U_STRING_T("appRoleId"))) {
                appRoleIds.push_back(
                    Text(role[U_STRING_T("appRoleId")].as_string()));
            }
        }
    } else
        return APERR(Ec::NotFound,
                     "No role assignments found for service principal ID '{}'",
                     servicePrincipalId);

    return appRoleIds;
}
}  // namespace engine::store::filter::msNode::msEmailNode

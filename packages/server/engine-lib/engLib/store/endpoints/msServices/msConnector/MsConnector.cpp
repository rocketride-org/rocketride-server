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

namespace engine::store::filter::msNode {
using namespace utility;
using namespace web::http;
using namespace web::http::client;
using namespace web::http::oauth2::experimental;

// Sets required options in the SSL context from the cpprest SDK
// This is required on Unix systems, as we ship our own ca bundle
inline void MsNode::setupSslOptions() noexcept(false) {
#if ROCKETRIDE_PLAT_UNX
    if (auto caFile = crypto::commonCertPath()) {
        _translate([&, caFile = _mv(caFile)] {
            m_msConfig->m_http_config.set_ssl_context_callback(
                [&, caFile = _mv(caFile)](boost::asio::ssl::context &context) {
                    auto res = _call([&, caFile = _mv(caFile)] {
                        context.use_certificate_chain_file(
                            caFile.plat().c_str());
                        context.load_verify_file(caFile.plat().c_str());
                        context.set_verify_mode(boost::asio::ssl::verify_peer);

                        // Disable weaker context
                        context.set_options(
                            boost::asio::ssl::context::default_workarounds |
                            boost::asio::ssl::context::no_sslv2 |
                            boost::asio::ssl::context::no_sslv3 |
                            boost::asio::ssl::context::no_tlsv1 |
                            boost::asio::ssl::context::no_tlsv1_1 |
                            boost::asio::ssl::context::no_compression);

                        // Allow only strong ciphers
                        return SSL_CTX_set_cipher_list(
                            context.native_handle(),
                            "HIGH:!DSS:!aNULL@STRENGTH");
                    });

                    if (res.check())
                        LOG(Always, "Failed to setup ssl:{} cacert:{}",
                            res.ccode(), caFile);
                    else
                        LOG(Always, "Set ca file path in ssl context", caFile);
                });
        });
    }
#endif
}

/// <summary>
/// update config
/// </summary>
/// <param name="msConfig"></param>
//-----------------------------------------------------------------
/// @details
///		update config
///	@param[in]	msConfig
///		ms config
//------------------------------------------------------------------
void MsNode::updateConfig(std::shared_ptr<MsConfig> msConfig) noexcept {
    m_msConfig = msConfig;
}

//-----------------------------------------------------------------
/// @details
///		request oAuth token from MS
///	@param[in]	updateTokenExpireAt
///		Flag that specifies if `expire at` should be updated.
///		Using a trick here: first time `requestToken` is called from
///`beginEndpoint`, 		and at this stage, key-value storage is not initialized (it
///is initialized later, 		in the same `beginEndpoint`). To force update of
///key-value storage, do not update 		`expire at` field during first call, so on
///the next time, when expire time is checked, 		generate new token and put newly
///obtained refresh token (if any) into key-value storage.
///	@returns
///		Error
//------------------------------------------------------------------
Error MsNode::requestToken(bool updateTokenExpireAt) noexcept {
    static const Text REFRESH_TOKEN_KEY{"refreshToken"};

    Text url;
    url.append(
        GRAPH_API_OAUTH_ENDPOINT +
        (m_msConfig->m_isEnterprise ? m_msConfig->m_tenantId : "common"_t) +
        "/oauth2/v2.0/token"_t);

    {
        // acquire lock
        std::unique_lock lock{m_tokenLock};
        if (m_msConfig->m_expires_at <= std::time(0)) {
            setupSslOptions();
            http_client login(U_STRING_T(url));
            if (!m_msConfig->isValid())
                return APERR(Ec::Empty, "Credentials not found!");

            Text refreshToken = m_msConfig->m_refreshToken;

            // check value stored in key-value storage
            keystore::KeyStorePtr keyStore{nullptr};
            if (!m_msConfig->m_isEnterprise && m_parentEndpoint) {
                if (keyStore = m_parentEndpoint->getKeyStore()) {
                    auto ccode = keyStore->getSecureValue(REFRESH_TOKEN_KEY);
                    if (ccode.hasValue()) {
                        const auto &storedValue = ccode.value();
                        auto splitted = storedValue.split("/");
                        if (splitted.size() >= 2 &&
                            splitted[0] == m_msConfig->m_refreshTokenHash)
                            refreshToken = splitted[1];
                    }
                }
            }

            Text body{"client_id=" + m_msConfig->m_clientId +
                      "&client_secret=" + m_msConfig->m_clientSecret};
            body.append(
                m_msConfig->m_isEnterprise
                    ? "&grant_type=client_credentials&scope=.default"_t
                    : "&grant_type=refresh_token&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default+offline_access+openid+profile&refresh_token="_t +
                          urlEncode(refreshToken));

            http_headers headers;
            http_response response;
            unsigned short int retries = 0;
            headers.add(U_STRING_T("Content-Type"),
                        U_STRING_T("application/x-www-form-urlencoded"));
            do {
                auto ccode = request<Text>(login, methods::POST, body, headers);
                if (ccode.hasCcode())
                    return APERR(Ec::NotFound,
                                 "Credential failed, please check");

                // init the expiry time
                if (updateTokenExpireAt)
                    m_msConfig->m_expires_at = std::time(0);

                response = ccode.value();
                if (!(response.status_code() == status_codes::OK)) {
                    if (++retries > MS_MAX_TOKEN_RETRIES)
                        return APERR(
                            Ec::NotFound,
                            "Credential failed, please check, error code: ",
                            response.status_code());

                    waitBeforeNextRequest();
                    continue;
                }
                break;
            } while (true);

            web::json::value value = extract_data<web::json::value>(
                response,
                [](http_response &res) { return res.extract_json(); });

            web::json::object object = value.as_object();

            if (object[U_STRING_T("access_token")].is_null() ||
                object[U_STRING_T("expires_in")].is_null() ||
                object[U_STRING_T("token_type")].is_null()) {
                return APERR(Ec::NotFound, "Credential failed, please check");
            }

            // store refresh token in keystore if needed
            if (keyStore && hasField(object, "refresh_token")) {
                Text newRefreshToken =
                    object.at(U_STRING_T("refresh_token")).as_string();
                keyStore->setSecureValue(
                    REFRESH_TOKEN_KEY,
                    m_msConfig->m_refreshTokenHash + "/" + newRefreshToken);
            }

            oauth2_token token;
            token.set_access_token(
                object[U_STRING_T("access_token")].as_string());
            token.set_expires_in(object[U_STRING_T("expires_in")].as_integer());
            token.set_token_type(object[U_STRING_T("token_type")].as_string());

            int64_t expiry = token.expires_in();
            // expire our token 5 minutes before actual expiry, 300 sec = 5 min
            // this is to make sure that we do not fail during a request
            int64_t expiresIn =
                expiry > EARLY_REQUEST ? expiry - EARLY_REQUEST : expiry;
            if (updateTokenExpireAt) m_msConfig->m_expires_at += expiresIn;

            oauth2_config m_oauth2_config(
                m_msConfig->m_clientId, m_msConfig->m_clientSecret,
                U_STRING_T("dummy"), U_STRING_T("dummy"), U_STRING_T("dummy"));
            m_oauth2_config.set_token(token);
            m_msConfig->m_http_config.set_oauth2(m_oauth2_config);
        }
        // lock released
    }
    m_api.reset(new http_client(U_STRING_T(GRAPH_API_ENDPOINT),
                                m_msConfig->m_http_config));
    return {};
}

//-----------------------------------------------------------------
/// @details
///		make a request with http_request
///	@param[in]	request
///		http_request to be requested
///	@returns
///		http_response
//------------------------------------------------------------------
ErrorOr<const http_response> MsNode::request(
    const http_request &request) noexcept {
    if (!m_api) return APERR(Ec::Failed, "Client not initialized");
    if (m_msConfig->m_expires_at <= std::time(0))
        if (auto ccode = requestToken()) return ccode;

    // pplx::task can fail, for eg network issue.
    // When it fails, it throws an exception, we should catch it and retry again
    try {
        pplx::task<http_response> task = m_api->request(request);
        auto taskComplete = task.wait();
        if (taskComplete != pplx::task_group_status::completed)
            return APERR(Ec::RequestFailed, "Task did not complete, retry");
        return task.get();
    } catch (...) {
        return APERR(Ec::RequestFailed, "Task did not complete, retry");
    }
}

//-----------------------------------------------------------------
/// @details
///		request with a method, this method create a request
///	@param[in]	mtd
///		filePath of the file
///	@param[in]	url
///		id of the path
///	@param[in]	header
///		http header
///	@returns
///		http_response
//------------------------------------------------------------------
ErrorOr<const http_response> MsNode::request(
    const method &mtd, Text url, const http_headers &header) noexcept {
    int retries = 0;
    do {
        http_request req(mtd);
        utility::string_t urlMessages = utility::string_t() + U_STRING_T(url);
        req.headers() = header;
        req.set_request_uri(urlMessages);
        auto reqCcode = request(req);
        if (reqCcode.hasCcode()) {
            waitBeforeNextRequest();
            ++retries;
            continue;
        }
        http_response response = reqCcode.value();

        auto ccode = checkAndWait(response, retries);
        if (ccode) {
            continue;
        }
        return response;
    } while (retries < MS_MAX_RETRIES);

    return APERR(Ec::Warning, "request failed after ", retries);
}

//-----------------------------------------------------------------
/// @details
///		request with a method, this method create a request
///	@param[in]	mtd
///		filePath of the file
///	@param[in]	url
///		id of the path
///	@param[in]	body
///		body of the request
///	@param[in]	header
///		http header
///	@returns
///		http_response
//------------------------------------------------------------------
template <class T>
ErrorOr<const http_response> MsNode::request(
    const method &mtd, Text url, T &body, const http_headers &header) noexcept {
    int retries = 0;
    do {
        http_request req(mtd);
        utility::string_t urlMessages = utility::string_t() + U_STRING_T(url);
        req.headers() = header;
        req.set_request_uri(urlMessages);
        req.set_body(body);
        auto reqCcode = request(req);
        if (reqCcode.hasCcode()) {
            waitBeforeNextRequest();
            ++retries;
            continue;
        }
        http_response response = reqCcode.value();

        auto ccode = checkAndWait(response, retries);
        if (ccode) {
            continue;
        }
        return response;
    } while (retries < MS_MAX_RETRIES);

    return APERR(Ec::Warning, "request failed after ", retries);
}

//-----------------------------------------------------------------
/// @details
///		request with a method, this method create a request
///	@param[in]	http_client
///		http_client
///	@param[in]	mtd
///		filePath of the file
///	@param[in]	header
///		http header
///	@returns
///		http_response
//------------------------------------------------------------------
ErrorOr<const http_response> MsNode::request(
    http_client &client, const method &mtd,
    const http_headers &header) noexcept {
    int retries = 0;
    do {
        http_request req(mtd);
        req.headers() = header;

        auto reqCcode = requestAndCheck(client, req, retries);
        if (reqCcode.hasCcode()) {
            waitBeforeNextRequest();
            continue;
        }
        http_response response = reqCcode.value();

        auto ccode = checkAndWait(response, retries);
        if (ccode) {
            continue;
        }
        return response;
    } while (retries < MS_MAX_RETRIES);

    return APERR(Ec::Warning, "request failed after ", retries);
}
//-----------------------------------------------------------------
/// @details
///		request with a method, this method create a request
///	@param[in]	http_client
///		http_client
///	@param[in]	mtd
///		filePath of the file
///	@param[in]	body
///		body of the request
///	@param[in]	header
///		http header
///	@returns
///		http_response
//------------------------------------------------------------------
template <class T>
ErrorOr<const http_response> MsNode::request(
    http_client &client, const method &mtd, T &body,
    const http_headers &header) noexcept {
    int retries = 0;
    do {
        http_request req(mtd);
        req.headers() = header;
        req.set_body(body);

        auto reqCcode = requestAndCheck(client, req, retries);
        if (reqCcode.hasCcode()) {
            waitBeforeNextRequest();
            continue;
        }
        http_response response = reqCcode.value();

        auto ccode = checkAndWait(response, retries);
        if (ccode) {
            continue;
        }
        return response;
    } while (retries < MS_MAX_RETRIES);

    return APERR(Ec::Warning, "request failed after ", retries);
}

//-----------------------------------------------------------------
/// @details
///		request with a method, this method create a request
///	@param[in]	http_client
///		http_client
///	@param[in]	mtd
///		filePath of the file
///	@param[in]	header
///		http header
///	@returns
///		http_response
//------------------------------------------------------------------
ErrorOr<const http_response> MsNode::requestWithCallBack(
    RequestCallBack callback, const std::vector<web::http::status_code> &codes,
    const unsigned short int max_retries) noexcept {
    http_response response;
    unsigned int retries = 0;
    do {
        auto ccode = callback();

        if (ccode.hasCcode()) {
            ++retries;
            continue;
        }

        response = ccode.value();
        if (hasStatusCode(codes, response.status_code())) {
            return response;
        }
        if (++retries > max_retries) {
            return MONERR(warning, Ec::Warning, "request failed",
                          response.status_code(), "after:", retries,
                          " retries");
        }
        waitBeforeNextRequest();

    } while (retries < max_retries);

    if (retries >= max_retries)
        return MONERR(warning, Ec::Warning, "request failed",
                      response.status_code(), "after:", retries, " retries");
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Get user id of the user
///	@param[in]	user
///		user name
///	@returns
///		user id
//------------------------------------------------------------------
ErrorOr<Text> MsNode::getUserId(const Text &user) noexcept {
    if (!m_api) return APERR(Ec::RequestFailed, "Client not initialized");

    if (m_msConfig->m_expires_at <= std::time(0))
        if (auto ccode = requestToken()) return ccode;

    const RequestCallBack requestCallBack =
        [this, &user]() -> ErrorOr<const http_response> {
        return request(methods::GET, Text("users/") + Text(user));
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     MS_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "User not found", user);

    http_response response = ccode.value();
    if (response.status_code() != status_codes::OK) {
        return APERR(Ec::Failed,
                     "Request failed with error code:", response.status_code());
    }

    web::json::value value = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    return value[U_STRING_T("id")].as_string();
}

//-----------------------------------------------------------------
/// @details
///		Get user id of the user
///	@param[in]	user
///		user name
///	@returns
///		user id
//------------------------------------------------------------------
ErrorOr<Text> MsNode::getUserMailAddress(const Text &userId) noexcept {
    if (!m_api) return APERR(Ec::RequestFailed, "Client not initialized");
    if (m_msConfig->m_expires_at <= std::time(0))
        if (auto ccode = requestToken()) return ccode;

    const RequestCallBack requestCallBack =
        [this, &userId]() -> ErrorOr<const http_response> {
        return request(methods::GET,
                       Text("users/") + Text(userId) +
                           Text("?$select=mail,userPrincipalName,identities"));
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     MS_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "User not found", userId);

    http_response response = ccode.value();
    if (response.status_code() != status_codes::OK) {
        return APERR(Ec::Failed,
                     "Request failed with error code:", response.status_code());
    }

    try {
        // Extract JSON data
        web::json::value value = extract_data<web::json::value>(
            response, [](http_response &res) { return res.extract_json(); });

        // Check if the JSON contains the "mail" field
        if (value.has_field(U_STRING_T("mail")) &&
            !value[U_STRING_T("mail")].is_null()) {
            return value[U_STRING_T("mail")].as_string();
        }

        if (value.has_field(U_STRING_T("identities")) &&
            value[U_STRING_T("identities")].is_array()) {
            web::json::array identities =
                value[U_STRING_T("identities")].as_array();
            for (web::json::value &identity : identities) {
                if (identity.has_field(U_STRING_T("signInType")) &&
                    identity[U_STRING_T("signInType")].as_string() ==
                        U_STRING_T("emailAddress") &&
                    identity.has_field(U_STRING_T("issuerAssignedId"))) {
                    return identity[U_STRING_T("issuerAssignedId")].as_string();
                }
            }
        }

        if (value.has_field(U_STRING_T("userPrincipalName")) &&
            !value[U_STRING_T("userPrincipalName")].is_null()) {
            return value[U_STRING_T("userPrincipalName")].as_string();
        } else {
            return MONERR(warning, Ec::Warning, "User email not found", userId);
        }
    } catch (const std::exception &e) {
        // Capture and log detailed exception info
        return MONERR(warning, Ec::Warning,
                      "JSON extraction or parsing failed:", e.what());
    } catch (...) {
        // Log unknown errors for additional insights
        return MONERR(warning, Ec::Warning,
                      "An unknown error occurred during JSON extraction");
    }
}

//-----------------------------------------------------------------
/// @details
///		get all users
///	@returns
///		list of all the users
//------------------------------------------------------------------
ErrorOr<const std::list<Text>> MsNode::getAllUsers() noexcept {
    if (!m_api) return APERR(Ec::RequestFailed, "Client not initialized");

    if (m_msConfig->m_expires_at <= std::time(0))
        if (auto ccode = requestToken()) return ccode;

    std::list<Text> users;

    http_headers header;
    header.add(U_STRING_T("Prefer"), U_STRING_T("odata.maxpagesize=1000"));

    // get all values, with nextLinks
    auto ccode = m_msConfig->m_isEnterprise
                     ? requestValues(methods::GET, Text("users/"), header)
                     : requestValue(methods::GET, Text("me/"), header);
    if (ccode.hasCcode()) return ccode.ccode();

    MsContainer values = ccode.value();
    if (values.getStatusCode() != status_codes::OK) {
        return APERR(Ec::Failed,
                     "Request failed with error code:", values.getStatusCode());
    }

    for (const auto &allValues : values.getValues()) {
        for (const auto &user : allValues) {
            if (hasField(user, "userPrincipalName")) {
                users.push_back(
                    user.at(U_STRING_T("userPrincipalName")).as_string());
            }
        }
    }

    return users;
}

MsContainer::MsContainer() noexcept : m_syncToken() {}

MsContainer::MsContainer(Text syncToken,
                         std::list<web::json::array> values) noexcept
    : m_syncToken(syncToken), m_values(values) {}

MsContainer::MsContainer(const MsContainer &value) noexcept
    : m_syncToken(value.m_syncToken),
      m_values(value.m_values),
      m_statusCode(value.m_statusCode),
      m_isDelta(value.m_isDelta) {}
MsContainer::MsContainer(MsContainer &&value) noexcept
    : m_syncToken(std::move(value.m_syncToken)),
      m_values(std::move(value.m_values)),
      m_statusCode(std::move(value.m_statusCode)),
      m_isDelta(std::move(value.m_isDelta)) {}

MsContainer &MsContainer::operator=(const MsContainer &value) noexcept {
    m_syncToken = value.m_syncToken;
    m_values = value.m_values;
    m_statusCode = value.m_statusCode;
    m_isDelta = value.m_isDelta;
    return *this;
}
MsContainer::~MsContainer() noexcept {}

//-----------------------------------------------------------------
/// @details
///		get sync token
///	@returns
///		returns syncToken
//------------------------------------------------------------------
const Text &MsContainer::syncToken() const noexcept { return m_syncToken; }

std::list<web::json::array> MsContainer::getValues() const noexcept {
    return m_values;
}

void MsContainer::setSyncToken(const Text &syncToken) noexcept {
    m_syncToken = syncToken;
}

void MsContainer::pushValues(web::json::array values) noexcept {
    m_values.push_back(values);
}

void MsContainer::insertList(std::list<web::json::array> &values) noexcept {
    m_values.splice(m_values.end(), values);
}

const web::http::status_code &MsContainer::getStatusCode() const noexcept {
    return m_statusCode;
}
void MsContainer::setStatusCode(
    const web::http::status_code statusCode) noexcept {
    m_statusCode = statusCode;
}

void MsContainer::setIsDelta(const bool isDelta) noexcept {
    m_isDelta = isDelta;
}

void MsContainer::cleanValues() noexcept { m_values.clear(); }

bool MsContainer::isDelta() const noexcept { return m_isDelta; }

ErrorOr<const http_response> MsNode::requestAndCheck(
    http_client &client, const http_request &request, int &retries) noexcept {
    http_response response;

    // pplx::task can fail, for eg network issue.
    // When it fails, it thorws an exception, we should catch it and retry again
    try {
        pplx::task<http_response> task = client.request(request);
        auto taskComplete = task.wait();
        if (taskComplete != pplx::task_group_status::completed) {
            ++retries;
            return APERR(Ec::RequestFailed, "Task did not complete, retry");
        }
        response = task.get();
    } catch (...) {
        ++retries;
        return APERR(Ec::RequestFailed, "Task did not complete, retry");
    }
    return response;
}

Error MsNode::checkAndWait(http_response &response, int &retries) noexcept {
    if (response.status_code() == status_codes::TooManyRequests) {
        if (++retries < MS_MAX_RETRIES) {
            waitBeforeNextRequestThrottled(response);
        }
        return APERR(Ec::Warning, "request failed after ", retries);
    }
    return {};
}

//------------------------------------------------------------------
/// @details
///		get values from a http_request and callback with values
///	@param[in]	mtd
///		request method
/// @param[in] callback
///		callback function
/// @param[in] header [optional]
///		request header
/// @param[in] deltaKey [optional]
///		deltaKey for delta values, differs in different MS nodes
///	@returns
///		values
//------------------------------------------------------------------
ErrorOr<MsContainer> MsNode::requestValuesWithCallBack(
    const method &mtd, Text url, const ScanCallBack &callback, bool isDelta,
    const http_headers &header, const Text deltaKey) noexcept {
    MsContainer msContainer;
    msContainer.setIsDelta(isDelta);
    // callback function for request
    const RequestCallBack requestCallBack =
        [this, &mtd, &url, &header]() -> ErrorOr<const http_response> {
        return request(mtd, url, header);
    };

    // make a request and check for codes OK, NOTFOUND or GONE
    auto ccode = requestWithCallBack(
        requestCallBack, CODE_FOR_OK_OR_NOT_FOUND_WITH_DELTA, MS_MAX_RETRIES);

    // Error or response code is NOTFOUND
    if (ccode.hasCcode() ||
        ccode.value().status_code() == web::http::status_codes::NotFound)
        return MONERR(warning, Ec::Warning, "Items not found", url);

    http_response response = ccode.value();

    // Set status code in mscontainer
    msContainer.setStatusCode(response.status_code());
    if (response.status_code() == status_codes::Gone) {
        msContainer.setIsDelta(false);
        return msContainer;
    }

    // Get json data
    web::json::value responseValue = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    web::json::array values = responseValue[U_STRING_T("value")].as_array();
    msContainer.pushValues(values);
    // callback
    if (auto callbackCcode = callback(msContainer)) {
        MONERR(warning, Ec::Warning, "Call back failed");
        msContainer.cleanValues();
    }
    // get next link values
    while (responseValue.has_field(U_STRING_T("@odata.nextLink"))) {
        // check if config has expired
        if (m_msConfig->m_expires_at <= std::time(0))
            if (auto ccode = requestToken()) {
                callback(msContainer);
                return msContainer;
            }

        http_client tempClient(
            responseValue[U_STRING_T("@odata.nextLink")].as_string(),
            getHttpConfig());
        const RequestCallBack requestCallBackNextLink =
            [this, &tempClient]() -> ErrorOr<const http_response> {
            return request(tempClient, methods::GET);
        };

        // make a request and check for codes OK, NOTFOUND
        auto ccode = requestWithCallBack(
            requestCallBackNextLink, CODE_FOR_OK_OR_NOT_FOUND, MS_MAX_RETRIES);

        // Error or response code is NOTFOUND
        if (ccode.hasCcode() ||
            ccode.value().status_code() == web::http::status_codes::NotFound) {
            MONERR(warning, Ec::Warning, "Items not found",
                   responseValue[U_STRING_T("@odata.nextLink")].as_string());
            break;
        }
        http_response responseNextLink = ccode.value();

        responseValue = extract_data<web::json::value>(
            responseNextLink,
            [](http_response &res) { return res.extract_json(); });

        web::json::array nextLinkValues =
            responseValue[U_STRING_T("value")].as_array();
        msContainer.pushValues(nextLinkValues);

        // callback
        if (auto callbackCcode = callback(msContainer)) {
            MONERR(warning, Ec::Warning, "Call back failed");
            msContainer.cleanValues();
            // break the loop, entries failed to be added.
            break;
        }
        msContainer.cleanValues();
    }
    if (responseValue.has_field(U_STRING_T("@odata.deltaLink"))) {
        Text deltaLink(
            responseValue[U_STRING_T("@odata.deltaLink")].as_string());
        auto test = deltaLink.slice(deltaKey);
        msContainer.setSyncToken(Text(test.second));
    }
    return msContainer;
}

//------------------------------------------------------------------
/// @details
///		get values from a http_request
///	@param[in]	req
///		http_request
///	@returns
///		values
//------------------------------------------------------------------
ErrorOr<MsContainer> MsNode::requestValues(const method &mtd, Text url,
                                           const http_headers &header,
                                           const Text deltaKey) noexcept {
    MsContainer msContainer;
    const RequestCallBack requestCallBack =
        [this, &mtd, &url, &header]() -> ErrorOr<const http_response> {
        return request(mtd, url, header);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_WITH_DELTA,
                                     MS_MAX_RETRIES);
    if (ccode.hasCcode())
        return MONERR(warning, Ec::Warning, "Items not found", url);

    http_response response = ccode.value();
    msContainer.setStatusCode(response.status_code());
    if (response.status_code() == status_codes::Gone) {
        return msContainer;
    }
    web::json::value responseValue = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    web::json::array values = responseValue[U_STRING_T("value")].as_array();
    msContainer.pushValues(values);
    while (responseValue.has_field(U_STRING_T("@odata.nextLink"))) {
        // check if config has expired
        if (m_msConfig->m_expires_at <= std::time(0))
            if (auto ccode = requestToken()) {
                return msContainer;
            }

        http_client tempClient(
            responseValue[U_STRING_T("@odata.nextLink")].as_string(),
            getHttpConfig());
        const RequestCallBack requestCallBackNextLink =
            [this, &tempClient]() -> ErrorOr<const http_response> {
            return request(tempClient, methods::GET);
        };

        auto ccode = requestWithCallBack(requestCallBackNextLink, CODE_FOR_OK,
                                         MS_MAX_RETRIES);
        if (ccode.hasCcode()) {
            MONERR(warning, Ec::Warning, "Items not found");
            break;
        }
        http_response responseNextLink = ccode.value();

        responseValue = extract_data<web::json::value>(
            responseNextLink,
            [](http_response &res) { return res.extract_json(); });

        web::json::array nextLinkValues =
            responseValue[U_STRING_T("value")].as_array();
        msContainer.pushValues(nextLinkValues);
    }
    if (responseValue.has_field(U_STRING_T("@odata.deltaLink"))) {
        Text deltaLink(
            responseValue[U_STRING_T("@odata.deltaLink")].as_string());
        auto test = deltaLink.slice(deltaKey);
        msContainer.setSyncToken(Text(test.second));
    }
    return msContainer;
}

//-----------------------------------------------------------------
/// @details
///		get a value from http_request
///	@param[in]	req
///		http_request
///	@returns
///		value
//------------------------------------------------------------------
ErrorOr<MsContainer> MsNode::requestValue(const method &, Text url,
                                          const http_headers &header) noexcept {
    MsContainer msContainer;
    http_response response;

    const RequestCallBack requestCallBack =
        [this, &url, &header]() -> ErrorOr<const http_response> {
        return request(methods::GET, url, header);
    };

    auto ccode = requestWithCallBack(requestCallBack, CODE_FOR_OK_OR_NOT_FOUND,
                                     MS_MAX_RETRIES);
    if (ccode.hasCcode()) return MONERR(warning, Ec::Warning, "Item not found");
    response = ccode.value();

    msContainer.setStatusCode(response.status_code());

    if (response.status_code() != status_codes::OK) {
        return APERR(Ec::Failed,
                     "Request failed with error code:", response.status_code());
    }

    web::json::value responseValue = extract_data<web::json::value>(
        response, [](http_response &res) { return res.extract_json(); });

    // create array of 1, MsContainer works with array
    web::json::value values = web::json::value::array(1);
    // add response value to array
    values[0] = responseValue;
    msContainer.pushValues(values.as_array());
    return msContainer;
}

//-----------------------------------------------------------------
/// @details
///		API throttled, wait for seconds
///	@param[in]	response
///		http_response
//------------------------------------------------------------------
void MsNode::waitBeforeNextRequestThrottled(http_response &response) noexcept {
    // default 60 seconds
    string_t waitInSec(U_STRING_T(std::to_string(DEFAULT_THROTTLE_WAIT)));

    // Get the Retry-After from the response
    // response header contains Retry-After
    if (response.headers().has(U_STRING_T("Retry-After")))
        waitInSec = response.headers()[U_STRING_T("Retry-After")];

    MONERR(warning, Ec::Warning,
           "Request to Graph API is throttled, waiting for", waitInSec,
           " seconds");

    try {
        int value = std::stoi(waitInSec.c_str());
        ap::async::sleep(time::seconds(value));
    } catch (...) {
        // stoi failed, sleep for 60 seconds
        ap::async::sleep(time::seconds(DEFAULT_THROTTLE_WAIT));
    }
}

}  // namespace engine::store::filter::msNode

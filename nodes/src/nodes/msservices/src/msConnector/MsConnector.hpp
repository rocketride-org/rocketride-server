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

#define U_STRING_T(x) utility::conversions::to_string_t(x)

//-----------------------------------------------------------------------------
//
//	Defines the interface for the Graph Api endpoint
//
//-----------------------------------------------------------------------------

namespace engine::store::filter::msNode {
using namespace utility;
using namespace web::http;
using namespace web::http::client;
class MsContainer;

using SetSyncTokenCallBack = std::function<Error(TextView, TextView)>;
using GetSyncTokenCallBack = std::function<ErrorOr<Text>(TextView)>;
using RequestCallBack = std::function<ErrorOr<const http_response>()>;

using ScanCallBack = std::function<Error(MsContainer &)>;

static const unsigned short int MS_MAX_RETRIES = 10;

// token max retries
static const unsigned short int MS_MAX_TOKEN_RETRIES = 4;

// Graph Api endpoint
static const Text GRAPH_API_ENDPOINT = "https://graph.microsoft.com/v1.0/";

// Graph Api oAuth endpoint
static const Text GRAPH_API_OAUTH_ENDPOINT =
    "https://login.microsoftonline.com/";

// 5 mins in seconds
static const int64_t EARLY_REQUEST = 300;

// Default wait before next request
static const int8_t DEFAULT_WAIT = 15;

// Default wait before next throttle request
static const int8_t DEFAULT_THROTTLE_WAIT = 60;

// delta key
static const Text DELTA_KEY = "deltatoken=";

inline static web::json::value &getValue(web::json::value &value,
                                         Text key) noexcept {
    return value[U_STRING_T(key)];
}

inline static bool hasField(const web::json::value &value, Text key) noexcept {
    return value.has_field(U_STRING_T(key));
}

inline static bool hasField(const web::json::object &object,
                            Text key) noexcept {
    return object.find(U_STRING_T(key)) != object.end();
}

inline static void waitBeforeNextRequest() noexcept {
    ap::async::sleep(time::seconds(DEFAULT_WAIT));
}

// predefined status codes
static const std::vector<web::http::status_code> CODE_FOR_OK = {
    web::http::status_codes::OK};

static const std::vector<web::http::status_code> CODE_FOR_OK_WITH_DELTA = {
    web::http::status_codes::OK, web::http::status_codes::Gone};

static const std::vector<web::http::status_code>
    CODE_FOR_OK_OR_NOT_FOUND_WITH_DELTA = {web::http::status_codes::OK,
                                           web::http::status_codes::NotFound,
                                           web::http::status_codes::Gone};

static const std::vector<web::http::status_code> CODES_FOR_FILE_CREATED = {
    web::http::status_codes::OK, web::http::status_codes::Accepted,
    web::http::status_codes::Created};

static const std::vector<web::http::status_code> CODE_FOR_DELETED = {
    web::http::status_codes::NoContent};

static const std::vector<web::http::status_code> CODE_FOR_OK_OR_NOT_FOUND = {
    web::http::status_codes::OK, web::http::status_codes::NotFound};

inline static bool hasStatusCode(
    const std::vector<web::http::status_code> &codes,
    web::http::status_code code) noexcept {
    auto result = std::find(codes.begin(), codes.end(), code);
    return result != codes.end();
}

struct MsConfig {
    bool m_isEnterprise;
    Text m_tenantId;
    Text m_clientId;
    Text m_clientSecret;
    Text m_refreshToken;
    time_t m_expires_at;

    Text m_refreshTokenHash;
    //-------------------------------------------------------------------------
    /// @details
    ///		http client config for the connection
    //-------------------------------------------------------------------------
    http_client_config m_http_config;

    MsConfig()
        : m_isEnterprise(true), m_expires_at(std::time(0)), m_http_config() {}

    MsConfig(const MsConfig &) = delete;
    MsConfig(MsConfig &&) = delete;
    MsConfig &operator=(const MsConfig &) = delete;
    MsConfig &operator=(MsConfig &&) = delete;

    //-------------------------------------------------------------------------
    /// @details
    ///		Check if MsConfig is valid.
    ///	@returns
    ///		Boolean
    //-------------------------------------------------------------------------
    bool isValid() {
        return
            // client && secret should always be set
            !m_clientId.empty() && !m_clientSecret.empty() &&
            (
                // for enterprise, tenant should be set
                (m_isEnterprise && !m_tenantId.empty()) ||
                // for personal, refresh token should be set
                (!m_isEnterprise && !m_refreshToken.empty()));
    }
};

class MsContainer {
public:
    MsContainer() noexcept;
    MsContainer(Text, std::list<web::json::array>) noexcept;
    ~MsContainer() noexcept;
    MsContainer(const MsContainer &) noexcept;
    MsContainer(MsContainer &&) noexcept;
    MsContainer &operator=(const MsContainer &v) noexcept;
    const Text &syncToken() const noexcept;
    std::list<web::json::array> getValues() const noexcept;
    void setSyncToken(const Text &syncToken) noexcept;
    void pushValues(web::json::array) noexcept;
    void insertList(std::list<web::json::array> &values) noexcept;

    const web::http::status_code &getStatusCode() const noexcept;
    void setStatusCode(const web::http::status_code) noexcept;
    void setIsDelta(const bool value) noexcept;
    bool isDelta() const noexcept;
    void cleanValues() noexcept;

private:
    //-------------------------------------------------------------------------
    /// @details
    ///		syncToken(delta) for the request
    //-------------------------------------------------------------------------
    Text m_syncToken;

    //-------------------------------------------------------------------------
    /// @details
    ///		status code of the response
    //-------------------------------------------------------------------------
    web::http::status_code m_statusCode;

    //-------------------------------------------------------------------------
    /// @details
    ///		specifies if the request is delta or full
    //-------------------------------------------------------------------------
    bool m_isDelta;

    //-------------------------------------------------------------------------
    /// @details
    ///		values from the response
    //-------------------------------------------------------------------------
    std::list<web::json::array> m_values;

public:
    //-------------------------------------------------------------------------
    /// @details
    ///		helper function to convert Graph API Date and time to time_t
    /// @param[in]	dt
    ///		Graph Api format date and time
    ///	@returns
    ///		time_t
    //-------------------------------------------------------------------------
    static time_t convertFromGraphAPIDateTime(
        const utility::datetime &dt) noexcept {
        // best description of the constant:
        // https://stackoverflow.com/questions/6161776/convert-windows-filetime-to-second-in-unix-linux
        constexpr long long _seconds_to_unix_epoch = 11644473600LL;

        static const utility::datetime::interval_type _msTicks =
            static_cast<utility::datetime::interval_type>(10000);
        static const utility::datetime::interval_type _secondTicks =
            1000 * _msTicks;

        const auto seconds = dt.to_interval() / _secondTicks;
        if (seconds >= _seconds_to_unix_epoch) {
            return seconds - _seconds_to_unix_epoch;
        } else {
            return -1;
        }
    }
};

class MsNode {
public:
    MsNode() : m_parentEndpoint{nullptr}, m_api(), m_msConfig() {}
    MsNode(std::shared_ptr<MsConfig> msConfig, IServiceEndpoint *parentEndpoint)
        : m_parentEndpoint(parentEndpoint), m_msConfig(msConfig), m_api() {}

    MsNode(const MsNode &) = delete;
    MsNode(MsNode &&) = delete;
    MsNode &operator=(const MsNode &) = delete;
    MsNode &operator=(MsNode &&) = delete;

    virtual ~MsNode() {}

    void updateConfig(std::shared_ptr<MsConfig> msConfig) noexcept;
    Error requestToken(bool updateTokenExpireAt = true) noexcept;
    ErrorOr<Text> getUserId(const Text &user) noexcept;
    ErrorOr<Text> getUserMailAddress(const Text &userId) noexcept;
    ErrorOr<const std::list<Text>> getAllUsers() noexcept;

    ErrorOr<const http_response> request(
        const method &, Text url,
        const http_headers &header = http_headers()) noexcept;
    template <class T>
    ErrorOr<const http_response> request(const method &, Text url, T &body,
                                         const http_headers &header) noexcept;
    template <class T>
    ErrorOr<const http_response> request(http_client &client, const method &,
                                         T &body,
                                         const http_headers &header) noexcept;
    ErrorOr<const http_response> request(
        http_client &client, const method &,
        const http_headers &header = http_headers()) noexcept;

    ErrorOr<const http_response> requestWithCallBack(
        RequestCallBack callback,
        const std::vector<web::http::status_code> &codes,
        const unsigned short int max_retries) noexcept;

protected:
    http_client_config getHttpConfig() { return m_msConfig->m_http_config; }

    // Template function to extract data from an HTTP response and handle errors
    template <typename T, typename F>
    T extract_data(http_response &response, F extract_fn) noexcept {
        // Extract the data from the response body
        pplx::task<T> task = extract_fn(response);

        try {
            // Wait for the data to become available
            task.wait();

            // Get the data object
            T data = task.get();

            // Return the data object
            return data;
        } catch (...) {
            // Handle the exception
            MONERR(warning, Ec::Warning, "Extract task did not complete");

            // Return an empty object if there was an error
            return T();
        }
    }
    //-------------------------------------------------------------------------
    /// @details
    ///		MsConfig with credentials for the connection
    //-------------------------------------------------------------------------
    std::shared_ptr<MsConfig> m_msConfig;

    ErrorOr<MsContainer> requestValues(
        const method &, Text url, const http_headers &header = http_headers(),
        const Text deltaKey = DELTA_KEY) noexcept;
    ErrorOr<MsContainer> requestValuesWithCallBack(
        const method &, Text url, const ScanCallBack &callback,
        bool isDelta = false, const http_headers &header = http_headers(),
        const Text deltaKey = DELTA_KEY) noexcept;
    ErrorOr<MsContainer> requestValue(
        const method &, Text url,
        const http_headers &header = http_headers()) noexcept;

private:
    //-------------------------------------------------------------------------
    /// @details
    ///		Pointer to the parent filter (not owned by this class)
    //-------------------------------------------------------------------------
    IServiceEndpoint *m_parentEndpoint;

    //-------------------------------------------------------------------------
    /// @details
    ///		Http client to make connection
    //-------------------------------------------------------------------------
    std::shared_ptr<http_client> m_api;

    ErrorOr<const http_response> request(const http_request &request) noexcept;
    inline void setupSslOptions() noexcept(false);
    ErrorOr<const http_response> requestAndCheck(http_client &client,
                                                 const http_request &request,
                                                 int &retries) noexcept;
    Error checkAndWait(http_response &response, int &retries) noexcept;
    void waitBeforeNextRequestThrottled(http_response &response) noexcept;
    //-----------------------------------------------------------------
    /// @details
    ///     lock to get token
    //-----------------------------------------------------------------
    std::mutex m_tokenLock;
};
}  // namespace engine::store::filter::msNode

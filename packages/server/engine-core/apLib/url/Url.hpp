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

namespace ap::url {
class Url;

//-------------------------------------------------------------------------
// Define the mapping functions to map a url to a path, an os path and
// back
//-------------------------------------------------------------------------
class UrlConfig {
public:
    //-----------------------------------------------------------------
    /// @details
    ///		Define attributes for the tags. If you add flags, you
    ///		should probably add them to the services.cpp as well so
    ///		the can be specified in the service definitions
    //-----------------------------------------------------------------
    class PROTOCOL_CAPS {
    public:
        _const uint32_t SECURITY =
            BIT(0);  // Supports the file permissions interface
        _const uint32_t FILESYSTEM = BIT(1);  // Is a filesystem interface
        _const uint32_t SUBSTREAM = BIT(2);  // Supports the substream interface
        _const uint32_t NETWORK = BIT(3);    // Uses a network interface
        _const uint32_t DATANET =
            BIT(4);  // Uses datanet or streamnet interfaces
        _const uint32_t SYNC = BIT(
            5);  // Uses delta queries to track changes in Microsoft Graph data
        _const uint32_t INTERNAL =
            BIT(6);  // Internal - will not be returned in services.json
        _const uint32_t CATALOG = BIT(7);  // Supports data catalog operations
        _const uint32_t NOMONITOR =
            BIT(8);  // Do not monitor for excessive failures
        _const uint32_t NOINCLUDE =
            BIT(9);  // Source endpoint does not use include, just call
                     // scanObjects with an empty path
        _const uint32_t INVOKE =
            BIT(10);  // Does this driver support the invoke function?
        _const uint32_t REMOTING =
            BIT(11);  // Does this driver support the remoting execution?
        _const uint32_t GPU = BIT(12);     // Does this driver requires a GPU?
        _const uint32_t NOSAAS = BIT(13);  // Driver is not saas compat
        _const uint32_t FOCUS = BIT(14);   // Focus on this the driver
    };

    //-----------------------------------------------------------------
    /// @details
    ///		Defines the struct which contains the mapping functions for
    ///		each protocol type
    //-----------------------------------------------------------------
    struct Mapper {
        // The capabilities
        uint32_t capabilities;

        // The protocol we are mapping
        iTextView protocol;

        // Creates a url from a non-prefixed path
        std::function<Error(const iTextView fromProtocol,
                            const file::Path& fromPath, Url& toUrl)>
            toUrl;

        // Removes any prefixes that may be preset
        std::function<Error(const Url& fromUrl, file::Path& toPath)> toPath;

        // Creates the OS path
        std::function<Error(const Url& fromUrl, Text& toPath)> osPath;

        // Validate the url
        std::function<Error(const Url& url)> validate;
    };

    //-----------------------------------------------------------------
    /// @details
    /// 	Declare a Ptr to a mapper
    //-----------------------------------------------------------------
    using MapperPtr = Mapper*;
    using Mappers = std::map<iText, Mapper>;

    //-----------------------------------------------------------------
    /// @details
    /// 	Adds a new protocol type - usually a static declaration
    //-----------------------------------------------------------------
    UrlConfig(const Mapper& mapper) { m_UrlConfig[mapper.protocol] = mapper; }

    static Error registerMapper(UrlConfig::Mapper& mapper) {
        m_UrlConfig[mapper.protocol] = _mv(mapper);
        return {};
    }

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    static Error getCaps(const iTextView protocol, uint32_t& caps);
    static Error toPath(const Url& fromUrl, file::Path& toPath);
    static Error toUrl(const iTextView fromProtocol, const file::Path& fromPath,
                       Url& toUrl);
    static Error osPath(const Url& fromUrl, Text& toPath);
    static Error validate(const Url& url);
    static ErrorOr<UrlConfig::MapperPtr> getMapper(const iTextView type);

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Our list of mapping providers
    //-----------------------------------------------------------------
    inline static Mappers m_UrlConfig{};
};

//-------------------------------------------------------------------------
/// @details
///		A URL is a specialized type of URL that identifies a resource and
///		how to access it
///
///		It takes the form of:
///			 {protocol}://{authority (optional)}/{path}?key=val&key2=val...
///
///		Examples:
///			file://c:/users/john
///			http://www.google.com
///			dataNet://10.1.1.2:1021/data/file.dat?bufferSize=10MB&maxIoSize=1MB
///
///		Note that unlike previous releases, there is no interpretation of
///		what the underlying url actually means. It is essentially a wrapper
///		around a Path, adding a protocol and parameters to it.
///
///		Also, ALL delimiters are :// and not :///. This is non-standard
///		but is much easier to deal with and, since our urls represent
///		our communication between the app and engine, that is ok
///
///		The is no such thing as authority, etc in this implementation
///
//-------------------------------------------------------------------------
class Url final {
    const Text delim = "://"_tv;

public:
    using PROTOCOL_CAPS = UrlConfig::PROTOCOL_CAPS;

    //-------------------------------------------------------------
    // Construct directly
    //-------------------------------------------------------------
    Url(TextView protocol, TextView path, TextView query) {
        setUrl(protocol, path, query);
    }

    //-------------------------------------------------------------
    // Construct from another url
    //-------------------------------------------------------------
    Url() = default;
    Url(const Url& url) noexcept { copy(url); }
    Url(Url&& url) noexcept { move(_mv(url)); }

    //-------------------------------------------------------------
    // Construct from a text string
    //-------------------------------------------------------------
    Url(TextView url) noexcept { setUrl(url); }
    Url(const char* url) noexcept { setUrl(url); }
    Url(const Text& url) noexcept { setUrl(url); }
    Url(Text&& url) noexcept { setUrl(url); }

    Url(const Builder& builder) noexcept : Url(builder.finalize()) {}
    Url& operator=(const Builder& builder) noexcept {
        return move(builder.finalize());
    }

    //-------------------------------------------------------------
    // Set a url
    //-------------------------------------------------------------
    Url& operator=(const Url& url) noexcept { return copy(url); }
    Url& operator=(Url&& url) noexcept { return move(_mv(url)); }
    Url& operator=(const TextView& url) noexcept { return copy(url); }
    Url& operator=(const char* url) noexcept { return copy(TextView(url)); }
    Url& operator=(const Text& url) noexcept { return copy(url.toView()); }
    Url& operator=(Text&& url) noexcept { return move(_mv(url)); }

    //-------------------------------------------------------------
    // Block conversion from raw path to Url
    //-------------------------------------------------------------
    Url(const file::Path&) = delete;
    Url(file::Path&&) = delete;
    Url& operator=(const file::Path&) = delete;

    //-------------------------------------------------------------
    /// @details
    ///		Gets the protocol over the url
    //-------------------------------------------------------------
    const auto protocol() const noexcept { return m_protocol; }

    //-------------------------------------------------------------
    /// @details
    ///		Gets the path (no protocol, no query string). This
    ///		returns the complete path with prefix if it has one.
    //-------------------------------------------------------------
    const auto& fullpath() const noexcept { return buildFullPath(); }

    //-------------------------------------------------------------
    /// @details
    ///		This function will take a url and get the path to
    ///		to (removes protocol and prefix). It uses a registered
    ///		path mapper
    ///	@param[in]	fromUrl
    ///		The source url
    ///	@param[out]	toPath
    ///		Recieves the path
    //-------------------------------------------------------------
    const auto& path() const { return buildRelativePath(); }

    //-------------------------------------------------------------
    /// @details
    ///		Gets a portion of the path
    ///	@param[in]	startingIndex
    ///		Component to start at
    ///	@param[in]	size
    ///		The number of components to return
    //-------------------------------------------------------------
    auto subpath(size_t startingIndex,
                 ap::Opt<size_t> size = {}) const noexcept {
        auto& fullPath = buildFullPath();
        return fullPath.subpth(startingIndex, size);
    }

    //-------------------------------------------------------------
    /// @details
    ///		Gets a component at a particular index
    ///	@param[in]	index
    ///		Component to retrieve
    //-------------------------------------------------------------
    auto pathComp(size_t index) const noexcept {
        auto& fullPath = buildFullPath();
        return fullPath.at(index);
    }

    //-------------------------------------------------------------
    /// @details
    ///		Gets the number of components in the path
    //-------------------------------------------------------------
    auto pathCompCount() const noexcept {
        auto& fullPath = buildFullPath();
        return fullPath.count();
    }

    //-------------------------------------------------------------
    /// @details
    ///		Sets the filename of the url - creates a new url
    ///	@param[in]	file
    ///		New filename
    //-------------------------------------------------------------
    Url setFileName(TextView file) const noexcept {
        ASSERTD_MSG(valid(), m_url);
        return Url{m_protocol, fullpath().setFileName(file), m_queryString};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Sets a new path for the url
    ///	@param[in]	path
    ///		Path for the file
    //-------------------------------------------------------------
    Url setPath(const file::Path& path) const noexcept {
        return Url{m_protocol, path.str(), m_queryString};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Get a url with the subpath of the current url
    ///	@param[in]	path
    ///		Path for the file
    //-------------------------------------------------------------
    Url sub(size_t compIndexStart, ap::Opt<size_t> size = {}) const noexcept {
        return Url{m_protocol, subpath(compIndexStart, size), m_queryString};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Append a component to the path
    ///	@param[in]	comp
    ///		Component to append
    //-------------------------------------------------------------
    Url operator/(TextView comp) const noexcept {
        ASSERTD_MSG(valid(), m_url);
        return Url{m_protocol, fullpath() / comp, m_queryString};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Expand the fields within the url. The field is
    ///		required to be present in the url
    //-------------------------------------------------------------
    Url expandRequired(iTextView key, iTextView value) noexcept {
        auto& thisPath = buildFullPath();
        Text expandedPath =
            util::Vars::expandRequired(thisPath.str(), key, value);
        return Url{m_protocol, expandedPath, m_queryString};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Expand the fields within the url. The field is
    ///		not required to be present in the url
    //-------------------------------------------------------------
    Url expand(iTextView key, iTextView value) noexcept {
        auto thisPath = fullpath();
        auto expandedPath = util::Vars::expand(thisPath.str(), key, value);
        return Url{m_protocol, expandedPath, m_queryString};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Gets the authority. It is up to the caller to determine
    ///		if the first component is actually an authority. For
    ///		example a filesys:// url does not have an authority
    ///		but datanet://192.168.0.1/... does
    //-------------------------------------------------------------
    file::Path::ViewType authority() const noexcept {
        if (fullpath()) return fullpath().at(0);
        return {};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Gets the host address from the authority. It is up
    ///		to the caller to determine if the first component is
    ///		actually an authority
    //-------------------------------------------------------------
    auto host() const noexcept {
        auto [host, port] = string::slice(authority(), ":");
        return host;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Gets the port address from the authority. It is up
    ///		to the caller to determine if the first component is
    ///		actually an authority
    //-------------------------------------------------------------
    uint16_t port() const noexcept {
        auto [host, port] = string::slice(authority(), ":");
        if (auto res = _fsc<uint16_t>(port)) return *res;
        return {};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Gets the parent as a url
    //-------------------------------------------------------------
    auto parent() const noexcept {
        ASSERTD_MSG(valid(), m_url);
        return Url{m_protocol, fullpath().parent().str(), m_queryString};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Gets the filename of the url
    //-------------------------------------------------------------
    auto fileName() const noexcept { return fullpath().fileName(); }

    //-------------------------------------------------------------
    /// @details
    ///		Gets the query string
    //-------------------------------------------------------------
    auto queryString() const noexcept { return m_queryString; }

    //-------------------------------------------------------------
    /// @details
    ///		Returns a case insensitive version of the url
    ///		string
    //-------------------------------------------------------------
    explicit operator iTextView() const noexcept { return (iTextView)m_url; }

    //-------------------------------------------------------------
    /// @details
    ///		Returns a case sensitive version of the url string
    //-------------------------------------------------------------
    explicit operator TextView() const noexcept { return (TextView)m_url; }

    //-------------------------------------------------------------
    /// @details
    ///		Returns a case sensitive version of the url string
    //-------------------------------------------------------------
    explicit operator std::string&() const noexcept {
        return (std::string&)m_url;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if two urls are different
    ///	@param[in]	other
    ///		Other url to compare with
    //-------------------------------------------------------------
    bool operator!=(const Url& other) const noexcept {
        return m_url != other.m_url;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Compares 2 urls
    ///	@param[in]	other
    ///		Other url to compare with
    //-------------------------------------------------------------
    bool operator<(const Url& other) const noexcept {
        return m_url < other.m_url;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if two urls are the same
    ///	@param[in]	other
    ///		Other url to compare with
    //-------------------------------------------------------------
    bool operator==(const Url& other) const noexcept {
        return m_url == other.m_url;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if the url is valid
    //-------------------------------------------------------------
    bool valid() const noexcept { return m_protocol && m_fullPathView; }

    //-------------------------------------------------------------
    /// @details
    ///		Determine if the url is valid
    //-------------------------------------------------------------
    explicit operator bool() const noexcept { return valid(); }

    //-------------------------------------------------------------
    /// @details
    ///		Generate a url from json
    ///	@param[out]	url
    ///		Url to construct
    ///	@param[in]	val
    ///		The json value - string
    //-------------------------------------------------------------
    static Error __fromJson(Url& url, const json::Value& val) noexcept {
        auto urlStr = _fjc<Text>(val);
        if (!urlStr) return urlStr.ccode();
        url = Url(_mv(*urlStr));
        return {};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Generate json from a url
    ///	@param[out]	val
    ///		Receives the json value
    //-------------------------------------------------------------
    auto __toJson(json::Value& val) const noexcept { val = TextView{m_url}; }

    //-------------------------------------------------------------
    /// @details
    ///		Stringify the url
    //-------------------------------------------------------------
    template <typename Buffer>
    auto __toString(Buffer& buff, const FormatOptions& opts) const noexcept {
        // Hide the query if logging
        if (opts.logging())
            buff << protocol() << delim << fullpath();
        else
            buff << m_url;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Lookup a query parameter by its key
    ///	@param[in]	path
    ///		Path to the member
    ///	@param[in]	def
    ///		Default value
    //-------------------------------------------------------------
    // Looks up query value by its key
    template <typename T = Text>
    auto lookup(TextView path, T&& def = {}) const noexcept {
        return m_queryParams.lookup(path, std::forward<T>(def));
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if the query parameters have the
    ///		given member
    ///	@param[in]	path
    ///		Path to the member
    //-------------------------------------------------------------
    auto isMember(TextView path) const noexcept {
        return m_queryParams.isMember(path);
    }

    //-------------------------------------------------------------
    /// @details
    ///		Return the json query parameters
    //-------------------------------------------------------------
    decltype(auto) queryParams() const noexcept { return m_queryParams; }

    //-------------------------------------------------------------
    /// @details
    ///		This function will return the capability flags of
    ///		the given protocol
    ///	@param[in]	protocol
    ///		The protocol to get capabilities for
    ///	@param[out]	caps
    ///		Receives the flags
    //-------------------------------------------------------------
    static Error getCaps(const TextView protocol, uint32_t& caps) {
        return UrlConfig::getCaps(protocol, caps);
    }

    //-------------------------------------------------------------
    /// @details
    ///		This function will return the capability flags of
    ///		the given protocol
    ///	@param[in]	url
    ///		The url to get capabilities for
    ///	@param[out]	caps
    ///		Receives the flags
    //-------------------------------------------------------------
    static Error getCaps(const Url& url, uint32_t& caps) {
        return UrlConfig::getCaps(url.protocol(), caps);
    }

    //-------------------------------------------------------------
    /// @details
    ///		This function will take a url and get the path to
    ///		to (removes protocol and prefix). It uses a registered
    ///		path mapper
    ///	@param[in]	fromUrl
    ///		The source url
    ///	@param[out]	toPath
    ///		Recieves the path
    //-------------------------------------------------------------
    static Error toPath(const Url& fromUrl, file::Path& toPath) {
        return UrlConfig::toPath(fromUrl, toPath);
    }

    //-------------------------------------------------------------
    /// @details
    ///		This function will take a url and get the path to
    ///		to (removes protocol and prefix). It uses a registered
    ///		path mapper to convert to an actual path (not osPath)
    ///	@param[in]	fromUrl
    ///		The source url
    ///	@param[out]	toPath
    ///		Recieves the path
    //-------------------------------------------------------------
    static Error toPath(const Url& fromUrl, Text& toPath) {
        file::Path path;

        // Map it
        if (auto ccode = Url::toPath(fromUrl, path)) return ccode;

        // Convert to a string
        toPath = (TextView)path;
        return {};
    }

    //-------------------------------------------------------------
    /// @details
    ///		This function will take a protocol and a path and
    ///		convert it to a properly formatted url by adding the
    ///		url and the prefix
    ///	@param[in]	fromProtocol
    ///		Used to determine how to format the url
    ///	@param[in]	fromPath
    ///		The path to format
    ///	@param[out]	toUrl
    ///		Receives the url
    //-------------------------------------------------------------
    static Error toUrl(const TextView fromProtocol, const file::Path& fromPath,
                       Url& toUrl) {
        return UrlConfig::toUrl(fromProtocol, fromPath, toUrl);
    }

    //-------------------------------------------------------------
    /// @details
    ///		This function will take a path and get the os path to
    ///		to it. The os path cn be issued to the OS and for
    ///		windows, will contain, for Windows, the leading \\.\...
    ///		and for Linux, the leading /
    ///	@param[in]	fromUrl
    ///		The source url
    ///	@param[out]	toPath
    ///		Recieves the path
    //-------------------------------------------------------------
    static Error osPath(const Url& fromUrl, Text& toPath) {
        return UrlConfig::osPath(fromUrl, toPath);
    }

    //-------------------------------------------------------------
    /// @details
    ///		Validate the given url
    ///	@param[in]	url
    ///		The url to validate
    //-------------------------------------------------------------
    static Error validate(const Url& url) { return UrlConfig::validate(url); }

private:
    //-------------------------------------------------------------
    /// @details
    ///		Build the full path from the url... done only when
    ///		the path is required
    //-------------------------------------------------------------
    const file::Path& buildFullPath() const {
        // If we don't have it yet
        if (!m_hasFullPath) {
            // We really want to get rid of the const here since we
            // are computing the underlying path. We have one of two
            // choices:
            //	1.	Get rid of const on most of the member functions
            //		of Url so it can build the path here, which is
            //		a really bad idea or
            //	2.	Get rid of const here
            auto& self = (Url&)*this;

            // Build it
            self.m_fullPath = file::Path(m_fullPathView);
            self.m_hasFullPath = true;
        }

        // Now return the reference
        return m_fullPath;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Build the relative path (without the prefix, protocol
    ///		or query)
    //-------------------------------------------------------------
    const file::Path& buildRelativePath() const {
        // If we don't have it yet
        if (!m_hasRelativePath) {
            // We really want to get rid of the const here since we
            // are computing the underlying path. We have one of two
            // choices:
            //	1.	Get rid of const on most of the member functions
            //		of Url so it can build the path here, which is
            //		a really bad idea or
            //	2.	Get rid of const here
            auto& self = (Url&)*this;

            // Build it
            if (auto ccode = UrlConfig::toPath(self, self.m_relativePath))
                throw ccode;
            self.m_hasRelativePath = true;
        }

        // Now return the reference
        return m_relativePath;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Set a new url string based on its 3 components
    ///	@param[in]	protocol
    ///		The new protool
    ///	@param[in]	path
    ///		The new path
    ///	@param[in]	query
    ///		The new query
    //-------------------------------------------------------------
    Url& setUrl(TextView protocol, TextView path, TextView query) {
        // Setup the new url
        m_url = _ts(protocol, delim, path);
        if (query) m_url += _ts("?", query);

        // And parse it to get the views of it
        return construct();
    }

    //-------------------------------------------------------------
    /// @details
    ///		Set a new url string based on a combined url string
    ///	@param[in]	url
    ///		The new protool
    ///	@param[in]	path
    ///		The new path
    ///	@param[in]	query
    ///		The new query
    //-------------------------------------------------------------
    Url& setUrl(TextView url) {
        // Set the new url
        m_url = _ts(url);

        // And parse it to get the views of it
        return construct();
    }

    //-------------------------------------------------------------
    /// @details
    ///		Construct our url by find where the positions are
    ///		are creating string views for the substrings
    //-------------------------------------------------------------
    Url& construct() noexcept {
        // Force these to reconstruct as needed
        m_hasFullPath = {};
        m_fullPathView = {};
        m_fullPath = {};
        m_hasRelativePath = {};
        m_relativePath = {};

        // Get the position of the separator
        auto colonPos = m_url.find(delim);

        // Find the queuy if we can
        auto queryPos = m_url.find("?");

        // If we did not find either one, then then return an empty url
        if (colonPos == string::npos || queryPos < colonPos) return *this;

        // Build the protocol string view
        m_protocol = m_url.substrView(0, colonPos);

        // Get the pos where the path starts
        auto pathPos = colonPos + delim.size();

        // If we found a query string
        if (queryPos != string::npos) {
            // Get a view of the path and copy it over
            m_fullPathView = m_url.substrView(colonPos + 3, queryPos - pathPos);

            // Get a ptr to the query part
            m_queryString = m_url.substrView(queryPos + 1);

            // Parse the query into json
            parseQuery();
        } else {
            // Get a view of the path and copy it over
            m_fullPathView = m_url.substrView(colonPos + 3);
        }

        return *this;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Copy/Move operators Note: Due to small string
    ///		optimizations our views may not be valid so we only
    ///		move the string itself and do a construct on it
    //-------------------------------------------------------------
    Url& copy(TextView url) noexcept {
        m_url = url;
        return construct();
    }

    Url& copy(const Url& url) noexcept {
        if (this != &url) return copy(url.m_url);
        return *this;
    }

    Url& move(Text&& url) noexcept {
        m_url = _mv(url);
        return construct();
    }

    Url& move(Url&& url) noexcept {
        if (this != &url) return move(_mv(url.m_url));
        return *this;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Parse the query string into a key/value pair
    //-------------------------------------------------------------
    void parseQuery() noexcept {
        // Split the query string and walk it
        for (auto&& comp : string::split(m_queryString, "&")) {
            // Get the key/value pairs
            auto [key, val] = string::slice<iText, Text>(comp, "=");

            // Unescape the value
            auto unescaped = decode(val);

            /// @details Linux allows '?' in file names. URL treats '?'
            ///          as query separator and may crash here.
            ///          So, let's just comment out crashing assertion as quick
            ///          fix.
            /// @bug APPLAT-6771
            // ASSERTD_MSG(!key.contains("."), "Query key contains period",
            // m_url);
            if (key.contains(".")) continue;
            m_queryParams[_mv(key)] = _mv(unescaped);
        }
    }

    //-------------------------------------------------------------
    /// @details
    ///		Main str holding the original url this is our
    ///		immutable state and as such is the only thing we copy
    ///		or move in this assignments
    //-------------------------------------------------------------
    iText m_url;

    //-------------------------------------------------------------
    /// @details
    ///		Protocol portion of the url
    //-------------------------------------------------------------
    iTextView m_protocol;

    //-------------------------------------------------------------
    /// @details
    ///		Query string portion of the url
    //-------------------------------------------------------------
    iTextView m_queryString;

    //-------------------------------------------------------------
    /// @details
    ///		The computed full path portion including prefix
    //-------------------------------------------------------------
    bool m_hasFullPath{};
    iTextView m_fullPathView;
    file::Path m_fullPath;

    //-------------------------------------------------------------
    /// @details
    ///		The computed relative path portion without the prefix
    //-------------------------------------------------------------
    bool m_hasRelativePath{};
    file::Path m_relativePath;

    //-------------------------------------------------------------
    /// @details
    ///		Extracted query; always an object; if key value
    ///		pairs, they are placed here directly
    //-------------------------------------------------------------
    json::Value m_queryParams;
};
}  // namespace ap::url

// Import url::Url into the root namespace
namespace ap {
using Url = url::Url;
}

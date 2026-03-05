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

namespace ap::url {
//-------------------------------------------------------------------------
/// @details
/// 	Finds the mapper of the giver protocol
///	@param[in] type
///		The protocol to find
///	@param[out]	pMapper
///		Receives a ptr to the mapper
//-------------------------------------------------------------------------
ErrorOr<UrlConfig::MapperPtr> UrlConfig::getMapper(const iTextView type) {
    // Find the mapper
    auto mapper = m_UrlConfig.find(type);

    // If we couldn't find it
    if (mapper == m_UrlConfig.end())
        return APERR(Ec::InvalidSchema, "The url protocol", type,
                     "was not found");

    // Return it
    return &mapper->second;
}

//-------------------------------------------------------------------------
/// @details
/// 	Get the capabilities bitflags of a protocol
//-------------------------------------------------------------------------
Error UrlConfig::getCaps(const iTextView protocol, uint32_t &caps) {
    // Find the mapper
    auto mapper = getMapper(protocol);
    if (!mapper) return mapper.ccode();

    // Return the capabilities
    caps = (*mapper)->capabilities;
    return {};
}

//-------------------------------------------------------------------------
/// @details
/// 	Map a url to its path - removing the protocol, and any
///		prefixes it may have
//-------------------------------------------------------------------------
Error UrlConfig::toPath(const Url &fromUrl, file::Path &toPath) {
    auto protocol = fromUrl.protocol();

    // Find the mapper
    auto mapper = getMapper(protocol);
    if (!mapper) return mapper.ccode();

    // If we don't have a conversion for it
    if (!(*mapper)->toPath)
        return APERR(Ec::InvalidSchema, "The protocol", protocol,
                     "has no toPath");

    // Convert it
    return (*mapper)->toPath(fromUrl, toPath);
}

//-------------------------------------------------------------------------
/// @details
/// 	Map a protocol/path to a url and add any prefixes the
///		url may require
//-------------------------------------------------------------------------
Error UrlConfig::toUrl(const iTextView fromProtocol, const file::Path &fromPath,
                       Url &toUrl) {
    // Find the mapper
    auto mapper = getMapper(fromProtocol);
    if (!mapper) return mapper.ccode();

    // If we don't have a conversion for it
    if (!(*mapper)->toUrl)
        return APERR(Ec::InvalidSchema, "The protocol", protocol,
                     "has no toUrl");

    // Convert it
    return (*mapper)->toUrl(fromProtocol, fromPath, toUrl);
}

//-------------------------------------------------------------------------
/// @details
/// 	Map a url to its path - removing the protocol, and any
///		prefixes it may have
//-------------------------------------------------------------------------
Error UrlConfig::osPath(const Url &fromUrl, Text &toPath) {
    auto protocol = fromUrl.protocol();

    // Find the mapper
    auto mapper = getMapper(protocol);
    if (!mapper) return mapper.ccode();

    // If we don't have a conversion for it
    if (!(*mapper)->osPath)
        return APERR(Ec::InvalidSchema, "The protocol", protocol,
                     "has no osPath");

    // Convert it
    return (*mapper)->osPath(fromUrl, toPath);
}

//-------------------------------------------------------------------------
/// @details
/// 	Validate a url
//-------------------------------------------------------------------------
Error UrlConfig::validate(const Url &url) {
    // Find the mapper
    auto mapper = getMapper(url.protocol());
    if (!mapper) return mapper.ccode();

    // If we don't have a validator, assume it is correct
    if (!(*mapper)->validate) return {};

    // Validate it
    return (*mapper)->validate(url);
}

}  // namespace ap::url
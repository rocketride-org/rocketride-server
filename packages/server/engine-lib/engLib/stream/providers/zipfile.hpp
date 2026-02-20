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

namespace engine::stream::zipfile {
//-------------------------------------------------------------------------
///	@details
///		The trace flag for this component
//-------------------------------------------------------------------------
_const auto Level = Lvl::StreamZipfile;

//-------------------------------------------------------------------------
///	@details
///		The type of this stream
//-------------------------------------------------------------------------
_const auto Type = "zipfile"_itv;

//-------------------------------------------------------------------------
// Register the protocol config with the Url system. This
// allows call Url::toPath(...), Url::toUrl(...), etc
//-------------------------------------------------------------------------
static url::UrlConfig urlConfig{
    {//------------------------------------------------------------
     /// @details
     ///	Define the protocol capabilities
     //------------------------------------------------------------
     .capabilities = Url::PROTOCOL_CAPS::SUBSTREAM,

     //------------------------------------------------------------
     /// @details
     ///	Define the protocol type
     //------------------------------------------------------------
     .protocol = Type,

     //------------------------------------------------------------
     /// @details
     ///	Given a fully qualified path in the form of
     ///	zipfile://logicalDir/file.zip, returns the
     ///	path ("C:", "dir", "file.zip")
     /// @param[in]	fromUrl
     ///	Url to convert
     /// @param[out] toPath
     ///	Receives the path
     //------------------------------------------------------------
     .toPath = [](const Url &fromUrl, file::Path &toPath) -> Error {
         // Validate it
         if (auto ccode = urlConfig.validate(fromUrl)) return ccode;

         // Get the path
         auto path = fromUrl.fullpath();

         // Grab what we need and convert to a path
         toPath = file::Path{
             (Text)(config::paths().lookup(path.at(0)) / path.at(1))};
         return {};
     },

     //------------------------------------------------------------
     /// @details
     ///	Verifies that the given url is valid and in the form
     ///	of zipFile://logicalDir/file.zip
     /// @param[in]	fromUrl
     ///	Url to convert
     /// @param[out] toPath
     ///	Receives the path
     //------------------------------------------------------------
     .validate = [](const Url &url) -> Error {
         // Get the path
         const auto path = url.fullpath();

         // Must have at exactly 2 components
         if (path.count() != 2)
             return APERRX(
                 Level, Ec::InvalidParam,
                 "zipfile path has unexpected number of components:", path);

         // Is the directory a valid config-based directory?
         if (!config::isPath(path.at(0)))
             return APERRX(Level, Ec::InvalidUrl,
                           "zipe root directory is invalid:", path);

         // Are any /, \\, or ..'s in the path?
         if (path.gen().find("//") != string::npos ||
             path.gen().find("\\") != string::npos ||
             path.gen().find("..") != string::npos)
             return APERRX(Level, Ec::InvalidUrl,
                           "zipfile jailbreak from path detected:", path);
         return {};
     }}};

//-------------------------------------------------------------------------
/// @details
///		Define the actual stream interface for the zipfile://
///		endpoint. This endpoint/stream uses a main open (or create) and
///		utilizes open/write/closeSubStream functions to mark the items
///		within the zip file
//-------------------------------------------------------------------------
class ZipFile : public stream::zipbase::ZipBase<Level> {
public:
    using Parent = stream::zipbase::ZipBase<Level>;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<ZipFile, iStream>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    ZipFile(const FactoryArgs &args) noexcept {}
    virtual ~ZipFile() {}

public:
    //-----------------------------------------------------------------
    /// @details
    ///		Open the stream in the given mode. This is the main open
    ///		call which will open the zip file one disk
    ///	@param[in] url
    ///		The url to open
    ///	@param[in] mode
    ///		The mode to open in
    //-----------------------------------------------------------------
    Error open(const Url &url, stream::Mode mode) override {
        // Validate it
        if (auto ccode = Url::validate(url)) return ccode;

        // Get the os path
        Text toPath;
        if (auto ccode = Url::toPath(url, toPath)) return ccode;

        // Create the zip file
        m_zipFile = zipOpen64(toPath.c_str(), APPEND_STATUS_CREATE);
        if (!m_zipFile)
            return APERR(Ec::InvalidCommand,
                         "Unable to create zip stream file");

        return {};
    }
};
}  // namespace engine::stream::zipfile

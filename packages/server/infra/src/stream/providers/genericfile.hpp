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

namespace engine::stream::genericfile {
//-------------------------------------------------------------------------
// Template to register the protocol config with the Url system.
// This allows call Url::toPath(...), Url::toUrl(...), etc
//-------------------------------------------------------------------------
class GenericFileUrlConfig : url::UrlConfig {
public:
    using Parent = url::UrlConfig;

public:
    GenericFileUrlConfig(const ap::iTextView &Type, ap::log::Lvl Level)
        : Parent(url::UrlConfig::Mapper{
              //------------------------------------------------------------
              /// @details
              ///	Define the protocol capabilities
              //------------------------------------------------------------
              .capabilities = Url::PROTOCOL_CAPS::FILESYSTEM,

              //------------------------------------------------------------
              /// @details
              ///	Define the protocol type
              //------------------------------------------------------------
              .protocol = Type,

              //-----------------------------------------------------------------
              /// @details
              ///		Validate that the given directory does not go outside of
              ///		our control/data/...
              ///	@param[in] symbolicDir
              ///		control|data|...
              ///	@param[in] name
              ///		The name of the file - cannot contain /, \, or ..
              //-----------------------------------------------------------------
              .toUrl = [&](const iTextView fromProtocol,
                           const file::Path &fromPath, Url &toUrl) -> Error {
                  // This doesn't really work any more...
                  using namespace url;

                  // Build it
                  toUrl = builder() << protocolWithoutAuthority(Type)
                                    << component(fromPath.at(0))
                                    << component(fromPath.at(1));

                  // And done
                  return {};
              },

              //------------------------------------------------------------
              /// @details
              ///	Given a fully qualified path in the form of
              ///	datafile://logicalDir/file, returns the
              ///	path ("C:", "dir", "file.txt")
              /// @param[in]	fromUrl
              ///	Url to convert
              /// @param[out] toPath
              ///	Receives the path
              //------------------------------------------------------------
              .toPath = [&](const Url &fromUrl, file::Path &toPath) -> Error {
                  // Validate it
                  if (auto ccode = url::UrlConfig::validate(fromUrl))
                      return ccode;

                  // Get the path
                  auto path = fromUrl.fullpath();

                  // Grab what we need and convert to a path
                  toPath = file::Path{
                      (Text)(config::paths().lookup(path.at(0)) / path.at(1))};
                  return {};
              },

              //-------------------------------------------------------------
              /// @details
              ///		This function will convert a path to an osPath
              ///		For example, datafile://logicalDir//file.txt will
              ///		return the appropriate \\.\C:\Program Data\...
              ///	@param[in] path
              ///		The path
              ///	@param[out]	osPath
              ///		Receives the text representation of the path
              ///	@returns
              ///		Error
              //------------------------------------------------------------
              .osPath = [&](const Url &url, Text &toPath) -> Error {
                  // Get the path of the url
                  file::Path path;
                  if (auto ccode = url::UrlConfig::toPath(url, path))
                      return ccode;

                  // Get the text representation of the path
                  toPath = path.plat();
                  return {};
              },

              //------------------------------------------------------------
              /// @details
              ///	verifies that the given url is valid and in the form
              ///	of datafile://logicalDir/file
              /// @param[in]	fromUrl
              ///	Url to convert
              /// @param[out] toPath
              ///	Receives the path
              //------------------------------------------------------------
              .validate = [&](const Url &url) -> Error {
                  // Get the path
                  const auto path = url.fullpath();

                  // Must have at exactly 2 components
                  if (path.count() != 2)
                      return APERRX(
                          Level, Ec::InvalidParam,
                          "datafile path has unexpected number of components:",
                          path);

                  // Is the directory a valid config-based directory?
                  if (!config::isPath(path.at(0)))
                      return APERRX(
                          Level, Ec::InvalidUrl,
                          "datafile root directory is invalid:", path);

                  // Are any /, \\, or ..'s in the path?
                  if (path.gen().find("//") != string::npos ||
                      path.gen().find("\\") != string::npos ||
                      path.gen().find("..") != string::npos)
                      return APERRX(
                          Level, Ec::InvalidUrl,
                          "datafile jailbreak from path detected:", path);
                  return {};
              }}) {}
};

//-------------------------------------------------------------------------
/// @details
///		Define the actual stream interface for the Type:// endpoint.
//-------------------------------------------------------------------------
template <const ap::iTextView &Type, ap::log::Lvl Level>
class GenericFileStream : public iStream {
public:
    using Parent = iStream;
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
    _const auto Factory =
        Factory::makeFactory<GenericFileStream<Type, Level>, iStream>(Type);

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    GenericFileStream(const FactoryArgs &args) noexcept {}
    virtual ~GenericFileStream() {}

    //---------------------------------------------------------------------
    // Public API
    //---------------------------------------------------------------------

    //-----------------------------------------------------------------
    /// @details
    ///		Validate that the given directory does not go outside of
    ///		our control/data/...
    ///	@param[in] symbolicDir
    ///		control|data|...
    ///	@param[in] name
    ///		The name of the file - cannot contain /, \, or ..
    //-----------------------------------------------------------------
    static ErrorOr<Url> toUrl(const Text &symbolicDir,
                              const Text &fileName) noexcept {
        // This doesn't really work any more...
        using namespace url;

        // Create the path
        file::Path path;
        path /= symbolicDir;
        path /= fileName;

        // Make sure that we have a valud filename
        if (!fileName)
            return APERR(Ec::InvalidParam, "Filename is empty on toUrl");

        // Build the url
        Url url;
        if (auto ccode = Url::toUrl(Type, path, url)) return ccode;

        // Validate the resultant path in the url
        if (auto ccode = Url::validate(url)) return ccode;

        // And return it, it's good
        return url;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Get the local path of the url
    ///	@param[in] url
    ///		The url to get the local path for
    //-----------------------------------------------------------------
    static ErrorOr<file::Path> localPath(const Url &url) noexcept {
        file::Path path;

        if (auto ccode = Url::toPath(url, path)) return ccode;

        return path;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Open the stream in the given mode
    ///	@param[in] url
    ///		The url to open
    ///	@param[in] mode
    ///		The mode to open in
    //-----------------------------------------------------------------
    Error open(const Url &url, stream::Mode mode) override {
        // Validate the url
        if (auto ccode = Url::validate(url)) return ccode;

        // Get the path
        file::Path path;
        if (auto ccode = Url::toPath(url, path)) return ccode;

        // Attempt to open the stream
        if (auto ccode = m_stream.open(path, mode)) return ccode;

        // Call the parent
        return Parent::open(url, mode);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Close the stream
    //-----------------------------------------------------------------
    void close(bool graceful) noexcept(false) override {
        m_stream.close();
        Parent::close(graceful);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Write data to the stream
    ///	@param[in] data
    ///		The data to write
    //-----------------------------------------------------------------
    void write(InputData data) noexcept(false) override {
        m_stream.write(data);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Read data from the stream
    ///	@param[out] data
    ///		The buffer to read data into. size() contains the size
    ///		to read, returns size read
    //-----------------------------------------------------------------
    size_t read(OutputData data) noexcept(false) override {
        auto size = m_stream.read(data);
        if (size.hasCcode()) throw size.ccode();
        return size.value();
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Set the offset within the stream
    ///	@param[in] offset
    ///		The offset to seek to
    //-----------------------------------------------------------------
    void setOffset(uint64_t offset) noexcept(false) override {
        return m_stream.setOffset(offset);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Returns the size of the stream
    //-----------------------------------------------------------------
    size_t size() noexcept(false) override {
        auto size = m_stream.size();
        if (size.hasCcode()) throw size.ccode();
        return size.value();
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Returns the current offset within the stream
    //-----------------------------------------------------------------
    uint64_t offset() noexcept override { return m_stream.offset(); }

private:
    //-----------------------------------------------------------------
    /// @details
    ///		Underlying stream ptr
    //-----------------------------------------------------------------
    file::FileStream m_stream;
};
}  // namespace engine::stream::genericfile

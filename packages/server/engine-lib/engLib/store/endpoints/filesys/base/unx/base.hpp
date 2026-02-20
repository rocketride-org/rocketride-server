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

//-----------------------------------------------------------------------------
//
//	The class definition for Linux file system node
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::filesys::base {
// Helpers for file types
template <log::Lvl LvlT>
struct __TypeResolver {};
template <>
struct __TypeResolver<log::Lvl::ServiceFilesys> {
    using FileScanner = file::FileScanner;
    using FileStream = file::stream::Stream<file::stream::File>;
};
template <>
struct __TypeResolver<log::Lvl::ServiceSmb> {
    using FileScanner = file::SmbFileScanner;
    using FileStream = file::stream::Stream<file::stream::SmbFile>;
};

template <log::Lvl LvlT>
class IBaseSysGlobal;

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseSysInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;
    using FileScanner = typename __TypeResolver<LvlT>::FileScanner;
    using FileStream = typename __TypeResolver<LvlT>::FileStream;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = LvlT;

    //-----------------------------------------------------------------
    // Publics
    //-----------------------------------------------------------------
    virtual Error open(Entry &entry) noexcept override;
    virtual Error writeTag(const TAG *pTag) noexcept override;
    virtual Error close() noexcept override;

    virtual Error checkChanged(Entry &object) noexcept override;
    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used to render the object
    //-----------------------------------------------------------------
    Error sendTagBeginStream(FileStream &fileStream, ServicePipe &target,
                             TAG *pTagBuffer, Entry &object) noexcept;
    Error sendTagEndStream(ServicePipe &target) noexcept override;
    Error sendTagMetadata(ServicePipe &target, const Text &osPath,
                          const ap::file::StatInfo &stat,
                          Entry &object) noexcept;
    Error renderStandardFile(ServicePipe &target, const Text &osPath,
                             Entry &object) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used to store the object
    //-----------------------------------------------------------------
    Error createParentPath(const Url &url) noexcept;
    Error setMetadata() noexcept;
    Error createStandardFile(const Url &url) noexcept;
    Error processObjectStreamBegin(TAG_OBJECT_STREAM_BEGIN *pTag) noexcept;
    Error processObjectStreamData(TAG_OBJECT_STREAM_DATA *pTag) noexcept;
    Error processMetadata(TAG_OBJECT_METADATA *pTag) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Private functions used to stat the object
    //-----------------------------------------------------------------
    static bool isFileMovedOrUnavailable(const Error &err) noexcept;

    //-------------------------------------------------------------------------
    /// @details
    ///		Checks whether the file exists, and should be replaced if exists.
    ///     Is overriden in the derived class
    ///	@returns
    ///		Error
    //-------------------------------------------------------------------------
    virtual Error isObjectUpdateNeeded(const Url &url) noexcept = 0;

    //=================================================================
    // These are members that are used for store operations
    //=================================================================

    //-----------------------------------------------------------------
    /// @details
    ///		The stream of the file to be written with data
    //-----------------------------------------------------------------
    FileStream m_targetFile;

    //-----------------------------------------------------------------
    /// @details
    ///		Metadata information - set when the TAG_OBJECT_METDATA
    ///		comes through
    //-----------------------------------------------------------------
    json::Value m_metadata;

    //-----------------------------------------------------------------
    /// @details
    ///		Offset to which to write data
    //-----------------------------------------------------------------
    Qword m_dataOffset = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Flags from the metadata
    //-----------------------------------------------------------------
    Dword m_metadataFlags = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Attributes from the metadata.windows.attributes if they
    ///		are present
    //-----------------------------------------------------------------
    Dword m_attributes = 0;

    //-----------------------------------------------------------------
    /// @details
    ///		Contains the modified target url based on the
    ///		source url (generated by mapPath)
    //-----------------------------------------------------------------
    Url m_targetObjectUrl;

    //-----------------------------------------------------------------
    /// @details
    ///		Determines whether data stream is Primary
    //-----------------------------------------------------------------
    bool m_isPrimary = false;

    //-----------------------------------------------------------------
    /// @details
    ///		Determines whether file is a link
    //-----------------------------------------------------------------
    bool m_isLink = false;

    //-----------------------------------------------------------------
    /// @details
    ///		Contains file/dir where link is pointing to.
    ///		Filled up only when working with a link (m_isLink is true)
    //-----------------------------------------------------------------
    Text m_linkTo = {};
};

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseSysGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = LvlT;
};

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseSysEndpoint : public IServiceEndpoint {
public:
    using Config = IServiceConfig;
    using Parent = IServiceEndpoint;
    using Parent::Parent;
    using FileScanner = typename __TypeResolver<LvlT>::FileScanner;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = LvlT;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Type = LvlT == log::Lvl::ServiceFilesys ? "filesys"_tv
                       : LvlT == log::Lvl::ServiceSmb   ? "smb"_tv
                                                        : "<unknown>"_tv;

    //-----------------------------------------------------------------
    /// @details
    ///		Given a path to scan, this function will enumerate the children and
    ///		call the add object function. We handle containers (directories)
    ///		the same as objects, just returning them and let the scanner
    ///		figure out what to do. It is up to this function to ensure that the
    ///		object should actually be included with the selection lists
    ///	@param[in]	path
    ///		Path to scan
    ///	@param[in] 	callback
    ///		Ptr to the function to call for each object we found
    ///	@returns
    ///		Error
    //-----------------------------------------------------------------
    virtual Error scanObjects(Path &path,
                              const ScanAddObject &callback) noexcept override;

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		Special value for file systems read from the
    ///		service.parameters.excludeExternalDrives
    //-----------------------------------------------------------------
    bool m_excludeExternalDrives = true;

    //----------------------------------------------------------------
    /// @details
    ///		service.parameters.excludeSymlinks
    //-----------------------------------------------------------------
    bool m_excludeSymlinks = true;

private:
    //-----------------------------------------------------------------
    // We must have these implemented
    //-----------------------------------------------------------------
    Error processEntry(const Path &objectPath,
                       const ap::file::StatInfo &statInfo, Entry &object,
                       const ScanAddObject &addObject) noexcept;
};
}  // namespace engine::store::filter::filesys::base
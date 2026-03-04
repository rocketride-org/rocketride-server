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

//-----------------------------------------------------------------------------
//
//	Declares the interface for nodes
//
//-----------------------------------------------------------------------------
#pragma once

//-----------------------------------------------------------------------------
// Include the interfaces we support
//-----------------------------------------------------------------------------
#if ROCKETRIDE_PLAT_WIN
#include "./win/base.hpp"
#else
#include "./unx/base.hpp"
#endif

namespace engine::store::filter::filesys::base {
template <log::Lvl LvlT>
class IBaseEndpoint;
template <log::Lvl LvlT>
class IBaseGlobal;
template <log::Lvl LvlT>
class IBaseInstance;

//-------------------------------------------------------------------------
///	@details
///		This class defines the node interface to the file system
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseGlobal : public IBaseSysGlobal<LvlT> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseSysGlobal<LvlT>;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Allow the filter instance to see our private data. We can
    ///		either make it public, or limit the scope to IBaseInstance
    //-----------------------------------------------------------------
    friend IBaseInstance<LvlT>;
};

//-------------------------------------------------------------------------
///	@details
///		Filter class for handling file/smb I/O
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseInstance : public IBaseSysInstance<LvlT> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseSysInstance<LvlT>;
    using Parent::currentEntry;
    using Parent::endpoint;
    using Parent::m_metadata;
    using Parent::m_targetObjectUrl;
    using typename Parent::FactoryArgs;
    using typename Parent::FileScanner;
    using typename Parent::FileStream;

    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    IBaseInstance(const FactoryArgs &args) noexcept
        : Parent(args),
          global((static_cast<IBaseGlobal<LvlT> &>(*args.global))),
          m_endpoint((static_cast<IBaseEndpoint<LvlT> &>(*args.endpoint))) {};
    virtual ~IBaseInstance() {};

    virtual Error renderObject(ServicePipe &target,
                               Entry &object) noexcept override;
    virtual ErrorOr<bool> stat(Entry &entry) noexcept override;
    virtual Error removeObject(Entry &entry) noexcept override;
    virtual Error getPermissions(Entry &entry) noexcept override;
    virtual ErrorOr<std::list<Text>> outputPermissions() noexcept override;

public:
    //-----------------------------------------------------------------
    // Reference to the bound pipe
    //-----------------------------------------------------------------
    IBaseGlobal<LvlT> &global;

    IBaseEndpoint<LvlT> &m_endpoint;

protected:
    Error createTargetPath(const Path &path) noexcept;
    virtual Error isObjectUpdateNeeded(const Url &url) noexcept override;

    engine::permission::permissions permissions;
};

//-------------------------------------------------------------------------
/// @details
///		Define the endpoint
//-------------------------------------------------------------------------
template <log::Lvl LvlT>
class IBaseEndpoint : public IBaseSysEndpoint<LvlT> {
public:
    using Config = IServiceConfig;
    using Parent = IBaseSysEndpoint<LvlT>;
    using Parent::config;
    using Parent::m_excludeExternalDrives;
    using Parent::m_excludeSymlinks;
    using Parent::Parent;
    using Parent::Type;
    using typename Parent::FactoryArgs;

    using Path = ap::file::Path;

    //-----------------------------------------------------------------
    ///	@details
    ///	    Allow the base instance to see our private data. We can
    ///	    either make it public, or limit the scope to IBaseInstance<LvlT>
    //-----------------------------------------------------------------
    friend IBaseInstance<LvlT>;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error beginEndpoint(OPEN_MODE openMode) noexcept override;
    virtual Error getConfigSubKey(Text &key) noexcept override;
    virtual Error validateConfig(bool syntaxOnly) noexcept override;

    //-----------------------------------------------------------------
    /// @details
    ///     Contains our list of permissions as we gather them
    ///     up. They are written at the end of the task
    ///     Should exists at the endpoint level not instance
    //-----------------------------------------------------------------
    mutable async::MutexLock m_permissionLock;
#ifdef ROCKETRIDE_PLAT_UNX
    std::unordered_map<Text, struct stat> m_folderPermissions;
    std::unordered_map<Text, struct smb_names> m_names;
    mutable async::MutexLock m_parentPermissionLock;
    std::unordered_map<Text, perms::PermissionSet> m_parentPermissions;
#else
    std::unordered_map<Text, perms::PermissionSet> m_folderPermissions;
#endif
};
}  // namespace engine::store::filter::filesys::base
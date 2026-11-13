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
#ifndef ROCKETRIDE_PLAT_WIN
// @@TODO: for now disabled to speed up development
#pragma clang diagnostic ignored "-Wparentheses"
#endif
#include <core.h>

namespace engine {
using namespace ap;
}

#if BUILD_INFRA
using namespace engine;
#endif

// Precompiled headers
#include "headers.h"

// Basic core headers
#include "headers/init.h"
#include "headers/types.h"
#include "headers/transform.hpp"
#include "headers/entry.hpp"
#include "headers/index.hpp"
#include "headers/match.hpp"
#include "headers/syncEntryStack.hpp"
#include "headers/tokenIterator.hpp"
#include "headers/metadata.hpp"

// Configuration and monitoring
#include "config/Paths.hpp"
#include "monitor/TaskErrc.h"
#include "monitor/Counts.hpp"
#include "monitor/Monitor.hpp"
#include "config/global.hpp"
#include "monitor/macros.h"
#include "monitor/Console.hpp"
#include "monitor/Test.hpp"
#include "sysinfo/SysInfo.hpp"
#include "monitor/App.hpp"
#include "monitor/init.h"

// Network support
#include "net/api.hpp"
#if ROCKETRIDE_PLAT_WIN
#include "net/win/Socket.hpp"
#include "net/win/TlsCa.hpp"
#else
#include "net/unx/Socket.hpp"
#include "net/unx/TlsCa.hpp"
#endif
#include "net/TlsConnection.hpp"
#include "net/InternetConnection.hpp"

#include "net/rpc/types.h"
#include "net/rpc/Packet.hpp"
#include "net/rpc/Command.hpp"
#include "net/rpc/Identify.hpp"
#include "net/rpc/Connection.hpp"
#include "net/rpc/v3/File.hpp"
#include "net/rpc/v3/Stream.hpp"
#include "net/rpc/v3/KeyStore.hpp"

#include "tag/types.h"

#include "stream/types.h"
#include "stream/init.h"
#include "stream/iStream.h"
#include "stream/api.h"

#include "stream/streams/DecoratedStream.hpp"
#include "stream/streams/BufferedStream.h"
#include "stream/streams/adapter.hpp"

#include "stream/providers/genericfile.hpp"
#include "stream/providers/datafile.hpp"
#include "stream/providers/datanet.hpp"
#include "stream/providers/zipbase.hpp"
#include "stream/providers/zipnet.hpp"
#include "stream/providers/zipfile.hpp"

#include "perms/types.h"
#include "perms/KeyStatusMap.hpp"
#include "perms/PermissionSet.hpp"
#include "perms/output.hpp"
#if defined(ROCKETRIDE_PLAT_WIN)
#include "perms/win/Sid.hpp"
#include "perms/win/SidRights.hpp"
#include "perms/win/AdsAttribute.hpp"
#include "perms/win/DirectoryObject.hpp"
#include "perms/win/DirectorySearch.hpp"
#include "perms/win/init.h"
#include "perms/win/api.hpp"
#else
#include "perms/unx/init.hpp"
#include "perms/unx/api.hpp"
#include "perms/unx/smb/api.hpp"
#endif
#include "store/endpoints/filesys/base/Permission.hpp"

// Tags
#include "tag/Hdr.hpp"
#include "tag/traits.hpp"
#include "tag/io.hpp"

// Java support
#include "java/init.hpp"
#include "java/Jni.hpp"
#include "java/Logging.hpp"
#include "java/Crasher.hpp"

// Python support
#include "python/lock.hpp"
#include "python/init.hpp"
#include "python/call.hpp"
#include "python/pyjson.hpp"
#include "python/IJson.hpp"
#include "python/IDict.hpp"
#include "python/casters.hpp"

// KeyStore support
#include "keystore/keystore.hpp"
#include "keystore/keystorenet.hpp"
#include "keystore/keystorefile.hpp"
#include "keystore/servicekeystore.hpp"
#include "keystore/api.hpp"
#include "keystore/keystorefile.url.hpp"
#include "keystore/keystorenet.url.hpp"

// @TODO: Reorganize iBuffer source code location
// WordDb began to use VirtualBuffer that located in store,
// thus inlcuding iBuffer headers is required prior to WordDb headers.
// iBuffer and related definitions should be move to common location
// and included prior to WordDb and store headers.
#include "store/headers/iBuffer.hpp"
#include "store/headers/virtualBuffer.hpp"

// Word DB
#include "index/db/InvertedIndexContainer.hpp"
#include "index/db/WordDocBucketArray.hpp"
#include "index/db/types.h"
#include "tag/WordIndex.hpp"
#include "index/db/Write.hpp"
#include "index/db/internal/PaginatedVectorWordDBDataSupplier.hpp"
#include "index/db/internal/LazyPaginatedVectorWordDBDataSuplier.hpp"
#include "index/db/internal/Remote.hpp"
#include "index/db/internal/Local.hpp"
#include "index/db/Read.hpp"

#include "index/render.hpp"
#include "index/context.hpp"
#include "index/search/patterns.h"
#include "index/search/Op.hpp"
#include "index/search/types.h"
#include "index/search/Results.hpp"
#include "index/search/search.h"
#include "index/search/search.hpp"
#include "index/search/CompiledOp.hpp"
#include "index/search.h"
#include "index/search.hpp"
#include "index/search/patterns.hpp"
#include "store/store.hpp"
#include "task/task.hpp"

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
#include <apLib/ap.h>

namespace engine {
using namespace ap;
}

#if BUILD_ENGLIB
using namespace engine;
#endif

// Precompiled headers
#include <engLib/headers.h>

// Basic core headers
#include <engLib/headers/init.h>
#include <engLib/headers/types.h>
#include <engLib/headers/transform.hpp>
#include <engLib/headers/entry.hpp>
#include <engLib/headers/index.hpp>
#include <engLib/headers/match.hpp>
#include <engLib/headers/syncEntryStack.hpp>
#include <engLib/headers/tokenIterator.hpp>
#include <engLib/headers/metadata.hpp>

// Configuration and monitoring
#include <engLib/config/Paths.hpp>
#include <engLib/monitor/TaskErrc.h>
#include <engLib/monitor/Counts.hpp>
#include <engLib/monitor/Monitor.hpp>
#include <engLib/config/global.hpp>
#include <engLib/monitor/macros.h>
#include <engLib/monitor/Console.hpp>
#include <engLib/monitor/Test.hpp>
#include <engLib/sysinfo/SysInfo.hpp>
#include <engLib/monitor/App.hpp>
#include <engLib/monitor/init.h>

// Network support
#include <engLib/net/api.hpp>
#if ROCKETRIDE_PLAT_WIN
#include <engLib/net/win/Socket.hpp>
#include <engLib/net/win/TlsCa.hpp>
#else
#include <engLib/net/unx/Socket.hpp>
#include <engLib/net/unx/TlsCa.hpp>
#endif
#include <engLib/net/TlsConnection.hpp>
#include <engLib/net/InternetConnection.hpp>

#include <engLib/net/rpc/types.h>
#include <engLib/net/rpc/Packet.hpp>
#include <engLib/net/rpc/Command.hpp>
#include <engLib/net/rpc/Identify.hpp>
#include <engLib/net/rpc/Connection.hpp>
#include <engLib/net/rpc/v3/File.hpp>
#include <engLib/net/rpc/v3/Stream.hpp>
#include <engLib/net/rpc/v3/KeyStore.hpp>

#include <engLib/tag/types.h>

#include <engLib/stream/types.h>
#include <engLib/stream/init.h>
#include <engLib/stream/iStream.h>
#include <engLib/stream/api.h>

#include <engLib/stream/streams/DecoratedStream.hpp>
#include <engLib/stream/streams/BufferedStream.h>
#include <engLib/stream/streams/adapter.hpp>

#include <engLib/stream/providers/genericfile.hpp>
#include <engLib/stream/providers/datafile.hpp>
#include <engLib/stream/providers/datanet.hpp>
#include <engLib/stream/providers/zipbase.hpp>
#include <engLib/stream/providers/zipnet.hpp>
#include <engLib/stream/providers/zipfile.hpp>

#include <engLib/perms/types.h>
#include <engLib/perms/KeyStatusMap.hpp>
#include <engLib/perms/PermissionSet.hpp>
#include <engLib/perms/output.hpp>
#if defined(ROCKETRIDE_PLAT_WIN)
#include <engLib/perms/win/Sid.hpp>
#include <engLib/perms/win/SidRights.hpp>
#include <engLib/perms/win/AdsAttribute.hpp>
#include <engLib/perms/win/DirectoryObject.hpp>
#include <engLib/perms/win/DirectorySearch.hpp>
#include <engLib/perms/win/init.h>
#include <engLib/perms/win/api.hpp>
#else
#include <engLib/perms/unx/init.hpp>
#include <engLib/perms/unx/api.hpp>
#include <engLib/perms/unx/smb/api.hpp>
#endif
#include <engLib/store/endpoints/filesys/base/Permission.hpp>

// Tags
#include <engLib/tag/Hdr.hpp>
#include <engLib/tag/traits.hpp>
#include <engLib/tag/io.hpp>

// Java support
#include <engLib/java/init.hpp>
#include <engLib/java/Jni.hpp>
#include <engLib/java/Logging.hpp>
#include <engLib/java/Crasher.hpp>

// Python support
#include <engLib/python/lock.hpp>
#include <engLib/python/init.hpp>
#include <engLib/python/call.hpp>
#include <engLib/python/pyjson.hpp>
#include <engLib/python/IJson.hpp>
#include <engLib/python/IDict.hpp>
#include <engLib/python/casters.hpp>

// KeyStore support
#include <engLib/keystore/keystore.hpp>
#include <engLib/keystore/keystorenet.hpp>
#include <engLib/keystore/keystorefile.hpp>
#include <engLib/keystore/servicekeystore.hpp>
#include <engLib/keystore/api.hpp>
#include <engLib/keystore/keystorefile.url.hpp>
#include <engLib/keystore/keystorenet.url.hpp>

// @TODO: Reorganize iBuffer source code location
// WordDb began to use VirtualBuffer that located in store,
// thus inlcuding iBuffer headers is required prior to WordDb headers.
// iBuffer and related definitions should be move to common location
// and included prior to WordDb and store headers.
#include <engLib/store/headers/iBuffer.hpp>
#include <engLib/store/headers/virtualBuffer.hpp>

// Word DB
#include <engLib/index/db/InvertedIndexContainer.hpp>
#include <engLib/index/db/WordDocBucketArray.hpp>
#include <engLib/index/db/types.h>
#include <engLib/tag/WordIndex.hpp>
#include <engLib/index/db/Write.hpp>
#include <engLib/index/db/internal/PaginatedVectorWordDBDataSupplier.hpp>
#include <engLib/index/db/internal/LazyPaginatedVectorWordDBDataSuplier.hpp>
#include <engLib/index/db/internal/Remote.hpp>
#include <engLib/index/db/internal/Local.hpp>
#include <engLib/index/db/Read.hpp>

#include <engLib/index/render.hpp>
#include <engLib/index/context.hpp>
#include <engLib/index/search/patterns.h>
#include <engLib/index/search/Op.hpp>
#include <engLib/index/search/types.h>
#include <engLib/index/search/Results.hpp>
#include <engLib/index/search/search.h>
#include <engLib/index/search/search.hpp>
#include <engLib/index/search/CompiledOp.hpp>
#include <engLib/index/search.h>
#include <engLib/index/search.hpp>
#include <engLib/index/search/patterns.hpp>
#include <engLib/store/store.hpp>
#include <engLib/task/task.hpp>

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

//
//	Top level engine header
//
#pragma once
#include <cstddef>  // For size_t used in Size_t below

#if !defined(NDEBUG)
#define ROCKETRIDE_BUILD_DEBUG 1
#endif

// Start the rocketride namespace, if core itself is being built use it
namespace ap {
class Error;
template <typename ResultT>
class ErrorOr;

// Normalize size_t ambiguity usage between osx and others
// osx uses the LP64 vs LLP64 models of size_t definitions
// use in places where u need to exchange size_t between
// uint64_t
#if ROCKETRIDE_PLAT_MAC
using Size_t = unsigned long long;
#else
using Size_t = size_t;
#endif
}  // namespace ap
#if BUILD_CORE
using namespace ap;
#endif
// Use JSON exceptions
#define JSON_USE_EXCEPTION 1

// Exports the node DLL ABI from engine_abi - ROCKETRIDE_CORE_BUILD is defined
// building core/src/infra into engine_abi. Everything else, a node module included,
// gets a plain symbol and resolves it through engine_abi's import library.
//
// The consuming side deliberately does NOT say __declspec(dllimport). Marking a
// whole class dll-interface makes MSVC define every member it can reach, and
// the engine's headers hold members that have never been instantiated and do
// not survive it - implicit copy assignment for a class holding unique_ptr, a
// /permissive- conformance bug in a member template that nothing calls. Import
// thunks cost an indirection on the call and give up none of that. It does mean
// only functions can cross this boundary: exported data would need the real
// dllimport, so the ABI exposes accessors instead (see Factory::factories).
#ifdef _WIN32
    #ifdef ROCKETRIDE_CORE_BUILD
        #define ROCKETRIDE_CORE_API __declspec(dllexport)
    #else
        #define ROCKETRIDE_CORE_API
    #endif
#else
    #ifdef ROCKETRIDE_CORE_BUILD
        #define ROCKETRIDE_CORE_API __attribute__((visibility("default")))
    #else
        #define ROCKETRIDE_CORE_API
    #endif
#endif

// For the singletons the engine and its nodes MUST share - the factory
// registry, the url mappers, the enabled trace levels. These hide their state
// in a function-local static, and some of those functions are inline, so a node
// that compiles one gets a private copy and silently stops sharing: its
// factories become invisible, its trace output disappears. An inline definition
// always wins over an import, so the header has to withhold the definition on
// the consuming side and name the engine's copy explicitly - which is the one
// thing plain import thunks cannot do.
//
// Use this ONLY on free/static functions. At class scope it makes MSVC define
// every member it can reach, which the engine's headers do not survive - see
// ROCKETRIDE_CORE_API above.
#ifdef _WIN32
    #ifdef ROCKETRIDE_CORE_BUILD
        #define ROCKETRIDE_CORE_SHARED __declspec(dllexport)
    #elif defined(ROCKETRIDE_CORE_IMPORT)
        #define ROCKETRIDE_CORE_SHARED __declspec(dllimport)
    #else
        #define ROCKETRIDE_CORE_SHARED
    #endif
#else
    #ifdef ROCKETRIDE_CORE_BUILD
        #define ROCKETRIDE_CORE_SHARED __attribute__((visibility("default")))
    #else
        #define ROCKETRIDE_CORE_SHARED
    #endif
#endif

// Include the basic system headers
#include "headers.h"

#include "memory/pmr.hpp"
#include "global.h"
#include "factory/types.h"
#include "traits.hpp"
#include "string/macros.h"
#include "string/charTypes.h"
#include "string/packTraits.h"
#include "string/Format.h"
#include "util/numericCast.h"
#include "string/StrApi.hpp"
#include "memory/ShortAllocator.hpp"
#include "memory/small.h"
#include "Location.h"
#include "async/Tls.h"
#include "util/typeName.h"
#include "string/FormatOptions.hpp"
#include "util/enum.hpp"
#include "util/hash.h"
#include "log/macros.h"
#include "async/types.h"
#include "async/work/types.h"
#include "util/macros.h"
#include "string/NoCase.hpp"
#include "string/Case.hpp"
#include "memory/forwards.h"
#include "memory/types.h"
#include "string/StrView.hpp"
#include "string/cast.h"
#include "string/viewTokenize.hpp"
#include "error/Ec.h"

#if ROCKETRIDE_PLAT_WIN
#include "error/win/Win32Errc.h"
#elif ROCKETRIDE_PLAT_LIN
#include "error/unx/ErrnoErrc.h"
#elif ROCKETRIDE_PLAT_MAC
#include "error/unx/ErrnoErrc.h"
#endif

#include "file/pathForwards.h"

#include "log/Lvl.hpp"
#include "transform.h"
#include "traitMacros.h"
#include "string/PackAdapter.h"
#include "string/traits.hpp"
#include "dev/macros.h"
#include "dev/api.h"
#include "memory/BucketArray.hpp"
#include "ChildOf.hpp"
#include "string/stdTraits.hpp"
#include "memory/dataTypes.h"
#include "string/Str.hpp"
#include "string/strTraits.hpp"
#include "traits2.hpp"
#include "string/global.hpp"
#include "string/types.h"
#include "plat/types.h"
#include "plat/init.h"

#if ROCKETRIDE_PLAT_WIN
// On Windows, use Boost stacktrace as our Backtrace class (supports toString
// via operator <<)
namespace ap::dev {
typedef boost::stacktrace::stacktrace Backtrace;
}
#elif ROCKETRIDE_PLAT_LIN
   // On Linux, use libbacktrace for stacktraces
#include "dev/lin/Backtrace.h"
#elif ROCKETRIDE_PLAT_MAC
   // Don't support stacktraces on OSX
// libbacktrace doesn't compile reliably and is reporting no symbols for OSX
// binaries anyway
namespace ap::dev {
typedef Text Backtrace;
}
#else
   // nothing
#endif

#include "util/tuple.hpp"
#include "util/algorithm.hpp"
#include "string/api.h"
#include "crypto/hex.h"
#include "memory/DataView.hpp"
#include "memory/cast.hpp"
#include "memory/literals.hpp"
#include "string/PackAdapter.hpp"
#include "memory/traits.hpp"
#include "memory/iteratorTraits.hpp"
#include "memory/global.hpp"
#include "log/api.h"
#include "string/chrApi.hpp"
#include "string/StrVector.hpp"
#include "string/toString.h"
#include "plat/api.hpp"
#include "util/Vars.hpp"
#include "util/api.hpp"
#include "util/ComboIter.hpp"
#include "string/FormatStr.hpp"
#include "string/formatApi.h"
#include "string/literals.hpp"
#include "time/types.h"
#include "log/write.h"
#include "error/traits.hpp"
#include "error/Error.h"
#include "error/makeError.h"
#include "error/macros.h"
#include "error/ErrorOr.hpp"
#include "error/ErrorOr_Void.hpp"
#include "error/ErrorOr_Bool.hpp"
#include "deref.hpp"
#include "file/Mode.h"
#include "application/readLine.h"
#include "application/stdinMonitor.h"
#include "memory/toData.h"
#include "memory/fromData.h"
#include "memory/PaginatedVector.hpp"
#include "error/dispatch.hpp"
#include "util/Guard.hpp"
#include "dev/bugCheckScope.hpp"
#include "time/transform.h"
#include "time/Duration.hpp"
#include "async/api.h"
#include "async/traits.hpp"
#include "async/lockTraits.hpp"
#include "async/work/init.h"
#include "async/Event.hpp"
#include "async/Semaphore.hpp"
#include "async/Mutex.hpp"
#include "async/LockApi.hpp"
#include "time/global.hpp"
#include "time/api.h"
#include "time/toData.hpp"
#include "string/fromString.h"
#include "time/format.h"
#include "time/api.hpp"
#include "time/transform.hpp"
#include "time/Duration_Pack.hpp"
#include "async/AtomicFlag.hpp"
#include "async/Lock.hpp"
#include "async/Lock_Shared.hpp"
#include "async/lockTypes.h"
#include "async/Condition.hpp"
#include "log/consoleLock.hpp"

#include "file/fsType.h"

#include "json/jsonCpp.h"
#include "time/toJson.hpp"
#include "json/types.h"
#include "json/traits.hpp"
#include "json/parse.h"
#include "string/toStringCheck.hpp"
#include "json/toJson.h"
#include "json/toData.h"
#include "json/Schema.hpp"
#include "json/fromJson.h"

#ifdef ROCKETRIDE_PLAT_UNX
#include "file/unx/types.h"
#endif

#if ROCKETRIDE_PLAT_WIN
#include "plat/win/ComInit.hpp"
#include "file/win/types.h"
#include "file/win/transform.h"
#include "application/win/readLine.hpp"
#elif ROCKETRIDE_PLAT_LIN
#include "file/lin/types.h"
#endif
#ifdef ROCKETRIDE_PLAT_UNX
#include "application/unx/readLine.hpp"
#ifndef ROCKETRIDE_PLAT_MAC
#include "application/unx/readLine.hpp"
#endif
#endif

#include "file/StatInfo.hpp"
#include "file/MntEntInfo.hpp"

#include "file/types.h"
#include "string/fromString.h"
#include "file/sep.hpp"
#include "file/PathTrait.hpp"
#include "file/PathType.h"
#include "file/pathTypes.h"
#include "string/StackStr.h"
#include "string/toData.h"
#include "log/Color.h"
#include "log/Options.h"
#if ROCKETRIDE_PLAT_WIN
#include "file/win/WinPathApi.hpp"
#else
#include "file/unx/UnxPathApi.hpp"
#endif
#include "file/pathApiTypes.h"

#include "file/traits.hpp"
#include "file/FilePath.hpp"

#include "url/types.h"
#include "url/api.hpp"
#include "url/Builder.hpp"
#include "url/build.hpp"
#include "url/Url.hpp"

#include "file/toData.hpp"
#include "file/pathLiterals.hpp"
#include "memory/adapter/concepts.hpp"
#include "memory/adapter/Input.hpp"
#include "memory/adapter/Output.hpp"
#include "memory/adapter/NullOutput.hpp"
#include "memory/adapter/make.hpp"
#include "crypto/Hash.h"
#include "file/api.h"
#include "application/api.h"
#include "application/CmdLine.h"
#include "util/Singleton.hpp"
#include "application/Opt.h"
#include "application/Options.h"
#include "application/Opt.hpp"
#include "application/Options.hpp"
#if ROCKETRIDE_PLAT_UNX
#include "application/unx/signal.h"
#endif
#include "application/init.h"
#include "factory/Ptr.h"
#include "util/algorithm2.hpp"
#include "util/del.h"
#include "log/Color.hpp"
#include "log/toString.h"
#include "error/call.hpp"
#include "error/translate.hpp"
#include "async/Callback.hpp"
#include "async/RunCtx.hpp"
#include "async/ThreadCtx.hpp"
#include "async/ThreadApi.hpp"
#include "async/ThreadCtx.hpp"
#include "async/Thread.hpp"
#include "async/Queue.hpp"
#include "Uuid.hpp"
#include "match/Glob_Api.hpp"
#include "match/Glob.h"
#include "match/Group.hpp"
#include "match/types.h"
#include "match/api.h"
#include "log/toString.hpp"
#include "log/api.hpp"
#include "memory/Data.hpp"

#include "crypto/transform.hpp"
#include "crypto/hex.hpp"
#include "crypto/base64.h"
#include "crypto/random.hpp"
#include "crypto/crc.hpp"
#include "crypto/types.h"
#include "crypto/Cipher.hpp"
#include "crypto/api.h"
#include "crypto/Key.hpp"
#include "crypto/KeyApi.hpp"
#include "crypto/paramToken.h"
#include "crypto/CipherCtx.h"
#include "crypto/EncryptCtx.h"
#include "crypto/DecryptCtx.h"

#include "compress/types.h"
#include "compress/api.hpp"
#include "compress/lz4.hpp"
#include "compress/uint32.hpp"
#include "compress/FastPFor.h"
#include "compress/FastPFor.hpp"

#include "string/api.hpp"
#include "util/typeName.hpp"
#include "Count.hpp"
#include "async/api.hpp"
#include "error/Error.hpp"
#include "dev/api.hpp"
#include "util/SharedFromThis.hpp"
#include "async/work/itemState.h"
#include "async/work/Executor.h"
#include "async/work/global.h"
#include "async/work/ItemCtx.hpp"
#include "async/work/Item.hpp"
#include "async/work/Group.hpp"
#include "async/work/api.hpp"

#include "file/snap/types.h"
#if ROCKETRIDE_PLAT_WIN
#include "file/snap/win/VssClient.h"
#include "time/win/zone.hpp"
#include "time/win/transform.hpp"
#elif ROCKETRIDE_PLAT_UNX
#include "time/unx/zone.hpp"
#if ROCKETRIDE_PLAT_LIN
#include "file/snap/lin/LvmClient.hpp"
#endif
#endif
#include "file/snap/Context.h"
#include "file/snap/api.h"

#include "xml/types.h"
#include "xml/api.hpp"

#include "Location.hpp"
#include "Size.hpp"
#include "CountSize.hpp"
#include "literals.hpp"
#include "memory/adapter/api.hpp"
#include "plat/pageSize.hpp"

#include "util/bitmask.hpp"
#include "util/numericCast.hpp"
#include "id.hpp"
#include "memory/PackHdr.hpp"
#include "memory/toData.hpp"
#include "memory/fromData.hpp"
#include "memory/pack.hpp"
#include "string/toData.hpp"
#include "string/StrPack.hpp"
#include "memory/Stats.hpp"
#include "factory/api.h"
#include "string/utf8/checked.h"
#include "string/utf8/unchecked.h"
#include "string/unicode/types.h"
#include "string/unicode/api.hpp"
#include "log/write.hpp"
#include "util/Throughput.hpp"
#include "async/ResultQueue.hpp"
#include "async/ThreadedQueue.hpp"
#include "async/ThreadedQueues.hpp"
#include "async/Buffers.hpp"
#include "string/icu/types.h"
#include "string/icu/TextSink.hpp"
#include "string/icu/api.hpp"
#include "string/icu/transform.hpp"
#include "string/icu/MultibyteCaseCollator.hpp"
#include "string/icu/MultibyteNoCaseCollator.hpp"
#include "string/CaseCollator.hpp"
#include "string/NoCaseCollator.hpp"
#include "string/icu/rules.h"
#include "string/icu/Normalizer.hpp"
#include "string/icu/BoundaryIterator.hpp"
#include "string/icu/iterTypes.h"
// Node module C abi
#include <rocketride/node_api.h>
#include "factory/Factory.h"
#include "string/transform.hpp"
#include "memory/ViewAllocator.hpp"
#include "string/cast.hpp"

#include "string/urlEncode.hpp"

// Platform api declarations
#include "plat/DiskUsage.h"
#if ROCKETRIDE_PLAT_WIN
#include "plat/win/api.h"
#elif ROCKETRIDE_PLAT_LIN
#include "plat/lin/api.h"
#elif ROCKETRIDE_PLAT_MAC
#include "plat/mac/api.h"
#endif
#ifdef ROCKETRIDE_PLAT_UNX
#include "plat/unx/api.h"
#endif

// Stream api
#include "file/stream/Stream.hpp"
#include "file/stream/adapters.hpp"
#include "plat/DiskUsage.h"
#if ROCKETRIDE_PLAT_WIN
#include "file/stream/win/File.hpp"
#elif ROCKETRIDE_PLAT_UNX
#include "file/stream/unx/File.hpp"
#endif
#include "file/stream/types.h"
#include "memory/InputStreamBuf.hpp"

// Scanning api (file/vol)
#include "file/scan/Scanner.hpp"
#if ROCKETRIDE_PLAT_WIN
#include "file/scan/win/File.hpp"
#include "file/scan/win/Volume.hpp"
#include "file/scan/win/VolumeMountPoint.hpp"
#include "file/scan/win/DriveLetter.hpp"
#else
#include "file/scan/unx/File.hpp"
#if ROCKETRIDE_PLAT_LIN

#include "file/scan/lin/MountPoint.hpp"
#elif ROCKETRIDE_PLAT_MAC
#include "file/scan/mac/MountPoint.hpp"
#endif
#endif
#include "file/scan/types.h"

// SMB
#include "file/smb/Share.hpp"

#ifdef ROCKETRIDE_PLAT_WIN
#include "file/smb/win/api.hpp"
#else
#include "file/smb/unx/api.h"
#ifdef ROCKETRIDE_PLAT_LIN
#include "file/smb/lin/ClientApi.hpp"
#include "file/smb/lin/Client.hpp"
#else
#include "file/smb/mac/ClientApi.hpp"
#include "file/smb/mac/Client.hpp"
#endif
#include "file/smb/unx/api.hpp"
#include "file/scan/unx/SmbFile.hpp"
#include "file/stream/unx/SmbFile.hpp"
#endif

#if ROCKETRIDE_PLAT_WIN
#include "file/win/api.hpp"
#include "file/win/transform.hpp"
#else
#include "file/unx/api.hpp"
#include "file/unx/transform.hpp"
#include "file/unx/transform.h"

#endif

#include "entry.hpp"
#include "file/Selections.hpp"

// Include transformation, string conversions, we add these at the end to
// ensure adl lookup just works
#include "transform.hpp"
#include "string/packTypes.h"

#include "string/packSelector.h"
#include "string/packString.hpp"
#include "string/packNumber.hpp"
#include "string/packContainer.hpp"
#include "string/packUser.hpp"
#include "string/packMisc.hpp"
#include "string/packSelector.hpp"

#include "string/PackAdapter_In.hpp"

#include "string/packTraits.hpp"
#include "string/unpackNumber.hpp"
#include "string/unpackString.hpp"
#include "string/unpackUser.hpp"
#include "string/unpackMisc.hpp"

#include "string/formatApi.hpp"
#include "string/toString.hpp"
#include "string/fromString.hpp"
#include "json/toJson.hpp"
#include "json/toData.hpp"
#include "json/fromJson.hpp"
#include "json/jsonCpp_Ext.hpp"
#include "factory/Factory.hpp"
#include "factory/api.hpp"
#include "factory/Ptr.hpp"
#include "util/del.hpp"
#include "string/deductions.hpp"
#include "memory/deductions.hpp"
#include "util/ConfigFile.hpp"
#include "log/Options.hpp"
#include "async/Tls.hpp"
#include "json/parse.hpp"
#include "init.hpp"
#include "error/makeError.hpp"

#include "crypto/api.hpp"
#include "crypto/Keyring.hpp"
#include "crypto/overloads.hpp"
#include "crypto/Hash.hpp"
#include "crypto/base64.hpp"

#include "plat/CpuInfo.hpp"

#if ROCKETRIDE_PLAT_WIN
#include "plat/win/api.hpp"
#include "plat/win/privilege.hpp"
#include "plat/win/minidump.hpp"
#include "dev/win/api.hpp"
#include "plat/win/Usn.hpp"
#elif ROCKETRIDE_PLAT_LIN
#include "plat/lin/api.hpp"
#elif ROCKETRIDE_PLAT_MAC
#include "plat/mac/api.hpp"

#endif

#ifdef ROCKETRIDE_PLAT_UNX
#include "dev/unx/api.hpp"
#include "plat/unx/api.hpp"
// Out-of-process Crashpad crash handler façade, shared by Linux and macOS.
#include "plat/unx/minidump_lifetime.h"
#endif

#include "file/api.hpp"

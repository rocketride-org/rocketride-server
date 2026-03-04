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

// Standard C headers
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <stddef.h>
#include <ctype.h>
#include <errno.h>
#include <time.h>
#include <stdint.h>

// Standard C++ headers
#include <cstdio>
#include <set>
#include <map>
#include <vector>
#include <memory>
#include <fstream>
#include <functional>
#include <iostream>
#include <string>
#include <sstream>
#include <algorithm>
#include <thread>
#include <mutex>
#include <shared_mutex>
#include <condition_variable>
#include <queue>
#include <ctime>
#include <list>
#include <random>
#include <regex>
#include <array>
#include <type_traits>
#include <optional>
#include <variant>
#include <algorithm>
#include <forward_list>
#include <unordered_set>
#include <unordered_map>
#include <string_view>
#include <sstream>
#include <iomanip>
#include <fstream>
#include <filesystem>
#include <future>
#include <chrono>
#include <stddef.h>
#include <regex>
#include <cstdlib>
#include <charconv>
#include <system_error>
#include <any>
#include <numeric>
#include <utility>
#include <compare>
#include <bitset>

// pmr allocator extensions
// We use the boost libraries since we do have some
// modifications on the scaling factors and create
// a custom allocator
#include <boost/container/pmr/memory_resource.hpp>
#include <boost/container/pmr/unsynchronized_pool_resource.hpp>
#include <boost/container/pmr/monotonic_buffer_resource.hpp>
#include <boost/container/pmr/set.hpp>
#include <boost/container/pmr/map.hpp>
#include <boost/container/pmr/vector.hpp>
#include <boost/container/pmr/deque.hpp>

// Within the ap namespace, use chrono and string literals
namespace ap {
using namespace std::literals;
using namespace std::chrono_literals;
}  // namespace ap

// Macro to perfect forward API's to aliased names
#define _aliasfcn(highLevelF, lowLevelF)               \
    template <typename... Args>                        \
    inline decltype(auto) highLevelF(Args&&... args) { \
        return lowLevelF(std::forward<Args>(args)...); \
    }

#if ROCKETRIDE_PLAT_WIN
#include <apLib/plat/win/headers.h>
#elif ROCKETRIDE_PLAT_UNX
#include <apLib/plat/unx/headers.h>
#ifdef ROCKETRIDE_PLAT_LIN
#include <apLib/plat/lin/headers.h>
#elif ROCKETRIDE_PLAT_MAC
#include <apLib/plat/mac/headers.h>
#endif
#endif

// Boost
#include <boost/numeric/conversion/cast.hpp>
#include <apLib/util/flat/flat_map.hpp>
#include <apLib/util/flat/flat_multimap.hpp>
#include <apLib/util/flat/flat_set.hpp>
#include <boost/polymorphic_cast.hpp>
#include <boost/polymorphic_pointer_cast.hpp>
#include <boost/compressed_pair.hpp>
#include <boost/range/combine.hpp>
#include <boost/lexical_cast.hpp>
#include <boost/stacktrace.hpp>

#pragma warning(push)
#pragma warning(disable : 4701)
#include <boost/crc.hpp>
#pragma warning(pop)

// OpenSSL
#include <openssl/aes.h>
#include <openssl/ssl.h>
#include <openssl/ec.h>
#include <openssl/ecdh.h>
#include <openssl/engine.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/pkcs12.h>
#include <openssl/kdf.h>

// LZ4
#include <lz4.h>

// Uuid
#include <boost/uuid/uuid.hpp>
#include <boost/uuid/uuid_generators.hpp>
#include <boost/uuid/uuid_io.hpp>

// date
#include <date/date.h>

// On *nix include time zone helpers
#if ROCKETRIDE_PLAT_UNX
#include <date/tz.h>
#endif

// TinyXml2
#include <tinyxml2.h>

// ICU
#include <unicode/utypes.h>
#include <unicode/locid.h>
#include <unicode/ubrk.h>
#include <unicode/unistr.h>
#include <unicode/brkiter.h>
#include <unicode/ustring.h>
#include <unicode/parseerr.h>
#include <unicode/rbbi.h>
#include <unicode/coll.h>
#include <unicode/normalizer2.h>

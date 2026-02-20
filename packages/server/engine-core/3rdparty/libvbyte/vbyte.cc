/*
 * Copyright (C) 2005-2016 Christoph Rupp (chris@crupp.de).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
#include <assert.h>
#include <string.h>

#if defined(_MSC_VER) && _MSC_VER < 1600
typedef unsigned int uint32_t;
typedef unsigned char uint8_t;
typedef signed char int8_t;
#else
#  include <stdint.h>
#endif

#if defined(__AVX__) || defined(__AVX2__) || defined(__SSE4__)
#  define USE_MASKEDVBYTE 1
#endif

#include "vbyte.h"
#include "varintdecode.h"

namespace vbyte {

#ifdef __SSE2__

// AVX might be enabled at compile time, but it's still possible that
// it's not available at run-time because the CPU is an older model.

// from http://stackoverflow.com/questions/6121792/how-to-check-if-a-cpu-supports-the-sse3-instruction-set

#ifdef _WIN32
//  Windows
#  include <intrin.h>
#  define cpuid    __cpuid
#else
//  GCC Inline Assembly
static void
cpuid(int cpuinfo[4], int infotype) {
  __asm__ __volatile__ (
      "cpuid":
      "=a" (cpuinfo[0]),
      "=b" (cpuinfo[1]),
      "=c" (cpuinfo[2]),
      "=d" (cpuinfo[3]) :
      "a" (infotype)
  );
}
#endif

static inline bool
is_avx_available()
{
  static bool available = false;
  static bool initialized = false;
  if (!initialized) {
    initialized = true;

    int info[4];
    cpuid(info, 0);
    int num_ids = info[0];
    cpuid(info, 0x80000000);

    //  Detect Instruction Set
    if (num_ids >= 1) {
      cpuid(info, 0x00000001);
      available = (info[2] & ((int)1 << 28)) != 0;
    }
  }

  return available;
}
#else
static inline bool
is_avx_available()
{
  return false;
}
#endif

static inline int
read_int(const uint8_t *in, uint32_t *out)
{
  *out = in[0] & 0x7Fu;
  if (in[0] < 128)
    return 1;
  *out = ((in[1] & 0x7Fu) << 7) | *out;
  if (in[1] < 128)
    return 2;
  *out = ((in[2] & 0x7Fu) << 14) | *out;
  if (in[2] < 128)
    return 3;
  *out = ((in[3] & 0x7Fu) << 21) | *out;
  if (in[3] < 128)
    return 4;
  *out = ((in[4] & 0x7Fu) << 28) | *out;
  return 5;
}

static inline int
read_int(const uint8_t *in, uint64_t *out)
{
  *out = in[0] & 0x7Fu;
  if (in[0] < 128)
    return 1;
  *out = ((in[1] & 0x7Fu) << 7) | *out;
  if (in[1] < 128)
    return 2;
  *out = ((in[2] & 0x7Fu) << 14) | *out;
  if (in[2] < 128)
    return 3;
  *out = ((in[3] & 0x7Fu) << 21) | *out;
  if (in[3] < 128)
    return 4;
  *out = ((uint64_t)(in[4] & 0x7Fu) << 28) | *out;
  if (in[4] < 128)
    return 5;
  *out = ((uint64_t)(in[5] & 0x7Fu) << 35) | *out;
  if (in[5] < 128)
    return 6;
  *out = ((uint64_t)(in[6] & 0x7Fu) << 42) | *out;
  if (in[6] < 128)
    return 7;
  *out = ((uint64_t)(in[7] & 0x7Fu) << 49) | *out;
  if (in[7] < 128)
    return 8;
  *out = ((uint64_t)(in[8] & 0x7Fu) << 56) | *out;
  if (in[8] < 128)
    return 9;
  *out = ((uint64_t)(in[9] & 0x7Fu) << 63) | *out;
  return 10;
}

static inline int
write_int(uint8_t *p, uint32_t value)
{
  if (value < (1u << 7)) {
    *p = value & 0x7Fu;
    return 1;
  }
  if (value < (1u << 14)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 7;
    return 2;
  }
  if (value < (1u << 21)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 14;
    return 3;
  }
  if (value < (1u << 28)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 21;
    return 4;
  }
  else {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 21) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 28;
    return 5;
  }
}

static inline int
write_int(uint8_t *p, uint64_t value)
{
  if (value < (1lu << 7)) {
    *p = value & 0x7Fu;
    return 1;
  }
  if (value < (1lu << 14)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 7;
    return 2;
  }
  if (value < (1lu << 21)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 14;
    return 3;
  }
  if (value < (1lu << 28)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 21;
    return 4;
  }
  if (value < (1lu << 35)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 21) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 28;
    return 5;
  }
  if (value < (1lu << 42)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 21) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 28) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 35;
    return 6;
  }
  if (value < (1lu << 49)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 21) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 28) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 35) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 42;
    return 7;
  }
  if (value < (1lu << 56)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 21) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 28) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 35) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 42) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 49;
    return 8;
  }
  if (value < (1lu << 63)) {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 21) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 28) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 35) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 42) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 49) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 56;
    return 9;
  }
  else {
    *p = (value & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 7) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 14) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 21) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 28) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 35) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 42) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 49) & 0x7Fu) | (1u << 7);
    ++p;
    *p = ((value >> 56) & 0x7Fu) | (1u << 7);
    ++p;
    *p = value >> 63;
    return 10;
  }
}

static inline int
compressed_size(uint32_t value)
{
  if (value < (1u << 7))
    return 1;
  if (value < (1u << 14))
    return 2;
  if (value < (1u << 21))
    return 3;
  if (value < (1u << 28))
    return 4;
  return 5;
}

static inline int
compressed_size(uint64_t value)
{
  if (value < (1lu << 7))
    return 1;
  if (value < (1lu << 14))
    return 2;
  if (value < (1lu << 21))
    return 3;
  if (value < (1lu << 28))
    return 4;
  if (value < (1lu << 35))
    return 5;
  if (value < (1lu << 42))
    return 6;
  if (value < (1lu << 49))
    return 7;
  if (value < (1lu << 56))
    return 8;
  if (value < (1lu << 63))
    return 9;
  return 10;
}

template<typename T>
static inline size_t
compressed_size_sorted(const T *in, size_t length)
{
  size_t size = 0;
  const T *end = in + length;
  T previous = 0;

  for (; in < end; in++) {
    size += compressed_size(*in - previous);
    previous = *in;
  }

  return size;
}

template<typename T>
static inline size_t
compressed_size_unsorted(const T *in, size_t length)
{
  size_t size = 0;
  const T *end = in + length;

  for (; in < end; in++)
    size += compressed_size(*in);
  return size;
}

template<typename T>
static inline size_t
compress_unsorted(const T *in, uint8_t *out, size_t length)
{
  const uint8_t *initial_out = out;
  const T *end = in + length;

  while (in < end) {
    out += write_int(out, *in);
    ++in;
  }
  return out - initial_out;
}

template<typename T>
static inline size_t
uncompress_unsorted(const uint8_t *in, T *out, size_t length)
{
  const uint8_t *initial_in = in;

  for (size_t i = 0; i < length; i++) {
    in += read_int(in, out);
    ++out;
  }
  return in - initial_in;
}

template<typename T>
static inline size_t
compress_sorted(const T *in, uint8_t *out, T previous, size_t length)
{
  const uint8_t *initial_out = out;
  const T *end = in + length;

  while (in < end) {
    out += write_int(out, *in - previous);
    previous = *in;
    ++in;
  }
  return out - initial_out;
}

template<typename T>
static inline size_t
uncompress_sorted(const uint8_t *in, T *out, T previous, size_t length)
{
  const uint8_t *initial_in = in;

  for (size_t i = 0; i < length; i++) {
    T current;
    in += read_int(in, &current);
    previous += current;
    *out = previous;
    ++out;
  }
  return in - initial_in;
}

template<typename T>
static inline T
select_sorted(const uint8_t *in, uint32_t previous, size_t index)
{
  for (size_t i = 0; i <= index; i++) {
    T current;
    in += read_int(in, &current);
    previous += current;
  }
  return previous;
}

template<typename T>
static inline T
select_unsorted(const uint8_t *in, size_t index)
{
  T value = 0;

  for (size_t i = 0; i <= index; i++)
    in += read_int(in, &value);
  return value;
}

template<typename T>
static inline size_t
search_unsorted(const uint8_t *in, size_t length, T value)
{
  T v;

  for (size_t i = 0; i < length; i++) {
    in += read_int(in, &v);
    if (v == value)
      return i;
  }
  return length;
}

template<typename T>
static inline size_t
sorted_search(const uint8_t *in, size_t length, T value, T previous, T *actual)
{
  T v;

  for (size_t i = 0; i < length; i++) {
    in += read_int(in, &v);
    previous += v;
    if (previous >= value) {
      *actual = previous;
      return i;
    }
  }
  return length;
}

} // namespace vbyte

#ifdef __cplusplus
extern "C" {
#endif

size_t
vbyte_compressed_size_sorted32(const uint32_t *in, size_t length)
{
  return vbyte::compressed_size_sorted(in, length);
}

size_t
vbyte_compressed_size_sorted64(const uint64_t *in, size_t length)
{
  return vbyte::compressed_size_sorted(in, length);
}

size_t
vbyte_compressed_size_unsorted32(const uint32_t *in, size_t length)
{
  return vbyte::compressed_size_unsorted(in, length);
}

size_t
vbyte_compressed_size_unsorted64(const uint64_t *in, size_t length)
{
  return vbyte::compressed_size_unsorted(in, length);
}

size_t
vbyte_compress_unsorted32(const uint32_t *in, uint8_t *out, size_t length)
{
  return vbyte::compress_unsorted(in, out, length);
}

size_t
vbyte_compress_unsorted64(const uint64_t *in, uint8_t *out, size_t length)
{
  return vbyte::compress_unsorted(in, out, length);
}

size_t
vbyte_uncompress_unsorted32(const uint8_t *in, uint32_t *out, size_t length)
{
#if defined(USE_MASKEDVBYTE)
  if (vbyte::is_avx_available())
    return masked_vbyte_decode(in, out, (uint64_t)length);
#endif
  return vbyte::uncompress_unsorted(in, out, length);
}

size_t
vbyte_uncompress_unsorted64(const uint8_t *in, uint64_t *out, size_t length)
{
  return vbyte::uncompress_unsorted(in, out, length);
}

size_t
vbyte_compress_sorted32(const uint32_t *in, uint8_t *out, uint32_t previous,
                size_t length)
{
  return vbyte::compress_sorted(in, out, previous, length);
}

size_t
vbyte_compress_sorted64(const uint64_t *in, uint8_t *out, uint64_t previous,
                size_t length)
{
  return vbyte::compress_sorted(in, out, previous, length);
}

size_t
vbyte_uncompress_sorted32(const uint8_t *in, uint32_t *out, uint32_t previous,
                size_t length)
{
#if defined(USE_MASKEDVBYTE)
  if (vbyte::is_avx_available())
    return masked_vbyte_decode_delta(in, out, (uint64_t)length, previous);
#endif
  return vbyte::uncompress_sorted(in, out, previous, length);
}

size_t
vbyte_uncompress_sorted64(const uint8_t *in, uint64_t *out, uint64_t previous,
                size_t length)
{
  return vbyte::uncompress_sorted(in, out, previous, length);
}

uint32_t
vbyte_select_sorted32(const uint8_t *in, size_t size, uint32_t previous,
                size_t index)
{
  (void)size;
#if defined(USE_MASKEDVBYTE)
  if (vbyte::is_avx_available())
    return masked_vbyte_select_delta(in, (uint64_t)size, previous, index);
#endif
  return vbyte::select_sorted<uint32_t>(in, previous, index);
}

uint64_t
vbyte_select_sorted64(const uint8_t *in, size_t size, uint64_t previous,
                size_t index)
{
  (void)size;
  return vbyte::select_sorted<uint64_t>(in, previous, index);
}

uint32_t
vbyte_select_unsorted32(const uint8_t *in, size_t size, size_t index)
{
  (void)size;
  return vbyte::select_unsorted<uint32_t>(in, index);
}

uint64_t
vbyte_select_unsorted64(const uint8_t *in, size_t size, size_t index)
{
  (void)size;
  return vbyte::select_unsorted<uint64_t>(in, index);
}

size_t
vbyte_search_unsorted32(const uint8_t *in, size_t length, uint32_t value)
{
  return vbyte::search_unsorted(in, length, value);
}

size_t
vbyte_search_unsorted64(const uint8_t *in, size_t length, uint64_t value)
{
  return vbyte::search_unsorted(in, length, value);
}

size_t
vbyte_search_lower_bound_sorted32(const uint8_t *in, size_t length,
                uint32_t value, uint32_t previous, uint32_t *actual)
{
#if defined(USE_MASKEDVBYTE)
  if (vbyte::is_avx_available())
    return (size_t)masked_vbyte_search_delta(in, (uint64_t)length, previous,
                  value, actual);
#endif
  return vbyte::sorted_search(in, length, value, previous, actual);
}

size_t
vbyte_search_lower_bound_sorted64(const uint8_t *in, size_t length,
                uint64_t value, uint64_t previous, uint64_t *actual)
{
  return vbyte::sorted_search(in, length, value, previous, actual);
}

size_t
vbyte_append_sorted32(uint8_t *end, uint32_t previous, uint32_t value)
{
  assert(value > previous);
  return vbyte::write_int(end, value - previous);
}

size_t
vbyte_append_sorted64(uint8_t *end, uint64_t previous, uint64_t value)
{
  assert(value > previous);
  return vbyte::write_int(end, value - previous);
}

size_t
vbyte_append_unsorted32(uint8_t *end, uint32_t value)
{
  return vbyte::write_int(end, value);
}

size_t
vbyte_append_unsorted64(uint8_t *end, uint64_t value)
{
  return vbyte::write_int(end, value);
}

#ifdef __cplusplus
} // extern "C"
#endif

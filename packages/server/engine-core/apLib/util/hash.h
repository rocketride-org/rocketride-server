//-----------------------------------------------------------------------------
// MurmurHash3 was written by Austin Appleby, and is placed in the public
// domain. The author hereby disclaims copyright to this source code.
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

//-----------------------------------------------------------------------------
// Platform-specific functions and macros

// Microsoft Visual Studio

#if defined(_MSC_VER)

#ifndef __cplusplus
typedef unsigned char uint8_t;
typedef unsigned long uint32_t;
typedef unsigned __int64 uint64_t;
#endif

// Other compilers

#else  // defined(_MSC_VER)

#include <stdint.h>

#endif  // !defined(_MSC_VER)

//-----------------------------------------------------------------------------

void MurmurHash3_x86_32(const void* key, int len, uint32_t seed, void* out);

void MurmurHash3_x86_128(const void* key, int len, uint32_t seed, void* out);

void MurmurHash3_x64_128(const void* key, int len, uint32_t seed, void* out);

#ifdef __cplusplus
}
#endif

//-----------------------------------------------------------------------------

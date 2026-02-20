
#ifndef VARINTDECODE_H_
#define VARINTDECODE_H_
#define __STDC_FORMAT_MACROS
#include <inttypes.h>
#include <stdint.h>// please use a C99-compatible compiler
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Read "length" 32-bit integers in varint format from in, storing the result in out.  Returns the number of bytes read.
size_t masked_vbyte_decode(const uint8_t* in, uint32_t* out, uint64_t length);

// Read "length" 32-bit integers in varint format from in, storing the result in out with differential coding starting at prev.  Setting prev to zero is a good default. Returns the number of bytes read.
size_t masked_vbyte_decode_delta(const uint8_t* in, uint32_t* out, uint64_t length, uint32_t  prev);

// Read 32-bit integers in varint format from in, reading inputsize bytes, storing the result in out. Returns the number of integers read.
size_t masked_vbyte_decode_fromcompressedsize(const uint8_t* in, uint32_t* out,
		size_t inputsize);

// Read 32-bit integers in varint format from in, reading inputsize bytes, storing the result in out with differential coding starting at prev. Setting prev to zero is a good default. Returns the number of integers read.
size_t masked_vbyte_decode_fromcompressedsize_delta(const uint8_t* in, uint32_t* out,
		size_t inputsize, uint32_t  prev);

// assuming that the data was differentially-coded, retrieve one particular value (at location slot)
uint32_t masked_vbyte_select_delta(const uint8_t *in, uint64_t length,
                    uint32_t prev, size_t slot);

// return the position of the first value >= key, assumes differential-coded values
int masked_vbyte_search_delta(const uint8_t *in, uint64_t length, uint32_t prev,
                    uint32_t key, uint32_t *presult);

#ifdef __cplusplus
} // extern "C"
#endif

#endif /* VARINTDECODE_H_ */

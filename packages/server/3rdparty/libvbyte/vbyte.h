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

/**
 * A fast implementation for the Variable Byte encoding.
 *
 * See the README.md file for more information, example code and references.
 *
 * Feel free to send comments/questions to chris@crupp.de. I am available
 * for consulting.
 */

#ifndef VBYTE_H_ee452711_c856_416d_82f4_e12eef8a49be
#define VBYTE_H_ee452711_c856_416d_82f4_e12eef8a49be

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Calculates the size (in bytes) of a compressed stream of sorted 32bit
 * integers.
 *
 * This calculation is relatively expensive. As a cheap estimate, simply
 * multiply the number of integers by 5.
 *
 * This function uses delta encoding.
 */
extern size_t
vbyte_compressed_size_sorted32(const uint32_t *in, size_t length);

/**
 * Calculates the size (in bytes) of a compressed stream of sorted 64bit
 * integers.
 *
 * This calculation is relatively expensive. As a cheap estimate, simply
 * multiply the number of integers by 5.
 *
 * This function uses delta encoding.
 */
extern size_t
vbyte_compressed_size_sorted64(const uint64_t *in, size_t length);

/**
 * Calculates the size (in bytes) of a compressed stream of unsorted 32bit
 * integers.
 *
 * This calculation is relatively expensive. As a cheap estimate, simply
 * multiply the number of integers by 5.
 *
 * This function does NOT use delta encoding.
 */
extern size_t
vbyte_compressed_size_unsorted32(const uint32_t *in, size_t length);

/**
 * Calculates the size (in bytes) of a compressed stream of unsorted 64bit
 * integers.
 *
 * This calculation is relatively expensive. As a cheap estimate, simply
 * multiply the number of integers by 10.
 *
 * This function does NOT use delta encoding.
 */
extern size_t
vbyte_compressed_size_unsorted64(const uint64_t *in, size_t length);

/**
 * Compresses an unsorted sequence of |length| 32bit unsigned integers
 * at |in| and stores the result in |out|.
 *
 * This function does NOT use delta encoding.
 */
extern size_t
vbyte_compress_unsorted32(const uint32_t *in, uint8_t *out, size_t length);

/**
 * Compresses an unsorted sequence of |length| 64bit unsigned integers
 * at |in| and stores the result in |out|.
 *
 * This function does NOT use delta encoding.
 */
extern size_t
vbyte_compress_unsorted64(const uint64_t *in, uint8_t *out, size_t length);

/**
 * Compresses a sorted sequence of |length| 32bit unsigned integers
 * at |in| and stores the result in |out|.
 *
 * This function uses delta encoding.
 */
extern size_t
vbyte_compress_sorted32(const uint32_t *in, uint8_t *out, uint32_t previous,
                size_t length);

/**
 * Compresses a sorted sequence of |length| 64bit unsigned integers
 * at |in| and stores the result in |out|.
 *
 * This function uses delta encoding.
 */
extern size_t
vbyte_compress_sorted64(const uint64_t *in, uint8_t *out, uint64_t previous,
                size_t length);

/**
 * Uncompresses a sequence of |length| 32bit unsigned integers at |in|
 * and stores the result in |out|.
 *
 * This is the equivalent of |vbyte_compress_unsorted32|. It does NOT use
 * delta encoding.
 *
 * Returns the number of compressed bytes processed.
 */
extern size_t
vbyte_uncompress_unsorted32(const uint8_t *in, uint32_t *out, size_t length);

/**
 * Uncompresses a sequence of |length| 64bit unsigned integers at |in|
 * and stores the result in |out|.
 *
 * This is the equivalent of |vbyte_compress_unsorted64|. It does NOT use
 * delta encoding.
 *
 * Returns the number of compressed bytes processed.
 */
extern size_t
vbyte_uncompress_unsorted64(const uint8_t *in, uint64_t *out, size_t length);

/**
 * Uncompresses a sequence of |length| 32bit unsigned integers at |in|
 * and stores the result in |out|.
 *
 * This is the equivalent of |vbyte_compress_sorted32|. It uses
 * delta encoding.
 *
 * Returns the number of compressed bytes processed.
 */
extern size_t
vbyte_uncompress_sorted32(const uint8_t *in, uint32_t *out, uint32_t previous,
                size_t length);

/**
 * Uncompresses a sequence of |length| 64bit unsigned integers at |in|
 * and stores the result in |out|.
 *
 * This is the equivalent of |vbyte_compress_sorted64|. It uses
 * delta encoding.
 *
 * Returns the number of compressed bytes processed.
 */
extern size_t
vbyte_uncompress_sorted64(const uint8_t *in, uint64_t *out, uint64_t previous,
                size_t length);

/**
 * Returns the value at the given |index| from a sequence of compressed
 * 32bit integers.
 *
 * This routine uses delta compression.
 *
 * |size| is the size of the byte array pointed to by |in|.
 * Make sure that |index| does not exceed the length of the sequence.
 */
extern uint32_t
vbyte_select_sorted32(const uint8_t *in, size_t size, uint32_t previous,
                size_t index);

/**
 * Returns the value at the given |index| from a sequence of compressed
 * 64bit integers.
 *
 * This routine uses delta compression.
 *
 * |size| is the size of the byte array pointed to by |in|.
 * Make sure that |index| does not exceed the length of the sequence.
 */
extern uint64_t
vbyte_select_sorted64(const uint8_t *in, size_t size, uint64_t previous,
                size_t index);

/**
 * Returns the value at the given |index| from a sequence of compressed
 * 32bit integers.
 *
 * This routine does NOT use delta compression.
 *
 * |size| is the size of the byte array pointed to by |in|.
 * Make sure that |index| does not exceed the length of the sequence.
 */
extern uint32_t
vbyte_select_unsorted32(const uint8_t *in, size_t size, size_t index);

/**
 * Returns the value at the given |index| from a sequence of compressed
 * 64bit integers.
 *
 * This routine does NOT use delta compression.
 *
 * |size| is the size of the byte array pointed to by |in|.
 * Make sure that |index| does not exceed the length of the sequence.
 */
extern uint64_t
vbyte_select_unsorted64(const uint8_t *in, size_t size, size_t index);


/**
 * Performs a linear search for |value| in a sequence of compressed 32bit
 * unsigned integers.
 *
 * This function does NOT use delta encoding.
 *
 * Returns the index of the found element, or |length| if the key was not
 * found.
 */
extern size_t
vbyte_search_unsorted32(const uint8_t *in, size_t length, uint32_t value);

/**
 * Performs a linear search for |value| in a sequence of compressed 64bit
 * unsigned integers.
 *
 * This function does NOT use delta encoding.
 *
 * Returns the index of the found element, or |length| if the key was not
 * found.
 */
extern size_t
vbyte_search_unsorted64(const uint8_t *in, size_t length, uint64_t value);


/**
 * Performs a lower-bound search for |value| in a sequence of compressed 32bit
 * unsigned integers.
 *
 * A lower bound search returns the first element in the sequence which does
 * not compare less than |value|.
 * The actual result is stored in |*actual|.
 *
 * This function uses delta encoding.
 *
 * Returns the index of the found element, or |length| if the key was not
 * found.
 */
extern size_t
vbyte_search_lower_bound_sorted32(const uint8_t *in, size_t length,
                uint32_t value, uint32_t previous, uint32_t *actual);

/**
 * Performs a lower-bound search for |value| in a sequence of compressed 64bit
 * unsigned integers.
 *
 * A lower bound search returns the first element in the sequence which does
 * not compare less than |value|.
 * The actual result is stored in |*actual|.
 *
 * This function uses delta encoding.
 *
 * Returns the index of the found element, or |length| if the key was not
 * found.
 */
extern size_t
vbyte_search_lower_bound_sorted64(const uint8_t *in, size_t length,
                uint64_t value, uint64_t previous, uint64_t *actual);


/**
 * Appends |value| to a sequence of compressed 32bit unsigned integers.
 *
 * |end| is a pointer to the end of the compressed sequence (the first byte
 * AFTER the compressed data).
 * |previous| is the greatest encoded value in the sequence.
 *
 * This function uses delta encoding.
 *
 * Returns the number of bytes required to compress |value|.
 */
extern size_t
vbyte_append_sorted32(uint8_t *end, uint32_t previous, uint32_t value);

/**
 * Appends |value| to a sequence of compressed 64bit unsigned integers.
 *
 * |end| is a pointer to the end of the compressed sequence (the first byte
 * AFTER the compressed data).
 * |previous| is the greatest encoded value in the sequence.
 *
 * This function uses delta encoding.
 *
 * Returns the number of bytes required to compress |value|.
 */
extern size_t
vbyte_append_sorted64(uint8_t *end, uint64_t previous, uint64_t value);

/**
 * Appends |value| to a sequence of compressed 32bit unsigned integers.
 *
 * |end| is a pointer to the end of the compressed sequence (the first byte
 * AFTER the compressed data).
 *
 * This function does NOT use encoding.
 *
 * Returns the number of bytes required to compress |value|.
 */
extern size_t
vbyte_append_unsorted32(uint8_t *end, uint32_t value);

/**
 * Appends |value| to a sequence of compressed 64bit unsigned integers.
 *
 * |end| is a pointer to the end of the compressed sequence (the first byte
 * AFTER the compressed data).
 *
 * This function does NOT use encoding.
 *
 * Returns the number of bytes required to compress |value|.
 */
extern size_t
vbyte_append_unsorted64(uint8_t *end, uint64_t value);


#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* VBYTE_H_ee452711_c856_416d_82f4_e12eef8a49be */

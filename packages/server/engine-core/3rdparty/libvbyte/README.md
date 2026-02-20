libvbyte - Fast C Library for 32bit and 64bit Integer Compression
======================

A C library with a fast implementation for VByte integer compression.
Uses MaskedVbyte (SSE/AVX) for 32bit integers on supported platforms. It works
on Linux, Microsoft Windows and most likely all other sane systems.

libvbyte can compress sorted and unsorted integer sequences. It uses delta
compression for the sorted sequences.

In addition, the library can perform operations directly on compressed data:

   * select: returns a value at a specified index
   * linear search: for unsorted sequences, or short sorted sequences
   * lower bound search: based on binary search, for sorted sequences
   * append: appends an integer to a compressed sequence

Simple demo
------------------------

    #define LEN 100
    uint32_t in[LEN] = {0};
    uint8_t out[512];

    // Fill |in| with numbers of your choice
    for (int i = 0; i < LEN; i++)
      in[i] = i;

    // Now compress; can also use vbyte_compress_sorted() if the numbers
    // are sorted. This improves compression.
    uint32_t size = vbyte_compress_unsorted32(&in[0], &out[0], LEN);
    printf("compressing %u integers (%u bytes) into %u bytes\n",
            LEN, LEN * 4, size);
 
    // Decompress again
    uint32_t decompressed[LEN];
    vbyte_uncompress_unsorted32(&out[0], &decompressed[0], LEN);

See test.cc for more usage examples.

Usage
------------------------

It can't be more simple:

    make

To run the tests:

    ./test

Compile time configuration
----------------------

The Makefile automatically enables use of MaskedVbyte (SSE/AVX). If your
code should run on older platforms then undefine CFLAGS in the Makefile
(at the very top of the file).

MaskedVbyte can be compiled with AVX and AVX2. The code currently uses AVX.
If you want to use AVX2 instead then change the compiler setting in
the Makefile.

Where is this used?
----------------------

I use this library to compress 32bit and 64bit integers in upscaledb, a very
fast embedded key/value store (see https://upscaledb.com). 

If you would like me to add your application to this list then please send
me a mail at chris@crupp.de.

Licensing
------------------------

Apache License, Version 2.0

Requirements
------------------------

This library only works with little-endian CPUs.

Tested on Linux and Windows (Visual Studio 2013). Porting it should not
be difficult.

Acknowledgement
------------------------

This work is based on Daniel Lemire (http://lemire.me)'s ideas and
implementation at https://github.com/lemire/MaskedVbyte.

For further information, see
* Goldstein J, Ramakrishnan R, Shaft U. Compressing relations and indexes. Proceedings of the Fourteenth International Conference on Data Engineering, ICDE ’98, IEEE Computer Society: Washington, DC, USA, 1998; 370–379.
* Daniel Lemire and Leonid Boytsov, Decoding billions of integers per second through vectorization, Software Practice & Experience 45 (1), 2015.  http://arxiv.org/abs/1209.2137 http://onlinelibrary.wiley.com/doi/10.1002/spe.2203/abstract
* Daniel Lemire, Leonid Boytsov, Nathan Kurz, SIMD Compression and the Intersection of Sorted Integers, Software Practice & Experience (to appear) http://arxiv.org/abs/1401.6399
* Jeff Plaisance, Nathan Kurz, Daniel Lemire, Vectorized VByte Decoding, International Symposium on Web Algorithms 2015, 2015. http://arxiv.org/abs/1503.07387
* Wayne Xin Zhao, Xudong Zhang, Daniel Lemire, Dongdong Shan, Jian-Yun Nie, Hongfei Yan, Ji-Rong Wen, A General SIMD-based Approach to Accelerating Compression Algorithms, ACM Transactions on Information Systems 33 (3), 2015. http://arxiv.org/abs/1502.01916



// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================
//
// A planted error for the sanitizer job (.github/workflows/_sanitize.yaml).
// The job builds this file with ASan and UBSan, runs it and feeds its log
// folder to sanitizer-report.mjs: the job's own reporting is working only when
// that script finds exactly these two errors, one heap-buffer-overflow and one
// signed-integer-overflow. The program exits 0 itself; the volatile reads and
// values keep the compiler from removing either error.

#include <climits>
#include <cstdio>

int main() {
    // ASan: reads one element past the end of a heap array.
    volatile int size = 4;
    volatile int* array = new int[size];
    volatile int index = size;
    int outOfBounds = array[index];
    delete[] array;

    // UBSan: INT_MAX + 1 at run time.
    volatile int big = INT_MAX;
    volatile int one = 1;
    int overflow = big + one;

    std::printf("%d %d\n", outOfBounds, overflow);
    return 0;
}

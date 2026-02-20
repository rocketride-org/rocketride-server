// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

/*
 * Timestamp structure for the timestamps in struct statx.
 *
 * tv_sec holds the number of seconds before (negative) or after (positive)
 * 00:00:00 1st January 1970 UTC.
 *
 * tv_nsec holds a number of nanoseconds (0..999,999,999) after the tv_sec time.
 *
 * __reserved is held in case we need a yet finer resolution.
 */
struct statx_timestamp {
    __int64_t tv_sec;
    __uint32_t tv_nsec;
    __int32_t __reserved;
};

/*
 * Structures for the extended file attribute retrieval system call
 * (statx()).
 *
 * The caller passes a mask of what they're specifically interested in as a
 * parameter to statx().  What statx() actually got will be indicated in
 * st_mask upon return.
 *
 * For each bit in the mask argument:
 *
 * - if the datum is not supported:
 *
 *   - the bit will be cleared, and
 *
 *   - the datum will be set to an appropriate fabricated value if one is
 *     available (eg. CIFS can take a default uid and gid), otherwise
 *
 *   - the field will be cleared;
 *
 * - otherwise, if explicitly requested:
 *
 *   - the datum will be synchronised to the server if AT_STATX_FORCE_SYNC is
 *     set or if the datum is considered out of date, and
 *
 *   - the field will be filled in and the bit will be set;
 *
 * - otherwise, if not requested, but available in approximate form without any
 *   effort, it will be filled in anyway, and the bit will be set upon return
 *   (it might not be up to date, however, and no attempt will be made to
 *   synchronise the internal state first);
 *
 * - otherwise the field and the bit will be cleared before returning.
 *
 * Items in STATX_BASIC_STATS may be marked unavailable on return, but they
 * will have values installed for compatibility purposes so that stat() and
 * co. can be emulated in userspace.
 */
struct statx {
    /* 0x00 */
    __uint32_t stx_mask;       /* What results were written [uncond] */
    __uint32_t stx_blksize;    /* Preferred general I/O size [uncond] */
    __uint64_t stx_attributes; /* Flags conveying information about the file
                                  [uncond] */
    /* 0x10 */
    __uint32_t stx_nlink; /* Number of hard links */
    __uint32_t stx_uid;   /* User ID of owner */
    __uint32_t stx_gid;   /* Group ID of owner */
    __uint16_t stx_mode;  /* File mode */
    __uint16_t __spare0[1];
    /* 0x20 */
    __uint64_t stx_ino;             /* Inode number */
    __uint64_t stx_size;            /* File size */
    __uint64_t stx_blocks;          /* Number of 512-byte blocks allocated */
    __uint64_t stx_attributes_mask; /* Mask to show what's supported in
                                       stx_attributes */
    /* 0x40 */
    struct statx_timestamp stx_atime; /* Last access time */
    struct statx_timestamp stx_btime; /* File creation time */
    struct statx_timestamp stx_ctime; /* Last attribute change time */
    struct statx_timestamp stx_mtime; /* Last data modification time */
    /* 0x80 */
    __uint32_t stx_rdev_major; /* Device ID of special file [if bdev/cdev] */
    __uint32_t stx_rdev_minor;
    __uint32_t stx_dev_major; /* ID of device containing file [uncond] */
    __uint32_t stx_dev_minor;
    /* 0x90 */
    __uint64_t __spare2[14]; /* Spare space for future expansion */
    /* 0x100 */
};

/*
 * Flags to be stx_mask
 *
 * Query request/result mask for statx() and struct statx::stx_mask.
 *
 * These bits should be set in the mask argument of statx() to request
 * particular items when calling statx().
 */
#define STATX_TYPE 0x00000001U        /* Want/got stx_mode & S_IFMT */
#define STATX_MODE 0x00000002U        /* Want/got stx_mode & ~S_IFMT */
#define STATX_NLINK 0x00000004U       /* Want/got stx_nlink */
#define STATX_UID 0x00000008U         /* Want/got stx_uid */
#define STATX_GID 0x00000010U         /* Want/got stx_gid */
#define STATX_ATIME 0x00000020U       /* Want/got stx_atime */
#define STATX_MTIME 0x00000040U       /* Want/got stx_mtime */
#define STATX_CTIME 0x00000080U       /* Want/got stx_ctime */
#define STATX_INO 0x00000100U         /* Want/got stx_ino */
#define STATX_SIZE 0x00000200U        /* Want/got stx_size */
#define STATX_BLOCKS 0x00000400U      /* Want/got stx_blocks */
#define STATX_BASIC_STATS 0x000007ffU /* The stuff in the normal stat struct \
                                       */
#define STATX_BTIME 0x00000800U       /* Want/got stx_btime */
#define STATX_ALL 0x00000fffU         /* All currently supported flags */
#define STATX__RESERVED \
    0x80000000U /* Reserved for future struct statx expansion */

/*
 * Attributes to be found in stx_attributes and masked in stx_attributes_mask.
 *
 * These give information about the features or the state of a file that might
 * be of use to ordinary userspace programs such as GUIs or ls rather than
 * specialised tools.
 *
 * Note that the flags marked [I] correspond to generic FS_IOC_FLAGS
 * semantically.  Where possible, the numerical value is picked to correspond
 * also.
 */
#define STATX_ATTR_COMPRESSED 0x00000004 /* [I] File is compressed by the fs \
                                          */
#define STATX_ATTR_IMMUTABLE 0x00000010  /* [I] File is marked immutable */
#define STATX_ATTR_APPEND 0x00000020     /* [I] File is append-only */
#define STATX_ATTR_NODUMP 0x00000040     /* [I] File is not to be dumped */
#define STATX_ATTR_ENCRYPTED \
    0x00000800 /* [I] File requires key to decrypt in fs */

#define STATX_ATTR_AUTOMOUNT 0x00001000 /* Dir: Automount trigger */

inline int statx(int __dirfd, const char *__restrict __path, int __flags,
                 unsigned int __mask, struct statx *__restrict __buf) {
#ifdef ROCKETRIDE_PLAT_MAC
    // Mac does not support statx
    return -1;
#else
    return syscall(__NR_statx, __dirfd, __path, __flags, __mask, __buf);
#endif
}

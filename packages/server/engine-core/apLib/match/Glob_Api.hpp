#pragma once
//
//	Glob pattern matching
//
//		Copyright (c) 1989, 1993, 1994
//			The Regents of the University of California.  All rights reserved.
//
//		This code is derived from software contributed to Berkeley by
//		Guido van Rossum.
//
//		Redistribution and use in source and binary forms, with or without
//		modification, are permitted provided that the following conditions
//		are met:
//		1. Redistributions of source code must retain the above copyright
//		   notice, this list of conditions and the following disclaimer.
//		2. Redistributions in binary form must reproduce the above copyright
//		   notice, this list of conditions and the following disclaimer in the
//		   documentation and/or other materials provided with the distribution.
//		3. All advertising materials mentioning features or use of this software
//		   must display the following acknowledgement:
//			This product includes software developed by the University of
//			California, Berkeley and its contributors.
//		4. Neither the name of the University nor the names of its contributors
//		   may be used to endorse or promote products derived from this software
//		   without specific prior written permission.
//
//		THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS ``AS IS'' AND
//		ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
//		IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
//PURPOSE 		ARE DISCLAIMED.  IN NO EVENT SHALL THE REGENTS OR CONTRIBUTORS BE
//LIABLE 		FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
//CONSEQUENTIAL 		DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
//SUBSTITUTE GOODS 		OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//INTERRUPTION) 		HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
//CONTRACT, STRICT 		LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
//ARISING IN ANY WAY 		OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
//POSSIBILITY OF 		SUCH DAMAGE.
//
//		From FreeBSD fnmatch.c 1.11
//		$Id: fnmatch.c,v 1.3 1997/08/19 02:34:30 jdp Exp $
//

namespace ap::globber {

// Flags to specify to glob match
class GlobFlags {
public:
    // Public declarations

    // No wildcard can ever match `/'.
    _const auto PATHNAME = BIT(0);

    // Backslashes don't quote special chars.
    _const auto NOESCAPE = BIT(1);

    // Leading `.' is matched only explicitly.
    _const auto PERIOD = BIT(2);

    // Ignore `/...' after a match.
    _const auto LEADING_DIR = BIT(3);

    // Enable matching on prefix dirs
    _const auto PREFIX_DIRS = BIT(4);
};

namespace {

// Save our fingers
using TextPos = TextView::const_iterator;

// Internal range matcher, matches the []'s contents
template <template <typename ChrT> typename TraitT, uint32_t Flags>
inline bool rangeMatch(TextPos &patPos, const TextPos &patEnd,
                       const TextChr test) noexcept {
    /*
     * A bracket expression starting with an unquoted circumflex
     * character produces unspecified results (IEEE 1003.2-1992,
     * 3.13.2).  This implementation treats it like '!', for
     * consistency with the regular expression syntax.
     * J.T. Conklin (conklin@ngai.kaleida.com)
     */
    auto negate = *patPos == '!' || *patPos == '^';
    if (negate) ++patPos;

    auto ok = false;
    TextChr c;
    while (patPos != patEnd && (c = *patPos++) != ']') {
        if constexpr ((Flags & GlobFlags::NOESCAPE) == 0) {
            if (c == '\\') c = *patPos++;
        }

        if (patPos == patEnd) return false;

        auto nextIsubEnd = (patPos + 1) == patEnd;
        TextChr c2 = nextIsubEnd ? '\0' : *(patPos + 1);
        if (*patPos == '-' && !nextIsubEnd && c2 != ']') {
            std::advance(patPos, 2);
            if constexpr ((Flags & GlobFlags::NOESCAPE) == 0) {
                if (c2 == '\\') c2 = *patPos++;
            }
            if (patPos == patEnd) return false;

            if (string::inRangeInclusive<TraitT>(c, test, c2)) ok = true;
        } else if (string::isEqual<TraitT>(c, test))
            ok = true;
    }

    return (ok == negate ? false : true);
}

// Internal glob recursive function
template <template <typename ChrT> typename TraitT, uint32_t Flags>
inline bool globInternal(TextPos patPos, const TextPos &patBeg,
                         const TextPos &patEnd, TextPos subPos,
                         const TextPos &subBeg,
                         const TextPos &subEnd) noexcept {
    while (patPos != patEnd && subPos != subEnd) {
        switch (auto c = *patPos++) {
            case '?':
                if constexpr ((Flags & GlobFlags::PATHNAME) != 0) {
                    if (*subPos == '/') return false;
                }

                if constexpr ((Flags & GlobFlags::PERIOD) != 0) {
                    if (*subPos == '.' &&
                        (subPos == subBeg || ((Flags & GlobFlags::PATHNAME) &&
                                              *(subPos - 1) == '/')))
                        return false;
                }
                ++subPos;
                break;
            case '*':
                /* Collapse multiple stars. */
                while (patPos != patEnd && *patPos == '*') c = *++patPos;

                if constexpr ((Flags & GlobFlags::PERIOD) != 0) {
                    if (*subPos == '.' &&
                        (subPos == subBeg || ((Flags & GlobFlags::PATHNAME) &&
                                              *(subPos - 1) == '/')))
                        return false;
                }

                /* Optimize for pattern with * at end or before /. */
                if (patPos == patEnd) {
                    if constexpr ((Flags & GlobFlags::PATHNAME) != 0)
                        return (Flags & GlobFlags::LEADING_DIR) ||
                               std::find(subPos, subEnd, '/') == subEnd;
                    return true;
                } else if constexpr ((Flags & GlobFlags::PATHNAME) != 0) {
                    if (c == '/') {
                        if ((subPos = std::find(subPos, subEnd, '/')) == subEnd)
                            return false;
                    }
                }

                /* General case, use recursion. */
                while (subPos != subEnd) {
                    if (globInternal < TraitT,
                        Flags & ~GlobFlags::PERIOD > (patPos, patBeg, patEnd,
                                                      subPos, subBeg, subEnd))
                        return true;
                    if constexpr ((Flags & GlobFlags::PATHNAME) != 0) {
                        auto test = *subPos;
                        if (test == '/') break;
                    }
                    ++subPos;
                }
                return false;
            case '[':
                if constexpr ((Flags & GlobFlags::PATHNAME) != 0) {
                    if (*subPos == '/') return false;
                }

                if (!rangeMatch<TraitT, Flags>(patPos, patEnd, *subPos))
                    return false;
                ++subPos;
                break;
            case '\\':
                if constexpr ((Flags & GlobFlags::NOESCAPE) == 0) {
                    if (patPos != patEnd) c = *++patPos;
                }
                /* FALLTHROUGH */
            default:
                if (string::isEqual<TraitT>(c, *subPos)) {
                    subPos++;
                    break;
                }

                return false;
        }
    }

    auto matched = subPos == subEnd &&
                   (patPos == patEnd ||
                    std::all_of(patPos, patEnd, [](auto pChr) noexcept {
                        return pChr == '*';
                    }));

    if constexpr ((Flags & GlobFlags::LEADING_DIR) != 0) {
        if (subPos != subEnd &&
            (*subPos == '/' || (subPos != subBeg && *(subPos - 1) == '/')))
            matched = true;
    }

    return matched;
}

}  // namespace

// Attempts to match the given string
template <template <typename ChrT> typename TraitT,
          uint32_t Flags = GlobFlags::LEADING_DIR>
inline bool glob(TextView pattern, TextView subject) noexcept {
    if (!pattern || !subject) return false;

    auto patPos = pattern.begin();
    auto subPos = subject.begin();

    auto patEnd = pattern.back() == '\0' ? pattern.end() - 1 : pattern.end();
    auto subEnd = subject.back() == '\0' ? subject.end() - 1 : subject.end();

    return globInternal<TraitT, Flags>(patPos, pattern.begin(), patEnd, subPos,
                                       subject.begin(), subEnd);
}

}  // namespace ap::globber

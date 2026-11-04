// =============================================================================
// RocketRide Engine
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

package com.rocketride.tika_api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The RAR parser swap in ConfigBuilder names a class. #2440 moved the Tika sources into the
 * parse node and left RarSevenZipParser behind, so the name resolved to nothing and RAR
 * archives extracted nothing, silently (#2678). The class has to be in this jar, and
 * ConfigBuilder has to check that before it removes Tika's own RarParser.
 */
class TestRarParserWiring {

    @Test
    void rarSevenZipParserIsOnTheClasspath() {
        assertTrue(ConfigBuilder.classPresent(ConfigBuilder.RAR_SEVENZIP_PARSER),
                ConfigBuilder.RAR_SEVENZIP_PARSER + " is not in the parse jar");
    }

    @Test
    void classPresentIsFalseForAMissingClass() {
        assertFalse(ConfigBuilder.classPresent("com.rocketride.tika_api.parsers.rar.NoSuchParser"));
    }
}

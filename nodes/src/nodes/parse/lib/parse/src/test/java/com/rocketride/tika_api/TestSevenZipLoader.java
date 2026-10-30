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

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.AccessDeniedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;
import java.util.Properties;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import net.sf.sevenzipjbinding.SevenZip;

/**
 * SevenZipLoader.extract() only copies and renames files, so any platform in the jar will do:
 * these run the same on every OS (#2790).
 */
class TestSevenZipLoader {

    private static String platform;
    private static String name;
    private static String hash;
    private static byte[] library;

    @TempDir
    Path tmp;

    @BeforeAll
    static void readTheJar() throws Exception {
        platform = SevenZip.getPlatformList().get(0);
        Properties properties = new Properties();
        try (InputStream in = SevenZip.class.getResourceAsStream("/" + platform + "/sevenzipjbinding-lib.properties")) {
            properties.load(in);
        }
        name = properties.getProperty("lib.1.name").trim();
        hash = properties.getProperty("lib.1.hash").trim();
        try (InputStream in = SevenZip.class.getResourceAsStream("/" + platform + "/" + name)) {
            library = in.readAllBytes();
        }
    }

    private Path target() {
        return tmp.resolve("SevenZipJBinding-" + hash).resolve(name);
    }

    private List<String> filesBeside(Path file) throws IOException {
        try (Stream<Path> files = Files.list(file.getParent())) {
            return files.map(f -> f.getFileName().toString()).sorted().collect(Collectors.toList());
        }
    }

    @Test
    void extractsTheJarsLibraryIntoAContentNamedDirectory() throws Exception {
        Path extracted = SevenZipLoader.extract(tmp, platform, SevenZipLoader.ATOMIC_MOVE);

        assertEquals(target(), extracted);
        assertArrayEquals(library, Files.readAllBytes(extracted));
        assertEquals(List.of(name), filesBeside(extracted), "a .part file was left behind");
    }

    @Test
    void reusesACompleteFileWithoutWritingIt() throws Exception {
        Path extracted = SevenZipLoader.extract(tmp, platform, SevenZipLoader.ATOMIC_MOVE);
        FileTime old = FileTime.fromMillis(946684800000L);
        Files.setLastModifiedTime(extracted, old);

        Path again = SevenZipLoader.extract(tmp, platform, (source, target) -> {
            throw new AssertionError("a complete library was published again");
        });

        assertEquals(extracted, again);
        assertEquals(old, Files.getLastModifiedTime(again));
    }

    @Test
    void replacesADamagedFile() throws Exception {
        Files.createDirectories(target().getParent());
        Files.write(target(), new byte[] { 1, 2, 3 });

        Path extracted = SevenZipLoader.extract(tmp, platform, SevenZipLoader.ATOMIC_MOVE);

        assertArrayEquals(library, Files.readAllBytes(extracted));
        assertEquals(List.of(name), filesBeside(extracted));
    }

    @Test
    void takesTheCopyAnotherProcessPublishedWhenTheMoveIsRefused() throws Exception {
        // Another task publishes between our check and our move, then has the library loaded:
        // Windows refuses to replace it
        Path extracted = SevenZipLoader.extract(tmp, platform, (source, target) -> {
            Files.write(target, library);
            throw new AccessDeniedException(target.toString());
        });

        assertEquals(target(), extracted);
        assertArrayEquals(library, Files.readAllBytes(extracted));
        assertEquals(List.of(name), filesBeside(extracted));
    }

    @Test
    void failsWhenTheMoveIsRefusedAndNoCompleteFileIsThere() throws Exception {
        assertThrows(AccessDeniedException.class, () -> SevenZipLoader.extract(tmp, platform, (source, target) -> {
            throw new AccessDeniedException(target.toString());
        }));

        assertFalse(Files.exists(target()));
        assertEquals(List.of(), filesBeside(target()), "a .part file was left behind");
    }

    @Test
    void leavesAPlatformTheJarDoesNotDescribeToTheJarsOwnLoader() throws Exception {
        // null sends SevenZipLoader.load() to SevenZip.initSevenZipFromPlatformJAR()
        assertNull(SevenZipLoader.extract(tmp, "No-Such-Platform", SevenZipLoader.ATOMIC_MOVE));
        try (Stream<Path> files = Files.list(tmp)) {
            assertEquals(0, files.count());
        }
    }

    @Test
    void hashesKeepTheirLeadingZeros() {
        assertEquals("000cab", SevenZipLoader.hex(new byte[] { 0x00, 0x0c, (byte) 0xab }));
    }
}

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

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import net.sf.sevenzipjbinding.IInArchive;
import net.sf.sevenzipjbinding.SevenZip;
import net.sf.sevenzipjbinding.util.ByteArrayStream;

/**
 * One parse task's JVM, for TestSevenZipLoaderConcurrency: load the binding, then open an archive
 * through it, once or until a stop file appears.
 *
 * args: loader|jar [stop file]; "jar" uses SevenZip.initSevenZipFromPlatformJAR(), the old path.
 */
public final class SevenZipLoadProbe {
    private SevenZipLoadProbe() {
    }

    public static void main(String[] args) throws Exception {
        if ("jar".equals(args[0])) {
            SevenZip.initSevenZipFromPlatformJAR();
        } else {
            SevenZipLoader.load();
        }
        System.out.println("LOADED");
        System.out.flush();

        byte[] zip = zip();
        long opened = 0;
        do {
            IInArchive archive = SevenZip.openInArchive(null, new ByteArrayStream(zip, false));
            try {
                if (archive.getNumberOfItems() != 1) {
                    throw new IllegalStateException("expected 1 item, got " + archive.getNumberOfItems());
                }
            } finally {
                archive.close();
            }
            opened++;
        } while (args.length > 1 && !Files.exists(Paths.get(args[1])));
        System.out.println("OK " + opened);
    }

    private static byte[] zip() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            zip.putNextEntry(new ZipEntry("probe.txt"));
            zip.write("7-Zip-JBinding probe".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        return bytes.toByteArray();
    }
}

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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.File;
import java.io.IOException;
import java.net.JarURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import net.sf.sevenzipjbinding.SevenZip;
import net.sf.sevenzipjbinding.SevenZipNativeInitializationException;

/**
 * Parse tasks are separate processes that share one java.io.tmpdir (the engine's &lt;data&gt;/cache),
 * so they load 7-Zip-JBinding from the same file. Threads in one JVM cannot show what the processes do
 * to that file, processes can (#2790).
 *
 * With -Dsevenzip.loader=jar the probes take SevenZip.initSevenZipFromPlatformJAR() instead, the path
 * before #2790: most of them fail on Windows, and on Linux some crash.
 */
class TestSevenZipLoaderConcurrency {

    private static final int PROCESSES = 8;
    private static final String LOADER = System.getProperty("sevenzip.loader", "loader");

    @TempDir
    Path tmp;

    private final List<Process> started = new ArrayList<>();

    @BeforeAll
    static void theJarHasALibraryForThisPlatform() {
        try {
            SevenZip.getPlatformBestMatch();
        } catch (SevenZipNativeInitializationException e) {
            assumeTrue(false, "7-Zip-JBinding ships no library for this platform");
        }
    }

    @BeforeEach
    void emptyTmpdir() throws IOException {
        Files.createDirectories(tmp.resolve("cache"));
    }

    // Also unlocks the library on Windows, so the temp dir can be removed
    @AfterEach
    void stopProbes() throws InterruptedException {
        for (Process process : started) {
            process.destroyForcibly().waitFor();
        }
    }

    @Test
    void processesStartingTogetherAllLoad() throws Exception {
        assertEquals(List.of(), failures(startProbes()));
    }

    @Test
    void processesStartingWhileAnotherRunsArchiveCodeAllLoadAndItSurvives() throws Exception {
        Path stop = tmp.resolve("stop");
        Process holder = probe("holder", stop.toString());
        awaitLoaded("holder", holder);

        List<String> failed = failures(startProbes());
        Files.createFile(stop);
        failed.addAll(failures(Map.of("holder", holder)));

        assertEquals(List.of(), failed);
    }

    // The probe's own classes and the two 7-Zip-JBinding jars; Tika's whole classpath can pass
    // Windows' command line limit
    private static String probeClasspath() throws Exception {
        URL platforms = SevenZip.class.getResource("/sevenzipjbinding-platforms.properties");
        URL allPlatformsJar = ((JarURLConnection) platforms.openConnection()).getJarFileURL();
        return Stream.of(location(SevenZipLoadProbe.class), location(SevenZipLoader.class), location(SevenZip.class),
                Paths.get(allPlatformsJar.toURI()))
                .distinct()
                .map(Path::toString)
                .collect(Collectors.joining(File.pathSeparator));
    }

    private static Path location(Class<?> type) throws Exception {
        return Paths.get(type.getProtectionDomain().getCodeSource().getLocation().toURI());
    }

    private Map<String, Process> startProbes() throws Exception {
        Map<String, Process> probes = new LinkedHashMap<>();
        for (int i = 0; i < PROCESSES; i++) {
            probes.put("probe" + i, probe("probe" + i));
        }
        return probes;
    }

    private Process probe(String id, String... extra) throws Exception {
        List<String> command = new ArrayList<>(List.of(
                Paths.get(System.getProperty("java.home"), "bin", "java").toString(),
                "-Djava.io.tmpdir=" + tmp.resolve("cache"),
                "-cp", probeClasspath(),
                SevenZipLoadProbe.class.getName(), LOADER));
        command.addAll(List.of(extra));
        Process process = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .redirectOutput(log(id).toFile())
                .start();
        started.add(process);
        return process;
    }

    private Path log(String id) {
        return tmp.resolve(id + ".log");
    }

    private void awaitLoaded(String id, Process process) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(1);
        while (!Files.readString(log(id)).contains("LOADED")) {
            assertTrue(process.isAlive() && System.nanoTime() < deadline,
                    id + " did not load:\n" + Files.readString(log(id)));
            Thread.sleep(50);
        }
    }

    private List<String> failures(Map<String, Process> probes) throws Exception {
        List<String> failed = new ArrayList<>();
        for (Map.Entry<String, Process> probe : probes.entrySet()) {
            Process process = probe.getValue();
            boolean finished = process.waitFor(2, TimeUnit.MINUTES);
            String log = Files.readString(log(probe.getKey()));
            if (!finished || process.exitValue() != 0 || !log.contains("OK ")) {
                failed.add(probe.getKey() + (finished ? " exit " + process.exitValue() : " hung") + ": "
                        + log.lines().limit(4).reduce((a, b) -> a + " | " + b).orElse(""));
            }
        }
        return failed;
    }
}

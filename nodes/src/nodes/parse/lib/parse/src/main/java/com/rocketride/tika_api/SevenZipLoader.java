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

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.Properties;
import java.util.logging.Level;
import java.util.logging.Logger;

import net.sf.sevenzipjbinding.SevenZip;
import net.sf.sevenzipjbinding.SevenZipNativeInitializationException;

/**
 * Loads 7-Zip-JBinding's native library out of the platform jar without the jar's own extractor.
 *
 * SevenZip.initSevenZipFromPlatformJAR() rewrites java.io.tmpdir/SevenZipJBinding-&lt;build.ref&gt;/&lt;lib&gt;
 * in place, and every task shares that tmpdir. Tasks that start together load a half-written file,
 * and 16.02-2.01 never matches its own hash, so it rewrites the library under tasks that have it
 * loaded: Windows refuses, Linux truncates it under them (#2790). Here a complete file is reused and
 * never written again; a missing or damaged one is replaced only by renaming a finished copy over it.
 */
final class SevenZipLoader {
	private static final Logger logger = Logger.getLogger("TikaApi");

	/** Moves a finished copy into place; tests replace it to stage a concurrent publish. */
	@FunctionalInterface
	interface Publish {
		void move(Path source, Path target) throws IOException;
	}

	static final Publish ATOMIC_MOVE = (source, target) -> Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);

	private SevenZipLoader() {
	}

	/**
	 * Load the binding for this platform into the JVM and initialize it.
	 */
	static void load() throws IOException, SevenZipNativeInitializationException {
		Path library = extract(Paths.get(System.getProperty("java.io.tmpdir")), SevenZip.getPlatformBestMatch(),
				ATOMIC_MOVE);
		if (library == null) {
			logger.log(Level.WARNING, "7-Zip-JBinding jar has an unexpected layout; using its own extractor");
			SevenZip.initSevenZipFromPlatformJAR();
			return;
		}
		System.load(library.toString());
		SevenZip.initLoadedLibraries();
		logger.log(Level.INFO, "7-Zip-JBinding loaded from " + library);
	}

	/**
	 * Make sure a complete copy of the platform's library is on disk.
	 *
	 * @param tmpDir   where the library directory lives (java.io.tmpdir in the engine)
	 * @param platform a platform directory of the jar, e.g. Windows-amd64
	 * @param publish  moves the finished copy into place
	 * @return the library, or null when the jar has no single-library properties for the platform
	 */
	static Path extract(Path tmpDir, String platform, Publish publish) throws IOException {
		Properties properties = new Properties();
		try (InputStream in = SevenZip.class.getResourceAsStream("/" + platform + "/sevenzipjbinding-lib.properties")) {
			if (in == null) {
				return null;
			}
			properties.load(in);
		}
		String name = properties.getProperty("lib.1.name");
		String hash = properties.getProperty("lib.1.hash");
		if (name == null || hash == null || properties.getProperty("lib.2.name") != null) {
			return null;
		}
		name = name.trim();
		hash = hash.trim().toLowerCase(Locale.ROOT);

		// Named by content and apart from the jar's own directory, which its extractor rewrites in place
		Path dir = tmpDir.resolve("SevenZipJBinding-" + hash);
		Path target = dir.resolve(name);
		if (hashMatches(target, hash)) {
			return target;
		}

		Files.createDirectories(dir);
		Path part = Files.createTempFile(dir, name + ".", ".part");
		try {
			String resource = "/" + platform + "/" + name;
			try (InputStream in = SevenZip.class.getResourceAsStream(resource)) {
				if (in == null) {
					throw new IOException(resource + " is not in the 7-Zip-JBinding jar");
				}
				MessageDigest sha1 = sha1();
				Files.copy(new DigestInputStream(in, sha1), part, StandardCopyOption.REPLACE_EXISTING);
				if (!hex(sha1.digest()).equals(hash)) {
					throw new IOException(resource + " does not match lib.1.hash " + hash);
				}
			}
			try {
				publish.move(part, target);
			} catch (IOException e) {
				// Windows refuses to replace a library another task has loaded; that one is complete
				if (!hashMatches(target, hash)) {
					throw e;
				}
			}
		} finally {
			Files.deleteIfExists(part);
		}
		return target;
	}

	static boolean hashMatches(Path file, String hash) throws IOException {
		if (!Files.isRegularFile(file)) {
			return false;
		}
		MessageDigest sha1 = sha1();
		try (InputStream in = new DigestInputStream(Files.newInputStream(file), sha1)) {
			in.transferTo(OutputStream.nullOutputStream());
		}
		return hex(sha1.digest()).equals(hash);
	}

	// Zero-padded: 16.02-2.01's own check drops the zeros and never matches lib.1.hash
	static String hex(byte[] bytes) {
		StringBuilder text = new StringBuilder(bytes.length * 2);
		for (byte b : bytes) {
			text.append(String.format("%02x", b & 0xff));
		}
		return text.toString();
	}

	private static MessageDigest sha1() {
		try {
			return MessageDigest.getInstance("SHA-1");
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}
}

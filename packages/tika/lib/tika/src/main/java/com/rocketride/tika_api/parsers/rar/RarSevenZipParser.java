/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.rocketride.tika_api.parsers.rar;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.apache.tika.exception.EncryptedDocumentException;
import org.apache.tika.exception.TikaException;
import org.apache.tika.extractor.EmbeddedDocumentExtractor;
import org.apache.tika.extractor.EmbeddedDocumentUtil;
import org.apache.tika.io.TemporaryResources;
import org.apache.tika.io.TikaInputStream;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.metadata.TikaCoreProperties;
import org.apache.tika.mime.MediaType;
import org.apache.tika.parser.ParseContext;
import org.apache.tika.parser.Parser;
import org.apache.tika.sax.XHTMLContentHandler;
import org.xml.sax.ContentHandler;
import org.xml.sax.SAXException;
import org.xml.sax.helpers.AttributesImpl;

import net.sf.sevenzipjbinding.ExtractAskMode;
import net.sf.sevenzipjbinding.ExtractOperationResult;
import net.sf.sevenzipjbinding.IArchiveExtractCallback;
import net.sf.sevenzipjbinding.IInArchive;
import net.sf.sevenzipjbinding.ISequentialOutStream;
import net.sf.sevenzipjbinding.SevenZip;
import net.sf.sevenzipjbinding.SevenZipException;
import net.sf.sevenzipjbinding.impl.RandomAccessFileInStream;
import net.sf.sevenzipjbinding.simple.ISimpleInArchive;
import net.sf.sevenzipjbinding.simple.ISimpleInArchiveItem;

/**
 * RAR parser backed by 7-Zip-JBinding. Replaces Tika's built-in
 * {@code org.apache.tika.parser.pkg.RarParser}, which is JUnRAR-based and
 * explicitly rejects RAR5 archives.
 *
 * The parser spools the input to a temp file, opens it via 7-Zip-JBinding's
 * auto-detection (handles both RAR4 and RAR5), enumerates the entries it can
 * read, then extracts the selected ones in a single bulk pass and routes each
 * to the {@link EmbeddedDocumentExtractor} on the parse context.
 *
 * <p>Extraction uses {@link IInArchive#extract(int[], boolean, IArchiveExtractCallback)}
 * rather than per-entry {@code extractSlow}: RAR archives are frequently solid,
 * where {@code extractSlow} re-decompresses from the start of the archive for
 * every entry (O(n&sup2;) on an n-entry archive). A single bulk call decompresses
 * the whole archive once while preserving solid-block ordering.
 */
public class RarSevenZipParser implements Parser {
    private static final long serialVersionUID = 1L;

    private static final Logger logger = Logger.getLogger("TikaApi");

    private static final Set<MediaType> SUPPORTED_TYPES = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    MediaType.application("x-rar-compressed"),
                    MediaType.application("x-rar"),
                    MediaType.application("vnd.rar"))));

    @Override
    public Set<MediaType> getSupportedTypes(ParseContext context) {
        return SUPPORTED_TYPES;
    }

    @Override
    public void parse(InputStream stream, ContentHandler handler, Metadata metadata, ParseContext context)
            throws IOException, SAXException, TikaException {
        XHTMLContentHandler xhtml = new XHTMLContentHandler(handler, metadata);
        xhtml.startDocument();

        EmbeddedDocumentExtractor extractor = EmbeddedDocumentUtil.getEmbeddedDocumentExtractor(context);

        try (TemporaryResources tmp = new TemporaryResources();
                TikaInputStream tis = TikaInputStream.get(stream, tmp, metadata)) {
            File rarFile = tis.getFile();

            try (RandomAccessFile raf = new RandomAccessFile(rarFile, "r");
                    RandomAccessFileInStream inStream = new RandomAccessFileInStream(raf);
                    IInArchive archive = SevenZip.openInArchive(null, inStream)) {

                // Pass 1: enumerate entries, emit their XHTML markers, and collect
                // the indices we actually want to extract (skipping folders,
                // encrypted entries, and anything the extractor declines).
                ISimpleInArchive simple = archive.getSimpleInterface();
                Map<Integer, Metadata> selected = new LinkedHashMap<>();
                int fileEntries = 0;
                int encryptedEntries = 0;

                for (ISimpleInArchiveItem item : simple.getArchiveItems()) {
                    Boolean folder = safeIsFolder(item);
                    if (folder == null || folder) {
                        // Unreadable header (logged) or a directory — nothing to extract.
                        continue;
                    }
                    fileEntries++;

                    Boolean encrypted = safeIsEncrypted(item);
                    if (encrypted == null) {
                        continue;
                    }
                    if (encrypted) {
                        // Per-entry resilience: skip this one but keep reading the rest,
                        // consistent with how unreadable headers are handled. A blanket
                        // EncryptedDocumentException is only surfaced below if EVERY entry
                        // is encrypted (i.e. the archive as a whole is unreadable).
                        encryptedEntries++;
                        logger.log(Level.WARNING, "Skipping encrypted RAR entry: " + safePath(item));
                        continue;
                    }

                    Metadata entryMeta = handleEntryMetadata(item, xhtml);
                    if (entryMeta == null || !extractor.shouldParseEmbedded(entryMeta)) {
                        continue;
                    }
                    selected.put(item.getItemIndex(), entryMeta);
                }

                if (fileEntries > 0 && encryptedEntries == fileEntries) {
                    // Nothing was readable because the whole archive is encrypted.
                    throw new EncryptedDocumentException();
                }

                // Pass 2: extract everything selected in one decompression pass.
                if (!selected.isEmpty()) {
                    int[] indices = toSortedIndices(selected.keySet());
                    ExtractCallback callback = new ExtractCallback(selected, xhtml, extractor, tmp);
                    try {
                        archive.extract(indices, false, callback);
                    } catch (SevenZipException e) {
                        // A checked failure raised while dispatching an extracted entry to
                        // the embedded extractor is wrapped by the callback; unwrap and
                        // rethrow it as its original type so write-limit and I/O semantics
                        // are preserved. Anything else is a genuine archive read error.
                        callback.rethrowPending();
                        throw new TikaException("RarSevenZipParser failed to extract RAR entries", e);
                    }
                    callback.rethrowPending();
                }
            }
        } catch (SevenZipException e) {
            throw new TikaException("RarSevenZipParser failed to read RAR archive", e);
        }

        xhtml.endDocument();
    }

    /**
     * Receives bulk-extracted entry bytes from 7-Zip-JBinding. For each selected
     * index it spools the bytes to a temp file, then hands that file to the
     * embedded extractor as soon as the entry finishes — so only one entry is on
     * disk at a time. Checked exceptions from the embedded extractor cannot cross
     * the {@link IArchiveExtractCallback} signature, so the first one is stashed
     * and re-raised by {@link #rethrowPending()} after extraction unwinds.
     */
    private static final class ExtractCallback implements IArchiveExtractCallback {
        private final Map<Integer, Metadata> selected;
        private final XHTMLContentHandler xhtml;
        private final EmbeddedDocumentExtractor extractor;
        private final TemporaryResources tmp;

        private int currentIndex = -1;
        private File currentFile;
        private OutputStream currentOut;
        private Exception pending;

        ExtractCallback(Map<Integer, Metadata> selected, XHTMLContentHandler xhtml,
                EmbeddedDocumentExtractor extractor, TemporaryResources tmp) {
            this.selected = selected;
            this.xhtml = xhtml;
            this.extractor = extractor;
            this.tmp = tmp;
        }

        @Override
        public ISequentialOutStream getStream(int index, ExtractAskMode extractAskMode) throws SevenZipException {
            if (extractAskMode != ExtractAskMode.EXTRACT || !selected.containsKey(index)) {
                return null;
            }
            try {
                currentFile = tmp.createTemporaryFile();
                currentOut = new BufferedOutputStream(new FileOutputStream(currentFile));
            } catch (IOException e) {
                throw new SevenZipException("Failed to create temp file for RAR entry", e);
            }
            currentIndex = index;
            final OutputStream out = currentOut;
            return new ISequentialOutStream() {
                @Override
                public int write(byte[] data) throws SevenZipException {
                    try {
                        out.write(data);
                    } catch (IOException e) {
                        throw new SevenZipException(e);
                    }
                    return data.length;
                }
            };
        }

        @Override
        public void prepareOperation(ExtractAskMode extractAskMode) {
        }

        @Override
        public void setOperationResult(ExtractOperationResult extractOperationResult) throws SevenZipException {
            if (currentIndex < 0) {
                return;
            }
            int index = currentIndex;
            File file = currentFile;
            Metadata meta = selected.get(index);
            // Reset state before doing anything that can throw, so a failure here
            // never leaves a half-open stream referenced for the next entry.
            currentIndex = -1;
            currentFile = null;
            OutputStream out = currentOut;
            currentOut = null;

            try {
                if (out != null) {
                    out.close();
                }
            } catch (IOException e) {
                logger.log(Level.WARNING, "Failed to close temp stream for RAR entry: " + name(meta), e);
            }

            try {
                if (extractOperationResult != ExtractOperationResult.OK) {
                    logger.log(Level.WARNING,
                            "RAR entry extraction returned " + extractOperationResult + " for " + name(meta));
                    return;
                }
                // Hand a TikaInputStream (mark/reset supported, file-backed) to the
                // embedded extractor — Tika's detectors call mark/reset to sniff bytes
                // and a plain FileInputStream throws IOException: mark/reset not supported.
                try (TikaInputStream entryStream = TikaInputStream.get(file.toPath())) {
                    extractor.parseEmbedded(entryStream, xhtml, meta, true);
                } catch (IOException | SAXException e) {
                    // Cannot cross this callback's signature; stash and stop extraction.
                    // Rethrown in original form by rethrowPending() once extract() unwinds.
                    pending = e;
                    throw new SevenZipException("Embedded parse failed for RAR entry: " + name(meta), e);
                }
            } finally {
                if (file != null) {
                    // Keep peak disk usage to a single entry rather than the whole archive.
                    file.delete();
                }
            }
        }

        @Override
        public void setTotal(long total) {
        }

        @Override
        public void setCompleted(long complete) {
        }

        /** Re-raise the first checked exception captured during dispatch, if any. */
        void rethrowPending() throws IOException, SAXException {
            if (pending instanceof IOException) {
                throw (IOException) pending;
            }
            if (pending instanceof SAXException) {
                throw (SAXException) pending;
            }
        }

        private static String name(Metadata meta) {
            String n = meta == null ? null : meta.get(TikaCoreProperties.RESOURCE_NAME_KEY);
            return n == null ? "<unknown>" : n;
        }
    }

    private static Boolean safeIsFolder(ISimpleInArchiveItem item) {
        try {
            return item.isFolder();
        } catch (SevenZipException e) {
            logger.log(Level.WARNING, "Skipping unreadable RAR entry header", e);
            return null;
        }
    }

    private static Boolean safeIsEncrypted(ISimpleInArchiveItem item) {
        try {
            return item.isEncrypted();
        } catch (SevenZipException e) {
            logger.log(Level.WARNING, "Skipping RAR entry with unreadable encryption flag", e);
            return null;
        }
    }

    private static String safePath(ISimpleInArchiveItem item) {
        try {
            return item.getPath();
        } catch (SevenZipException e) {
            return "<unknown>";
        }
    }

    /**
     * Reads an entry's metadata and emits its XHTML marker. Returns {@code null}
     * (and logs) if the entry header cannot be read, so the caller can skip it
     * without aborting the whole archive.
     *
     * <p>Mirrors {@code PackageParser.handleEntryMetadata}, which is
     * package-protected in upstream Tika and not callable from here.
     */
    private static Metadata handleEntryMetadata(ISimpleInArchiveItem item, XHTMLContentHandler xhtml)
            throws SAXException {
        String name;
        Date createAt;
        Date modifiedAt;
        Long size;
        try {
            name = item.getPath();
            createAt = item.getCreationTime();
            modifiedAt = item.getLastWriteTime();
            size = item.getSize();
        } catch (SevenZipException e) {
            logger.log(Level.WARNING, "Skipping unreadable RAR entry header", e);
            return null;
        }

        Metadata entrydata = new Metadata();
        if (createAt != null) {
            entrydata.set(TikaCoreProperties.CREATED, createAt);
        }
        if (modifiedAt != null) {
            entrydata.set(TikaCoreProperties.MODIFIED, modifiedAt);
        }
        if (size != null) {
            entrydata.set(Metadata.CONTENT_LENGTH, Long.toString(size));
        }
        if (name != null && !name.isEmpty()) {
            name = name.replace('\\', '/');
            entrydata.set(TikaCoreProperties.RESOURCE_NAME_KEY, name);
            AttributesImpl attributes = new AttributesImpl();
            attributes.addAttribute("", "class", "class", "CDATA", "embedded");
            attributes.addAttribute("", "id", "id", "CDATA", name);
            xhtml.startElement("div", attributes);
            xhtml.endElement("div");
            entrydata.set(TikaCoreProperties.EMBEDDED_RELATIONSHIP_ID, name);
        }
        return entrydata;
    }

    private static int[] toSortedIndices(Set<Integer> keys) {
        List<Integer> sorted = new ArrayList<>(keys);
        Collections.sort(sorted);
        int[] indices = new int[sorted.size()];
        for (int i = 0; i < indices.length; i++) {
            indices[i] = sorted.get(i);
        }
        return indices;
    }
}

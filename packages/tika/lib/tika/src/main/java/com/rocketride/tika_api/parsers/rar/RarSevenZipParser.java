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

package com.rocketride.tika_api.parsers.rar;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
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

import net.sf.sevenzipjbinding.ExtractOperationResult;
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
 * auto-detection (handles both RAR4 and RAR5), then iterates entries and
 * routes each to the {@link EmbeddedDocumentExtractor} on the parse context.
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

                ISimpleInArchive simple = archive.getSimpleInterface();
                for (ISimpleInArchiveItem item : simple.getArchiveItems()) {
                    if (Thread.currentThread().isInterrupted()) {
                        break;
                    }
                    extractItem(item, xhtml, extractor, tmp);
                }
            }
        } catch (SevenZipException e) {
            throw new TikaException("RarSevenZipParser failed to read RAR archive", e);
        }

        xhtml.endDocument();
    }

    private static void extractItem(ISimpleInArchiveItem item, XHTMLContentHandler xhtml,
            EmbeddedDocumentExtractor extractor, TemporaryResources tmp)
            throws IOException, SAXException, TikaException {
        String name;
        Date ctime;
        Date mtime;
        Long size;
        boolean folder;
        boolean encrypted;
        try {
            folder = item.isFolder();
            if (folder) {
                return;
            }
            encrypted = item.isEncrypted();
            name = item.getPath();
            ctime = item.getCreationTime();
            mtime = item.getLastWriteTime();
            size = item.getSize();
        } catch (SevenZipException e) {
            // Bad header on this entry — skip it but keep going through the archive.
            logger.log(Level.WARNING, "Skipping unreadable RAR entry header", e);
            return;
        }

        if (encrypted) {
            // Match Tika's behavior for encrypted archives: surface to the caller.
            throw new EncryptedDocumentException();
        }

        Metadata entryMeta = handleEntryMetadata(name, ctime, mtime, size, xhtml);
        if (!extractor.shouldParseEmbedded(entryMeta)) {
            return;
        }

        File entryFile = tmp.createTemporaryFile();
        try (OutputStream fos = new FileOutputStream(entryFile)) {
            ExtractOperationResult result = item.extractSlow(new ISequentialOutStream() {
                @Override
                public int write(byte[] data) throws SevenZipException {
                    try {
                        fos.write(data);
                    } catch (IOException e) {
                        throw new SevenZipException(e);
                    }
                    return data.length;
                }
            });
            if (result != ExtractOperationResult.OK) {
                logger.log(Level.WARNING, "RAR entry extraction returned " + result + " for " + name);
                return;
            }
        } catch (SevenZipException e) {
            logger.log(Level.WARNING, "Failed to extract RAR entry: " + name, e);
            return;
        }

        // Hand a TikaInputStream (mark/reset supported, file-backed) to the
        // embedded extractor — Tika's detectors call mark/reset to sniff bytes
        // and a plain FileInputStream throws IOException: mark/reset not supported.
        try (TikaInputStream entryStream = TikaInputStream.get(entryFile.toPath())) {
            extractor.parseEmbedded(entryStream, xhtml, entryMeta, true);
        }
    }

    /**
     * Mirrors {@code PackageParser.handleEntryMetadata}, which is package/protected
     * in upstream Tika and not callable from here.
     */
    private static Metadata handleEntryMetadata(String name, Date createAt, Date modifiedAt,
            Long size, XHTMLContentHandler xhtml) throws SAXException {
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
}

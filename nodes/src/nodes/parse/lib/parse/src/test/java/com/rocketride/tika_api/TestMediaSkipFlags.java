package com.rocketride.tika_api;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import static org.junit.jupiter.api.Assertions.*;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.StringWriter;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import javax.imageio.ImageIO;

import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDInlineImage;
import org.apache.tika.extractor.EmbeddedDocumentExtractor;
import org.apache.tika.io.TikaInputStream;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.parser.AutoDetectParser;
import org.apache.tika.parser.ParseContext;
import org.apache.tika.parser.Parser;
import org.apache.tika.parser.pdf.PDFParserConfig;
import org.apache.tika.sax.BodyContentHandler;
import org.xml.sax.ContentHandler;

import com.rocketride.tika_api.EmbeddedContentExtractor.EmbeddedContentProcessor;

/**
 * The SKIP_* flags the parse node adds for media lanes without a listener:
 * skipped media is not extracted, and the text is unchanged.
 */
class TestMediaSkipFlags {

    private static final String TEXT = "Inline images must not change this text";
    private static final int IMAGES = 5;

    private static String previousRootPath;

    @BeforeAll
    static void setup() {
        System.setProperty("java.awt.headless", "true");
        previousRootPath = TikaApi.rootPath;
        // ConfigBuilder.getConfig() reads tika-config.xml from TikaApi.rootPath
        TikaApi.rootPath = System.getProperty("user.dir");
    }

    @AfterAll
    static void teardown() {
        TikaApi.rootPath = previousRootPath;
    }

    /** Counts the embedded objects Tika hands over, without parsing them. */
    private static class CountingExtractor implements EmbeddedDocumentExtractor {
        int count;

        @Override
        public boolean shouldParseEmbedded(Metadata metadata) {
            return true;
        }

        @Override
        public void parseEmbedded(InputStream stream, ContentHandler handler, Metadata metadata, boolean outputHtml) {
            count++;
        }
    }

    /**
     * One page of text drawn over IMAGES distinct images: image XObjects, or
     * inline images (BI/ID/EI in the content stream, the kind the slow PDFs
     * hold by the tens of thousands) when inline is set.
     */
    private static byte[] pdfWithImages(boolean inline) throws Exception {
        try (PDDocument doc = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            PDPage page = new PDPage();
            page.setResources(new PDResources());
            doc.addPage(page);
            try (PDPageContentStream content = new PDPageContentStream(doc, page)) {
                for (int i = 0; i < IMAGES; i++) {
                    if (inline) {
                        COSDictionary dict = new COSDictionary();
                        dict.setInt(COSName.W, 2);
                        dict.setInt(COSName.H, 2);
                        dict.setInt(COSName.BPC, 8);
                        dict.setItem(COSName.CS, COSName.RGB);
                        byte[] rgb = new byte[2 * 2 * 3];
                        rgb[0] = (byte) (40 * (i + 1));
                        content.drawImage(new PDInlineImage(dict, rgb, page.getResources()), 72 + i * 20, 600);
                        continue;
                    }
                    BufferedImage image = new BufferedImage(8, 8, BufferedImage.TYPE_INT_RGB);
                    image.setRGB(i, i, 0xffffff);
                    PDImageXObject xobject = LosslessFactory.createFromImage(doc, image);
                    content.drawImage(xobject, 72 + i * 20, 600);
                }
                content.beginText();
                content.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 12);
                content.newLineAtOffset(72, 700);
                content.showText(TEXT);
                content.endText();
            }
            doc.save(out);
            return out.toByteArray();
        }
    }

    private static String parse(byte[] pdf, long flags, CountingExtractor extractor) throws Exception {
        AutoDetectParser parser = new AutoDetectParser(ConfigBuilder.getConfig());
        ParseContext context = new ParseContext();
        context.set(Parser.class, parser);
        context.set(PDFParserConfig.class, TikaApi.getPdfConfig(flags));
        context.set(EmbeddedDocumentExtractor.class, extractor);

        StringWriter writer = new StringWriter();
        Metadata metadata = new Metadata();
        try (TikaInputStream stream = TikaInputStream.get(pdf)) {
            parser.parse(stream, new BodyContentHandler(writer), metadata, context);
        }
        return writer.toString();
    }

    @Test
    void pdfConfigExtractsInlineImagesUnlessSkipped() {
        PDFParserConfig wanted = TikaApi.getPdfConfig(0);
        assertTrue(wanted.isExtractInlineImages());
        assertTrue(wanted.isExtractUniqueInlineImagesOnly());
        assertEquals(PDFParserConfig.OCR_STRATEGY.NO_OCR, wanted.getOcrStrategy());

        PDFParserConfig skipped = TikaApi.getPdfConfig(TikaApi.SKIP_IMAGES);
        assertFalse(skipped.isExtractInlineImages());
        assertEquals(PDFParserConfig.OCR_STRATEGY.NO_OCR, skipped.getOcrStrategy());
        assertEquals(wanted.getMaxMainMemoryBytes(), skipped.getMaxMainMemoryBytes());

        // Only the image bit governs inline images
        assertTrue(TikaApi.getPdfConfig(TikaApi.SKIP_AUDIO | TikaApi.SKIP_VIDEO).isExtractInlineImages());
    }

    @Test
    void wantsMediaFollowsTheSkipBits() {
        assertTrue(TikaApi.wantsMedia(0, "image/png"));
        assertFalse(TikaApi.wantsMedia(TikaApi.SKIP_IMAGES, "image/png"));
        assertTrue(TikaApi.wantsMedia(TikaApi.SKIP_IMAGES, "audio/mpeg"));
        assertFalse(TikaApi.wantsMedia(TikaApi.SKIP_AUDIO, "audio/mpeg"));
        assertFalse(TikaApi.wantsMedia(TikaApi.SKIP_VIDEO, "video/mp4"));
        assertTrue(TikaApi.wantsMedia(TikaApi.SKIP_IMAGES | TikaApi.SKIP_AUDIO | TikaApi.SKIP_VIDEO, "application/pdf"));

        // The entry flags below the skip bits do not skip anything
        long entryFlags = TikaApi.INDEX | TikaApi.CLASSIFY | TikaApi.MAGICK | TikaApi.SIGNING;
        assertTrue(TikaApi.wantsMedia(entryFlags, "image/png"));
    }

    @Test
    void skippedImagesAreNotExtractedAndTextIsUnchanged() throws Exception {
        assertSkipRule(pdfWithImages(false));
    }

    @Test
    void inlineImagesFollowTheSameRule() throws Exception {
        assertSkipRule(pdfWithImages(true));
    }

    private static void assertSkipRule(byte[] pdf) throws Exception {
        CountingExtractor all = new CountingExtractor();
        String withImages = parse(pdf, 0, all);
        assertEquals(IMAGES, all.count, "every distinct image is extracted when the image lane is wanted");

        CountingExtractor none = new CountingExtractor();
        String withoutImages = parse(pdf, TikaApi.SKIP_IMAGES, none);
        assertEquals(0, none.count, "no image is extracted when the image lane is skipped");

        assertTrue(withImages.contains(TEXT));
        assertEquals(withImages, withoutImages);
    }

    /** A 16 x 16 PNG, used as a standalone file or as a document's picture. */
    private static byte[] png() throws Exception {
        BufferedImage image = new BufferedImage(16, 16, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(image, "png", png);
        return png.toByteArray();
    }

    @Test
    void skippedEmbeddedImageIsLeftUnread() throws Exception {
        // A stand-alone image as an embedded object of a document (a DOCX picture, say)
        byte[] bytes = png();
        String docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        // A native handle of 0 is the bridge's test mode (the send is a no-op).
        // Positive control first: wanted, the image is detected, copied in full and
        // sent, so the stream is read to its end. parseEmbedded swallows every
        // exception, so without this a processor that failed before reaching the skip
        // would also leave the stream unread and the check below would pass anyway.
        EmbeddedContentProcessor wanted = new EmbeddedContentProcessor(0, docx, 0);
        ByteArrayInputStream wantedStream = new ByteArrayInputStream(bytes);
        assertDoesNotThrow(() -> wanted.parseEmbedded(wantedStream, new BodyContentHandler(), new Metadata(), false));
        assertEquals(0, wantedStream.available(), "a wanted image is copied in full");

        // Skipped, the processor returns right after detection, which resets the
        // stream to its start
        EmbeddedContentProcessor processor = new EmbeddedContentProcessor(0, docx, TikaApi.SKIP_IMAGES);
        ByteArrayInputStream stream = new ByteArrayInputStream(bytes);
        assertDoesNotThrow(() -> processor.parseEmbedded(stream, new BodyContentHandler(), new Metadata(), false));
        assertEquals(bytes.length, stream.available(), "a skipped image is neither copied nor parsed");
    }

    /**
     * Runs a standalone file through extractInformation, which every document from
     * the engine goes through, and returns what it logged. With a native handle of 0
     * (the bridge's test mode) the log is the only trace of the media path: the copy
     * logs "Buffered stream size", each send "Inside onWrite...".
     */
    private static List<String> standaloneLog(byte[] bytes, long flags, Metadata metadata) throws Exception {
        List<String> messages = new ArrayList<>();
        Handler recorder = new Handler() {
            @Override
            public void publish(LogRecord record) {
                if (record.getMessage() != null)
                    messages.add(record.getMessage());
            }

            @Override
            public void flush() {
            }

            @Override
            public void close() {
            }
        };

        // extractInformation parses with the configuration init() builds. init() also
        // loads native libraries and starts a cleanup thread, so set only that field.
        Field config = TikaApi.class.getDeclaredField("tikaConfig");
        config.setAccessible(true);
        Object previous = config.get(null);
        config.set(null, ConfigBuilder.getConfig());
        // The copy and the sends log at INFO; a process that runs this logger at
        // WARNING would drop them before the recorder sees them, so pin the level
        Logger log = Logger.getLogger("TikaApi");
        Level previousLevel = log.getLevel();
        log.setLevel(Level.ALL);
        log.addHandler(recorder);
        try (TikaInputStream stream = TikaInputStream.get(bytes)) {
            TikaApi.extractInformation(0, stream, "image.png", new StringWriter(), metadata, flags, false);
        } finally {
            log.removeHandler(recorder);
            log.setLevel(previousLevel);
            config.set(null, previous);
        }
        return messages;
    }

    private static long count(List<String> messages, String prefix) {
        return messages.stream().filter(m -> m.startsWith(prefix)).count();
    }

    private static Map<String, List<String>> asMap(Metadata metadata) {
        Map<String, List<String>> map = new TreeMap<>();
        for (String name : metadata.names())
            map.put(name, Arrays.asList(metadata.getValues(name)));
        return map;
    }

    @Test
    void skippedStandaloneImageIsNeitherCopiedNorSent() throws Exception {
        byte[] bytes = png();

        // Positive control: wanted, the file is copied, then sent as BEGIN, one chunk, END
        Metadata wanted = new Metadata();
        List<String> wantedLog = standaloneLog(bytes, 0, wanted);
        assertEquals(1, count(wantedLog, "Buffered stream size"), "a wanted standalone image is copied");
        assertEquals(3, count(wantedLog, "Inside onWrite"), "a wanted standalone image is sent");

        Metadata skipped = new Metadata();
        List<String> skippedLog = standaloneLog(bytes, TikaApi.SKIP_IMAGES, skipped);
        assertEquals(0, count(skippedLog, "Buffered stream size"), "a skipped standalone image is not copied");
        assertEquals(0, count(skippedLog, "Inside onWrite"), "a skipped standalone image is not sent");

        // The metadata parse still runs on the skipped file and finds the same thing
        assertEquals("16", skipped.get("tiff:ImageWidth"));
        assertEquals(asMap(wanted), asMap(skipped));
    }
}

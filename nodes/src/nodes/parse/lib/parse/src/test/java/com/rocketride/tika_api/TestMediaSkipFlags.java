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

    @Test
    void skippedEmbeddedImageIsLeftUnread() throws Exception {
        // A stand-alone image as an embedded object of a document (a DOCX picture, say)
        BufferedImage image = new BufferedImage(16, 16, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(image, "png", png);
        byte[] bytes = png.toByteArray();

        // A native handle of 0 is the bridge's test mode (the send is a no-op). Had the
        // media been wanted, the stream would have been copied in full; skipped, the
        // processor returns right after detection, which resets the stream to its start.
        EmbeddedContentProcessor processor =
                new EmbeddedContentProcessor(0, "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        TikaApi.SKIP_IMAGES);
        ByteArrayInputStream stream = new ByteArrayInputStream(bytes);
        assertDoesNotThrow(() -> processor.parseEmbedded(stream, new BodyContentHandler(), new Metadata(), false));
        assertEquals(bytes.length, stream.available(), "a skipped image is neither copied nor parsed");
    }
}

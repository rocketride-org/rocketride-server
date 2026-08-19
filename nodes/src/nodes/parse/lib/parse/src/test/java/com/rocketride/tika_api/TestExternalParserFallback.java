package com.rocketride.tika_api;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;

import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;

import org.apache.tika.config.TikaConfig;
import org.apache.tika.mime.MediaType;
import org.apache.tika.parser.ParseContext;

/**
 * External-media-parser auto-detect / built-in fallback in ConfigBuilder.
 * Host-independent: tool availability is forced via ConfigBuilder's test seam.
 */
class TestExternalParserFallback {

    private static final String EXTERNAL = "org.apache.tika.parser.external.ExternalParser";
    private static final String COMPOSITE = "org.apache.tika.parser.external.CompositeExternalParser";
    private static final String DEFAULT_PARSER_CONFIG =
            "<properties><parsers>"
            + "<parser class=\"org.apache.tika.parser.DefaultParser\"/>"
            + "</parsers></properties>";

    private static String previousRootPath;

    @BeforeAll
    static void setup() {
        previousRootPath = TikaApi.rootPath;
        // ConfigBuilder.getConfig() reads tika-config.xml from TikaApi.rootPath
        TikaApi.rootPath = System.getProperty("user.dir");
    }

    @AfterAll
    static void teardown() {
        TikaApi.rootPath = previousRootPath;
    }

    @AfterEach
    void clearOverride() {
        ConfigBuilder.toolsAvailableOverrideForTest = null;
    }

    private static Document parseXml(String xml) throws Exception {
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setNamespaceAware(true);
        return dbf.newDocumentBuilder()
                .parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
    }

    /** isParserExcluded() detects an explicit exclusion and ignores non-excluded parsers. */
    @Test
    void testIsParserExcludedDetectsExclusion() throws Exception {
        String xml = "<properties><parsers>"
                + "<parser class=\"org.apache.tika.parser.DefaultParser\">"
                + "<parser-exclude class=\"" + EXTERNAL + "\"/>"
                + "</parser></parsers></properties>";
        Document doc = parseXml(xml);
        assertTrue(ConfigBuilder.isParserExcluded(doc, EXTERNAL));
        assertFalse(ConfigBuilder.isParserExcluded(doc, COMPOSITE));
    }

    /** isParserExcluded() returns false when there is no DefaultParser entry. */
    @Test
    void testIsParserExcludedNoDefaultParser() throws Exception {
        Document doc = parseXml("<properties><parsers></parsers></properties>");
        assertFalse(ConfigBuilder.isParserExcluded(doc, EXTERNAL));
    }

    /** Tools missing -> the external parsers are excluded (fallback branch). */
    @Test
    void testExternalParsersExcludedWhenToolsMissing() throws Exception {
        ConfigBuilder.toolsAvailableOverrideForTest = false;
        Document doc = parseXml(DEFAULT_PARSER_CONFIG);
        ConfigBuilder.excludeExternalParserIfUnavailable(doc, COMPOSITE);
        ConfigBuilder.excludeExternalParserIfUnavailable(doc, EXTERNAL);
        assertTrue(ConfigBuilder.isParserExcluded(doc, COMPOSITE), "CompositeExternalParser must be excluded");
        assertTrue(ConfigBuilder.isParserExcluded(doc, EXTERNAL), "ExternalParser must be excluded");
    }

    /** Tools present -> the external parsers are kept (external branch). */
    @Test
    void testExternalParsersKeptWhenToolsPresent() throws Exception {
        ConfigBuilder.toolsAvailableOverrideForTest = true;
        Document doc = parseXml(DEFAULT_PARSER_CONFIG);
        ConfigBuilder.excludeExternalParserIfUnavailable(doc, COMPOSITE);
        ConfigBuilder.excludeExternalParserIfUnavailable(doc, EXTERNAL);
        assertFalse(ConfigBuilder.isParserExcluded(doc, COMPOSITE), "CompositeExternalParser must be kept");
        assertFalse(ConfigBuilder.isParserExcluded(doc, EXTERNAL), "ExternalParser must be kept");
    }

    /** getConfig() never throws and always resolves a video/mp4 parser (external or built-in). */
    @Test
    void testGetConfigAlwaysResolvesVideoParser() throws Exception {
        TikaConfig config = assertDoesNotThrow(ConfigBuilder::getConfig);
        assertNotNull(config.getParser());
        Set<MediaType> types = config.getParser().getSupportedTypes(new ParseContext());
        assertTrue(types.contains(MediaType.video("mp4")),
                "video/mp4 must be handled by some parser (external or built-in Mp4Parser)");
    }
}

import com.rocketride.tika_api.*;
import org.junit.jupiter.api.Test;
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
 * Host-independent (asserts invariants, not which tools are installed).
 */
class TestExternalParserFallback {

    @BeforeAll
    static void setup() {
        // ConfigBuilder.getConfig() reads tika-config.xml from TikaApi.rootPath
        TikaApi.rootPath = System.getProperty("user.dir");
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
                + "<parser-exclude class=\"org.apache.tika.parser.external.ExternalParser\"/>"
                + "</parser></parsers></properties>";
        Document doc = parseXml(xml);

        assertTrue(ConfigBuilder.isParserExcluded(doc, "org.apache.tika.parser.external.ExternalParser"),
                "explicitly excluded parser should be detected");
        assertFalse(ConfigBuilder.isParserExcluded(doc, "org.apache.tika.parser.external.CompositeExternalParser"),
                "a parser that is not excluded should not be reported as excluded");
    }

    /** isParserExcluded() returns false when there is no DefaultParser entry. */
    @Test
    void testIsParserExcludedNoDefaultParser() throws Exception {
        Document doc = parseXml("<properties><parsers></parsers></properties>");
        assertFalse(ConfigBuilder.isParserExcluded(doc, "org.apache.tika.parser.external.ExternalParser"));
    }

    /** getConfig() never throws and always resolves a video/mp4 parser (external or built-in). */
    @Test
    void testGetConfigAlwaysResolvesVideoParser() throws Exception {
        TikaConfig config = assertDoesNotThrow(ConfigBuilder::getConfig,
                "getConfig() must not throw regardless of installed external tools");
        assertNotNull(config, "TikaConfig should not be null");
        assertNotNull(config.getParser(), "Parser should not be null");

        Set<MediaType> types = config.getParser().getSupportedTypes(new ParseContext());
        assertTrue(types.contains(MediaType.video("mp4")),
                "video/mp4 must be handled by some parser (external tool or built-in Mp4Parser)");
    }

    /** getConfig() always resolves an audio/mpeg parser (external or built-in). */
    @Test
    void testGetConfigAlwaysResolvesAudioParser() throws Exception {
        TikaConfig config = ConfigBuilder.getConfig();
        Set<MediaType> types = config.getParser().getSupportedTypes(new ParseContext());
        assertTrue(types.contains(MediaType.audio("mpeg")),
                "audio/mpeg must be handled by some parser (external tool or built-in Mp3Parser)");
    }
}

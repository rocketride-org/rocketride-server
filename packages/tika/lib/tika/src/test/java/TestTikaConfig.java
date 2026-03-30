import com.rocketride.tika_api.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

import org.apache.tika.config.TikaConfig;
import org.apache.tika.parser.CompositeParser;
import org.apache.tika.parser.Parser;

class TestTikaConfig {
    @Test
    void testConfigLoading() throws Exception {
        // Initialize TikaApi to set rootPath
        TikaApi.rootPath = System.getProperty("user.dir");
        
        // Test that we can load the Tika configuration
        TikaConfig config = ConfigBuilder.getConfig();
        assertNotNull(config, "TikaConfig should not be null");
        assertNotNull(config.getParser(), "Parser should not be null");
        assertNotNull(config.getDetector(), "Detector should not be null");
    }

    @Test
    void testCompositeExternalParserExcluded() throws Exception {
        TikaApi.rootPath = System.getProperty("user.dir");

        TikaConfig config = ConfigBuilder.getConfig();
        Parser configuredParser = config.getParser();

        assertTrue(configuredParser instanceof CompositeParser,
                "Configured parser should expose component parsers");

        CompositeParser compositeParser = (CompositeParser) configuredParser;
        boolean hasExternalComposite = compositeParser.getAllComponentParsers().stream()
                .map(Parser::getClass)
                .map(Class::getName)
                .anyMatch("org.apache.tika.parser.external.CompositeExternalParser"::equals);

        assertFalse(hasExternalComposite,
                "ConfigBuilder should exclude CompositeExternalParser to avoid probing optional external tools");
    }
}

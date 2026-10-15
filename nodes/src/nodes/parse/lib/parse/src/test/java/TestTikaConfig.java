import com.rocketride.tika_api.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

import org.apache.tika.config.TikaConfig;

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
}

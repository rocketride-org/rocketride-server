import com.rocketride.tika_api.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeAll;
import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.ArrayList;

import org.apache.tika.metadata.Metadata;
import org.apache.tika.metadata.TikaCoreProperties;
import org.apache.tika.io.TikaInputStream;
import org.apache.tika.config.TikaConfig;

/**
 * Tests for Tika 3.x specific features and behavior
 */
class TestTika3Features {
    
    @BeforeAll
    static void setup() throws Exception {
        // Initialize TikaApi
        TikaApi.rootPath = System.getProperty("user.dir");
    }

    @Test
    void testTikaCorePropertiesAvailable() {
        // Verify that Tika 3.x core properties are accessible
        assertNotNull(TikaCoreProperties.CREATED);
        assertNotNull(TikaCoreProperties.CREATOR);
        assertNotNull(TikaCoreProperties.MODIFIED);
        assertNotNull(TikaCoreProperties.MODIFIER);
        assertNotNull(TikaCoreProperties.TITLE);
    }

    @Test
    void testMetadataPropertyMapping() {
        // Test that metadata properties are properly mapped in Tika 3.x
        Metadata metadata = new Metadata();
        
        // Set properties using Tika 3.x API
        metadata.set(TikaCoreProperties.TITLE, "Test Document");
        metadata.set(TikaCoreProperties.CREATOR, "Test Author");
        metadata.set(TikaCoreProperties.CREATED, "2023-01-01T00:00:00Z");
        
        // Verify properties are accessible
        assertEquals("Test Document", metadata.get(TikaCoreProperties.TITLE));
        assertEquals("Test Author", metadata.get(TikaCoreProperties.CREATOR));
        assertEquals("2023-01-01T00:00:00Z", metadata.get(TikaCoreProperties.CREATED));
    }

    @Test
    void testMetadataSerializationWithTika3Properties() {
        // Test that Tika 3.x properties are properly serialized
        Metadata metadata = new Metadata();
        metadata.set(TikaCoreProperties.TITLE, "Test Title");
        metadata.set(TikaCoreProperties.CREATOR, "Test Creator");
        metadata.set(TikaCoreProperties.SUBJECT, "Test Subject");
        
        ArrayList<String> names = new ArrayList<String>();
        ArrayList<String> values = new ArrayList<String>();
        MetadataSerializer.serializeMetadata(metadata, names, values);
        
        // Verify all properties are serialized
        assertTrue(names.size() >= 3, "Should have at least 3 properties");
        assertTrue(values.contains("Test Title"), "Should contain title value");
        assertTrue(values.contains("Test Creator"), "Should contain creator value");
        assertTrue(values.contains("Test Subject"), "Should contain subject value");
    }

    @Test
    void testConfigBuilderWithTika3() throws Exception {
        // Test that ConfigBuilder works with Tika 3.x
        TikaConfig config = ConfigBuilder.getConfig();
        
        assertNotNull(config, "Config should not be null");
        assertNotNull(config.getParser(), "Parser should not be null");
        assertNotNull(config.getDetector(), "Detector should not be null");
        assertNotNull(config.getMimeRepository(), "MimeRepository should not be null");
    }

    @Test
    void testTikaInputStreamCreation() throws Exception {
        // Test that TikaInputStream works correctly in Tika 3.x
        byte[] testData = "Test content".getBytes();
        InputStream inputStream = new ByteArrayInputStream(testData);
        
        TikaInputStream tikaStream = TikaInputStream.get(inputStream);
        assertNotNull(tikaStream, "TikaInputStream should not be null");
        
        // Verify we can read from the stream
        byte[] buffer = new byte[testData.length];
        int bytesRead = tikaStream.read(buffer);
        assertEquals(testData.length, bytesRead, "Should read all bytes");
        assertArrayEquals(testData, buffer, "Content should match");
        
        tikaStream.close();
    }

    @Test
    void testBackwardCompatibilityMetadataNames() {
        // Test that old metadata property names still work
        Metadata metadata = new Metadata();
        
        // Set using old-style property names
        metadata.set("dc:title", "Old Style Title");
        metadata.set("dc:creator", "Old Style Creator");
        
        ArrayList<String> names = new ArrayList<String>();
        ArrayList<String> values = new ArrayList<String>();
        MetadataSerializer.serializeMetadata(metadata, names, values);
        
        // Verify properties are still accessible
        assertTrue(names.size() >= 2, "Should have at least 2 properties");
        assertTrue(values.contains("Old Style Title") || values.contains("Old Style Creator"), 
                   "Should contain old-style property values");
    }

    @Test
    void testEncryptedDocumentDetection() {
        // Test that encrypted document detection works in Tika 3.x
        Metadata metadata = new Metadata();
        
        // Initially not encrypted
        assertFalse(MetadataSerializer.getIsEncrypted(metadata));
        
        // Set encrypted flag
        MetadataSerializer.setIsEncrypted(metadata, true);
        assertTrue(MetadataSerializer.getIsEncrypted(metadata));
        
        // Verify it's serialized correctly
        ArrayList<String> names = new ArrayList<String>();
        ArrayList<String> values = new ArrayList<String>();
        MetadataSerializer.serializeMetadata(metadata, names, values);
        
        int encryptedIndex = names.indexOf(MetadataSerializer.ROCKETRIDE_IS_ENCRYPTED);
        assertTrue(encryptedIndex >= 0, "Should contain encrypted property");
        assertEquals("true", values.get(encryptedIndex), "Encrypted value should be true");
    }

    @Test
    void testUtilNonPrintableCharacterHandling() {
        // Test that Util class properly handles non-printable characters in Tika 3.x
        String testString = "Hello\u0000World\uFEFF!";
        
        assertTrue(Util.hasNonPrintableCharacter(testString), 
                   "Should detect non-printable characters");
        
        String cleaned = Util.stripNonPrintableCharacters(testString);
        assertFalse(Util.hasNonPrintableCharacter(cleaned), 
                    "Cleaned string should not have non-printable characters");
        assertEquals("HelloWorld!", cleaned, "Should remove non-printable characters");
    }
}

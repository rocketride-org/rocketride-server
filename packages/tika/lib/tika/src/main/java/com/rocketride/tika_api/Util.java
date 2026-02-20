package com.rocketride.tika_api;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

import org.apache.commons.io.IOUtils;
import org.apache.commons.lang3.StringUtils;
import org.apache.tika.metadata.Metadata;

public final class Util {
    // Prevent construction of instances of this class
    private Util() {
        throw new AssertionError("Cannot instantiate utility class");
    }

    /**
     * Strips non-printable characters from the string
     * See https://docs.oracle.com/javase/7/docs/api/java/lang/Character.html#isIdentifierIgnorable(char)
     * See https://www.compart.com/en/unicode/category/Cf
     */
    public static String stripNonPrintableCharacters(String str) {
        if (StringUtils.isEmpty(str))
            return str;

        // Find the first non-printable (i.e. ignorable) character
        int indexOfFirstNonPrintableCharacter = -1;
        for (int i = 0; i < str.length(); i++) {
            if (Character.isIdentifierIgnorable(str.charAt(i))) {
                indexOfFirstNonPrintableCharacter = i;
                break;
            }
        }

        // Didn't find any non-printable character; return string
        if (indexOfFirstNonPrintableCharacter < 0)
            return str;

        // Convert the string to a character array
        char[] chars = str.toCharArray();

        // Starting at the character following the first non-printable character, move all printable characters forward
        int pos = indexOfFirstNonPrintableCharacter;
        for (int i = indexOfFirstNonPrintableCharacter + 1; i < chars.length; i++) {
            if (!Character.isIdentifierIgnorable(chars[i]))
                chars[pos++] = chars[i];
        }

        // Truncate the character array at the last printable character and convert it back to a string
        return new String(chars, 0, pos);
    }

    /**
     * Ensures the string contains valid UTF-8 by replacing surrogate pairs
     * with Unicode replacement characters.
     * 
     * Surrogate pairs (U+D800 to U+DFFF) are used in UTF-16 encoding but are
     * invalid in UTF-8. This can occur when email parsers decode malformed
     * RFC 2047 headers containing emojis or special characters.
     * 
     * @param str the string to validate
     * @return a string with all surrogates replaced by U+FFFD (replacement character)
     */
    public static String ensureValidUtf8(String str) {
        if (StringUtils.isEmpty(str))
            return str;

        // Check if string contains surrogates
        boolean hasSurrogates = false;
        for (int i = 0; i < str.length(); i++) {
            if (Character.isSurrogate(str.charAt(i))) {
                hasSurrogates = true;
                break;
            }
        }

        // If no surrogates, return original string
        if (!hasSurrogates)
            return str;

        // Replace surrogates with Unicode replacement character
        StringBuilder cleaned = new StringBuilder(str.length());
        for (int i = 0; i < str.length(); i++) {
            char c = str.charAt(i);
            if (Character.isSurrogate(c)) {
                // Replace with Unicode replacement character
                cleaned.append('\uFFFD');
            } else {
                cleaned.append(c);
            }
        }

        return cleaned.toString();
    }

    /**
     * Sanitizes a string by ensuring valid UTF-8 encoding and removing non-printable characters.
     * This is a convenience method that combines ensureValidUtf8() and stripNonPrintableCharacters().
     * 
     * @param str the string to sanitize
     * @return a sanitized string safe for UTF-8 encoding
     */
    public static String sanitizeString(String str) {
        if (StringUtils.isEmpty(str))
            return str;
        
        // First ensure valid UTF-8 (replace surrogates)
        str = ensureValidUtf8(str);
        
        // Then strip non-printable characters
        return stripNonPrintableCharacters(str);
    }

    public static boolean hasNonPrintableCharacter(String str) {
        for (int i = 0; i < str.length(); i++) {
            if (Character.isIdentifierIgnorable(str.charAt(i)))
                return true;
        }
        return false;
    }

    public static void filterNonPrintableCharacters(char text[], int offset, int length) {
        // Replace all non-printable (i.e. ignorable) characters with spaces
        for (int i = offset; i < offset + length; i++) {
            if (Character.isIdentifierIgnorable(text[i]))
                text[i] = ' ';
        }
    }

    public static String sendMetadata(Metadata metadata) {
        StringBuilder sb = new StringBuilder();
        for (String name : metadata.names()) {
            if (sb.length() > 0)
                sb.append("\n");

            sb.append(name);
            sb.append("=");

            StringBuilder vb = new StringBuilder();
            for (String value : metadata.getValues(name)) {
                if (vb.length() > 0)
                    vb.append("; ");
                vb.append(value);
            }
            sb.append(vb.toString());
        }
        return sb.toString();            
    }

    /**
     * A utility wrapper to safely buffer and reuse an InputStream for both parsing and binary processing.
     */
    public static class StreamDuplicator {

        private final byte[] bufferedData;

        public StreamDuplicator(InputStream original) throws IOException {
            this.bufferedData = IOUtils.toByteArray(original);
        }

        public InputStream getParserStream() {
            return new ByteArrayInputStream(bufferedData);
        }

        public InputStream getBinaryStream() {
            return new ByteArrayInputStream(bufferedData);
        }

        public int size() {
            return bufferedData.length;
        }
    }
}

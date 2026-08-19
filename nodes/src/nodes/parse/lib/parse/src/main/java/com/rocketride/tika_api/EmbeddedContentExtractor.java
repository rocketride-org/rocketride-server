package com.rocketride.tika_api;

import java.util.Arrays;
import java.util.logging.Level;
import java.util.logging.Logger;


import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import org.xml.sax.SAXException;

import com.rocketride.NativeError;

import org.xml.sax.ContentHandler;
import org.xml.sax.helpers.DefaultHandler;
import org.apache.tika.parser.Parser;
import org.apache.tika.mime.MediaType;
import org.apache.tika.detect.Detector;
import org.apache.tika.config.TikaConfig;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.parser.ParseContext;
import org.apache.tika.exception.TikaException;
import org.apache.tika.parser.AutoDetectParser;
import org.apache.tika.parser.pdf.PDFParserConfig;
import org.apache.tika.extractor.EmbeddedDocumentExtractor;

import javax.xml.parsers.ParserConfigurationException;

import static com.rocketride.tika_api.TikaApi.MIME_TYPE_IMAGE;
import static com.rocketride.tika_api.TikaApi.MIME_TYPE_AUDIO;
import static com.rocketride.tika_api.TikaApi.MIME_TYPE_VIDEO;

public class EmbeddedContentExtractor {
    private static final int AVI_ACTION_BEGIN = 0;
    private static final int AVI_ACTION_WRITE = 1;
    private static final int AVI_ACTION_END = 2;

    // private static String contentType; // For debugging only

    private static Logger logger = Logger.getLogger("TikaApi");

    /**
     * Custom embedded document extractor that extracts embedded
     * images/texts/excel-macros/objects from different types of documents
     */
    public static class EmbeddedContentProcessor implements EmbeddedDocumentExtractor {
        private final long nativeHandle;
        private final String mimeType;     
        private static TikaConfig tikaConfig;
        
        public EmbeddedContentProcessor(long nativeHandle, String mimeType) {
            this.nativeHandle = nativeHandle;
            this.mimeType = mimeType;
        }

        public void processEmbeddedMediaStream(InputStream stream, String mimeType) throws IOException {
            processEmbeddedMediaStream(stream, mimeType, null);
        }

        public void processEmbeddedMediaStream(InputStream stream, String mimeType, byte[] beginPayload)
                throws IOException {
            try {
                // Determine which native callback to invoke
                // Based on MIME type, choose the corresponding function.
                // If mimeType = image then, call onWriteImageBuffer(long nativeHandle, int action, String mimeType, byte[] buffer)
                // If mimeType = audio then, call onWriteAudioBuffer(long nativeHandle, int action, String mimeType, byte[] buffer)
                // If mimeType = video then, call onWriteVideoBuffer(long nativeHandle, int action, String mimeType, byte[] buffer)

                // Define a local lambda for clarity (optional)
                MediaSender sender;
                if (mimeType.startsWith(MIME_TYPE_IMAGE)) {
                    sender = TikaApi::onWriteImageBuffer;
                } else if (mimeType.startsWith(MIME_TYPE_AUDIO)) {
                    sender = TikaApi::onWriteAudioBuffer;
                } else if (mimeType.startsWith(MIME_TYPE_VIDEO)) {
                    sender = TikaApi::onWriteVideoBuffer;
                } else {
                    // For unknown type, you might decide to do nothing or throw an error.
                    throw new IOException("Unsupported media type: " + mimeType);
                }

                logger.log(Level.INFO, "Sending AVI_ACTION_BEGIN for mimeType: " + mimeType);

                // Signal the beginning of the media stream. The BEGIN buffer carries the
                // stream-descriptor enrichment JSON (origin/source_mime/media detail); the
                // native Binder merges it into the descriptor. Empty when we have nothing.
                sender.send(nativeHandle, AVI_ACTION_BEGIN, mimeType,
                        beginPayload != null ? beginPayload : new byte[0]);

                // Define the chunk size as 1MB.
                final int CHUNK_SIZE = 1024 * 1024;
                byte[] buffer = new byte[CHUNK_SIZE];
                int bytesRead;

                // Read and send the stream data in 1MB chunks.
                while ((bytesRead = stream.read(buffer)) != -1) {
                    byte[] chunk = (bytesRead == CHUNK_SIZE) ? buffer : Arrays.copyOf(buffer, bytesRead);
                    logger.log(Level.INFO, "Sending AVI_ACTION_WRITE for mimeType: " + mimeType);
                    sender.send(nativeHandle, AVI_ACTION_WRITE, mimeType, chunk);
                    logger.log(Level.INFO, "Finish sending a chunk for mimeType: " + mimeType);
                }

                logger.log(Level.INFO, "Sending AVI_ACTION_END for mimeType: " + mimeType);
                
                // Signal the end of the media stream.
                sender.send(nativeHandle, AVI_ACTION_END, mimeType, new byte[0]);

            } catch (Exception e) {
                throw new IOException("Native error while processing media stream", e);
            }
        }

        @FunctionalInterface
        private interface MediaSender {
            void send(long nativeHandle, int action, String mimeType, byte[] buffer) throws NativeError;
        }

        /**
        * Processes the provided InputStream using Apache Tika to extract content.
        *
        * @param stream      The InputStream to process.
        * @param handler     The ContentHandler to handle the extracted content.
        * @param metadata    The Metadata object to hold metadata information.
        * @param outputHtml  Specifies whether to output the content as HTML.
        * @throws SAXException If a parsing error occurs.
        * @throws IOException  If an I/O error occurs.
        */
        private void processStream(InputStream stream, ContentHandler handler, Metadata metadata,
                boolean outputHtml) throws SAXException, IOException, ParserConfigurationException {
            try {
                tikaConfig = ConfigBuilder.getConfig();
                AutoDetectParser parser = new AutoDetectParser(tikaConfig);
                Detector detector = parser.getDetector();
                MediaType mediaType = detector.detect(stream, metadata);
                String currentMimeType = mediaType.toString();

                StructureContentHandler filter = new StructureContentHandler(handler, metadata);
                ParseContext context = new ParseContext();
                context.set(Parser.class, parser);
                context.set(PDFParserConfig.class, TikaApi.getPdfConfig());

                // if embedded doc exist, then process it
                EmbeddedContentProcessor extractor = new EmbeddedContentProcessor(this.nativeHandle, currentMimeType);
                context.set(EmbeddedDocumentExtractor.class, extractor);
                parser.parse(stream, filter, metadata, context);

            } catch (TikaException | ParserConfigurationException | SAXException | IOException e) {
                logger.log(Level.WARNING,"Exception caught in processStream() during embedded content extraction");
                e.printStackTrace();
            }
        }

        @Override
        public boolean shouldParseEmbedded(Metadata metadata) {
            // Process all types of embedded object
            return true;
        }

        /**
         * Processes the embedded objects on the parent input Tika Stream 
         * It may contain Images/Audios/videos/Texts/Excel-Macros/emls/URLs etc. 
         */
        @Override
        public void parseEmbedded(InputStream stream, ContentHandler handler, Metadata metadata,
                boolean outputHtml) throws SAXException, IOException {
            try {
                tikaConfig = ConfigBuilder.getConfig();
                AutoDetectParser parser = new AutoDetectParser(tikaConfig);
                Detector detector = parser.getDetector();
			    MediaType mediaType = detector.detect(stream, metadata);
                String mimeType = mediaType.toString();

                // Determine the type of embedded resource based on the MIME type.
                if (mimeType.startsWith(MIME_TYPE_IMAGE) || mimeType.startsWith(MIME_TYPE_AUDIO)
                        || mimeType.startsWith(MIME_TYPE_VIDEO)) {
                    // The container hands us only bytes, so parse the embedded media
                    // ourselves (via a duplicate) for its own detail; best-effort.
                    Util.StreamDuplicator dup = new Util.StreamDuplicator(stream);
                    try {
                        AutoDetectParser mediaParser = new AutoDetectParser(tikaConfig);
                        mediaParser.parse(dup.getParserStream(), new DefaultHandler(), metadata, new ParseContext());
                    } catch (Exception e) {
                        logger.log(Level.WARNING,
                                "Embedded media metadata parse failed (continuing to stream): " + e.getMessage());
                    }

                    // Extracted from a document: sourceMime is this embedded stream's own
                    // detected type (mimeType); container is the document (this.mimeType).
                    byte[] payload = buildMediaDescriptorPayload(metadata, "extracted", mimeType, this.mimeType);
                    processEmbeddedMediaStream(dup.getBinaryStream(), mimeType, payload);
                } else {
                    // For any other file type, either delegate to standard processing:
                    processStream(stream, handler, metadata, outputHtml);
                }
            } catch (Exception e) {
                logger.log(Level.WARNING,"generic exception caught during execution of parseEmbedded() callback");
                e.printStackTrace();
            }
        }
    }

    // Builds the JSON carried on the media BEGIN buffer; the native builder merges
    // it into the stream descriptor. origin/source_mime/container_mime come from the
    // call context; media detail is best-effort from the Tika metadata (fps only with
    // the external ffmpeg parser). Absent fields are omitted.
    public static byte[] buildMediaDescriptorPayload(Metadata metadata, String origin,
            String sourceMime, String containerMime) {
        StringBuilder sb = new StringBuilder(256);
        boolean[] first = { true };
        sb.append('{');
        appendString(sb, first, "origin", origin);
        appendString(sb, first, "source_mime", sourceMime);
        appendString(sb, first, "container_mime", containerMime);
        if (metadata != null) {
            // The media file's own name (inner name for extracted media, e.g. the
            // file inside a zip; parent stays the container).
            appendString(sb, first, "resource_name", metadataFirst(metadata, "resourceName", "embeddedRelationshipId"));
            // Media detail from the Tika media parser. Keys confirmed against real
            // files; fps has no Tika key from the built-in parser (only the external
            // ffmpeg parser emits it), so its candidates yield nothing on those hosts.
            appendNumber(sb, first, "duration", metadataFirst(metadata, "xmpDM:duration"));
            appendNumber(sb, first, "fps", metadataFirst(metadata, "xmpDM:videoFrameRate", "framerate"));
            appendNumber(sb, first, "width", metadataFirst(metadata, "tiff:ImageWidth", "width"));
            appendNumber(sb, first, "height", metadataFirst(metadata, "tiff:ImageLength", "height"));
            appendNumber(sb, first, "sample_rate", metadataFirst(metadata, "xmpDM:audioSampleRate", "samplerate"));
            appendString(sb, first, "channels", metadataFirst(metadata, "xmpDM:audioChannelType", "channels"));
            appendString(sb, first, "format", metadataFirst(metadata, "xmpDM:audioCompressor"));
        }
        sb.append('}');
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** First non-empty value among the candidate Tika keys, or null. */
    private static String metadataFirst(Metadata metadata, String... keys) {
        for (String k : keys) {
            String v = metadata.get(k);
            if (v != null && !v.isEmpty())
                return v;
        }
        return null;
    }

    private static void appendString(StringBuilder sb, boolean[] first, String key, String value) {
        if (value == null || value.isEmpty())
            return;
        comma(sb, first);
        sb.append('"').append(key).append("\":\"").append(escape(value)).append('"');
    }

    /** Emit as a JSON number when parseable (integers without a trailing .0), else a string. */
    private static void appendNumber(StringBuilder sb, boolean[] first, String key, String value) {
        if (value == null || value.isEmpty())
            return;
        try {
            double d = Double.parseDouble(value.trim());
            // 0/negative means "unknown" for media detail (e.g. an embedded mp4 whose
            // duration Tika reports as 0.0) — omit rather than emit a misleading 0.
            if (d <= 0)
                return;
            comma(sb, first);
            sb.append('"').append(key).append("\":");
            if (d == Math.rint(d) && !Double.isInfinite(d))
                sb.append(Long.toString((long) d));
            else
                sb.append(Double.toString(d));
        } catch (NumberFormatException e) {
            appendString(sb, first, key, value);
        }
    }

    private static void comma(StringBuilder sb, boolean[] first) {
        if (first[0])
            first[0] = false;
        else
            sb.append(',');
    }

    private static String escape(String s) {
        StringBuilder o = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': o.append("\\\""); break;
                case '\\': o.append("\\\\"); break;
                case '\n': o.append("\\n"); break;
                case '\r': o.append("\\r"); break;
                case '\t': o.append("\\t"); break;
                default:
                    if (c < 0x20)
                        o.append(String.format("\\u%04x", (int) c));
                    else
                        o.append(c);
            }
        }
        return o.toString();
    }
}

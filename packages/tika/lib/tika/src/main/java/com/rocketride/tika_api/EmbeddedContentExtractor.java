package com.rocketride.tika_api;

import java.util.Arrays;
import java.util.logging.Level;
import java.util.logging.Logger;


import java.io.IOException;
import java.io.InputStream;

import org.xml.sax.SAXException;

import com.rocketride.NativeError;

import org.xml.sax.ContentHandler;
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

                // Signal the beginning of the media stream.
                sender.send(nativeHandle, AVI_ACTION_BEGIN, mimeType, new byte[0]);

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
                if (mimeType.startsWith(MIME_TYPE_IMAGE)) {
                    // Process as an embedded image stream.
                    processEmbeddedMediaStream(stream, mimeType); // calls TikaApi.onWriteImageBuffer with appropriate AVI actions.
                } else if (mimeType.startsWith(MIME_TYPE_AUDIO)) {
                    // Process as an embedded audio stream.
                    processEmbeddedMediaStream(stream, mimeType); // calls TikaApi.onWriteAudioBuffer with appropriate AVI actions.
                } else if (mimeType.startsWith(MIME_TYPE_VIDEO)) {
                    // Process as an embedded video stream.
                    processEmbeddedMediaStream(stream, mimeType); // calls TikaApi.onWriteVideoBuffer with appropriate AVI actions.
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
}

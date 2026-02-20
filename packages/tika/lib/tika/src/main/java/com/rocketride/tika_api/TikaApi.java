/**
 * Run the maven custom command "clean compile assembly:single" to 
 * build a single jar with all dependencies
 */

package com.rocketride.tika_api;

import com.rocketride.*;

import java.io.InputStream;
import java.io.IOException;
import java.io.Writer;
import java.io.PrintWriter;
import java.lang.Runtime;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.ArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ScheduledExecutorService;

import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.logging.ConsoleHandler;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

import org.apache.tika.parser.Parser;
import org.apache.tika.mime.MediaType;
import org.apache.tika.detect.Detector;
import org.apache.tika.config.TikaConfig;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.io.TikaInputStream;
import org.apache.tika.parser.ParseContext;
import org.apache.tika.sax.BodyContentHandler;
import org.apache.tika.parser.AutoDetectParser;
import org.apache.tika.parser.pdf.PDFParserConfig;
import org.apache.tika.extractor.EmbeddedDocumentExtractor;

import com.rocketride.tika_api.parsers.email.CustomRFC822Parser;
import com.rocketride.tika_api.EmbeddedContentExtractor.EmbeddedContentProcessor;

public final class TikaApi {
	/**
	 * These are set by the engine to config
	 */
	public static boolean enableMarkup = false;
	public static String rootPath = ".";

	/**
	 * Public flags passed from the engine
	 */
	public static final int INDEX = 1 << 0; // Index the file
	public static final int CLASSIFY = 1 << 1; // Classify the file
	public static final int MAGICK = 1 << 3; // Use MagicK image enhancement
	public static final int SIGNING = 1 << 6; // Sign the file


	/**
	 * Common MIME type string constants used throughout TikaApi.
	 */
	public static final String MIME_TYPE_PDF = "application/pdf";
	public static final String MIME_TYPE_EXCEL = "application/vnd.ms-excel";
	public static final String MIME_TYPE_EXCEL_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml";
	public static final String MIME_TYPE_IMAGE = "image/";
	public static final String MIME_TYPE_AUDIO = "audio/";
	public static final String MIME_TYPE_VIDEO = "video/";
	public static final String MIME_TYPE_EMAIL = "message/rfc822";


	/**
	 * <not supported>
	 * To be clear, these are not supported yet but we want to define the flags so
	 * they are not taken
	 * 
	 * Note: If we are going to use Image Magick, we must add
	 * <param name="imageMagickPath" type="string">./magick</param> to the
	 * tika-config.xml parser section and copy magick over to the distribution
	 */
	public static final int IMGREC = 1 << 4; // Use Object recognition within an image
	public static final int AUDTTS = 1 << 5; // Use text to speech on audio/video formats
	// </not supported>

	/**
	 * Whether the optional Aspose PDF/Excel parsers are available on the classpath.
	 * When true, PDF and Excel files are routed to the Aspose-based parsers for
	 * advanced extraction (tables, formulas, macros, images).  When false, Tika's
	 * built-in default parsers handle those formats instead.
	 */
	private static final boolean asposeAvailable;
	static {
		boolean found = false;
		try {
			Class.forName("com.aspose.pdf.Document");
			Class.forName("com.aspose.cells.Workbook");
			found = true;
		} catch (ClassNotFoundException e) {
			// Aspose JARs not on classpath - will use default Tika parsers
		}
		asposeAvailable = found;
	}

	/**
	 * Global privates used to control the process
	 */
	private static boolean initialized = false;

	// private static CompositeEncodingDetector encodingDetector;
	private static ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
	private static Logger logger = Logger.getLogger("TikaApi");
	private static TikaConfig tikaConfig;
	private static final String SYSTEM_NAME_STRING = System.getProperty("os.name");

	/**
	 * Prevent construction of instances of this class
	 */
	private TikaApi() {
	}

	/**
	 * Define all the native functions (in C++) to call when in response to events
	 * from the SAX content handler
	 * 
	 * It's very important to consider that int max value is ~2 billion,
	 * so if we need to read into very large buffers in the future
	 * we need to change to a long (long length)
	 */
	private static native boolean onTextExtractedCallback(long nativeHandle, char text[], int offset, int length,
			boolean isFinal, long memoryUsed) throws NativeError;

	private static native boolean onTableExtractedCallback(long nativeHandle, char text[], int offset, int length,
			boolean isFinal, long memoryUsed) throws NativeError;

	private static native void onDocumentParsedCallback(long nativeHandle, Object[] names, Object[] values,
			long memoryUsed) throws NativeError;

	private static native int onReadFromInputStream(long nativeHandle, long offset, byte[] buffer, int length)
			throws NativeError;

	/**
	 * Native method declaration for writing image/audio/video buffers.
	 * These methods are implemented in our C++ driver.
	 * 
	 * @param nativeHandle - a pointer to the native instance (as long)
	 * @param action       - AVI_ACTION where 0 = BEGIN, 1 = DATA, 2 = END
	 * @param mimeType     - the MIME type string (e.g. "image/jpeg", "audio/mpeg" etc.)
	 * @param buffer       - the data to be transmitted; may be empty on BEGIN/END
	 * @return
	 * @throws NativeError
	 */
	private static native boolean onWriteMediaBufferCallback(long nativeHandle, int action, String mimeType,
			byte[] buffer) throws NativeError;

	/**
     * Public wrapper that handles image stream and send it through onWriteMediaBufferCallback.
     *
     * @param nativeHandle native pointer to the underlying C++ instance.
     * @param action       AVI_ACTION (0 for BEGIN, 1 for DATA, 2 for END).
     * @param mimeType     MIME type of the embedded/standalone image.
     * @param buffer       Image data as a byte array (can be empty for the BEGIN and END actions).
     * @return true if the native call succeeds; false otherwise.
     * @throws NativeError if any error occurs in the native layer.
     */
	public static boolean onWriteImageBuffer(long nativeHandle, int action, String mimeType, byte[] buffer)
			throws NativeError {
		
		logger.log(Level.INFO, "Inside onWriteImageBuffer() callback with AVI_ACTION = " + action + " | mimeType: "
				+ mimeType + " | buffer length: " + (buffer == null ? 0 : buffer.length));
		if (nativeHandle == 0) {
			// Log a message, or simulate a successful native call for testing.
			System.err.println("Warning: nativeHandle is 0. Running in test mode. Action " + action + ", mimeType: "
					+ mimeType + ", buffer length: " + (buffer == null ? 0 : buffer.length));
			return true;
		}
		Core.Assert(nativeHandle != 0, "Native handle cannot be null");
		logger.log(Level.INFO, "Invoking the onWriteMediaBufferCallback() | AVI_ACTION = " + action + " | mimeType: "
				+ mimeType + " | buffer length: " + (buffer == null ? 0 : buffer.length));
		return onWriteMediaBufferCallback(nativeHandle, action, mimeType, buffer);
	}

	/**
	 * Public wrapper that handles audio stream and send it through onWriteMediaBufferCallback.
	 *
	 * @param nativeHandle the native pointer to the C++ instance.
	 * @param action       AVI_ACTION (0 for BEGIN, 1 for DATA, 2 for END).
	 * @param mimeType     the MIME type of the audio, e.g. "audio/mpeg".
	 * @param buffer       the audio data (may be empty on begin/end).
	 * @return true if the native call succeeds; false otherwise.
	 * @throws NativeError if the native layer fails.
	 */
	public static boolean onWriteAudioBuffer(long nativeHandle, int action, String mimeType, byte[] buffer)
			throws NativeError {
				logger.log(Level.INFO, "Inside onWriteAudiooBuffer() callback with AVI_ACTION = " + action + " | mimeType: "
				+ mimeType + " | buffer length: " + (buffer == null ? 0 : buffer.length));
		if (nativeHandle == 0) {
			// Log a message, or simulate a successful native call for testing.
			System.err.println("Warning: nativeHandle is 0. Running in test mode. Action " + action + ", mimeType: "
					+ mimeType + ", buffer length: " + (buffer == null ? 0 : buffer.length));
			return true;
		}
		Core.Assert(nativeHandle != 0, "Native handle cannot be null");
		logger.log(Level.INFO, "Invoking the onWriteMediaBufferCallback() | AVI_ACTION = " + action + " | mimeType: "
				+ mimeType + " | buffer length: " + (buffer == null ? 0 : buffer.length));
		return onWriteMediaBufferCallback(nativeHandle, action, mimeType, buffer);
	}

	/**
	 * Public wrapper that handles video stream and send it through onWriteMediaBufferCallback.
	 *
	 * @param nativeHandle the native pointer to the C++ instance.
	 * @param action       AVI_ACTION (0 for BEGIN, 1 for DATA, 2 for END).
	 * @param mimeType     the MIME type of the video, e.g. "video/mp4".
	 * @param buffer       the video data (may be empty on begin/end).
	 * @return true if the native call succeeds; false otherwise.
	 * @throws NativeError if the native layer fails.
	 */
	public static boolean onWriteVideoBuffer(long nativeHandle, int action, String mimeType, byte[] buffer)
			throws NativeError {
		logger.log(Level.INFO, "Inside onWriteVideoBuffer() callback with AVI_ACTION = " + action + " | mimeType: "
				+ mimeType + " | buffer length: " + (buffer == null ? 0 : buffer.length));
		if (nativeHandle == 0) {
			// Log a message, or simulate a successful native call for testing.
			System.err.println("Warning: nativeHandle is 0. Running in test mode. Action " + action + ", mimeType: "
					+ mimeType + ", buffer length: " + (buffer == null ? 0 : buffer.length));
			return true;
		}
		Core.Assert(nativeHandle != 0, "Native handle cannot be null");
		logger.log(Level.INFO, "Invoking the onWriteMediaBufferCallback() | AVI_ACTION = " + action + " | mimeType: "
				+ mimeType + " | buffer length: " + (buffer == null ? 0 : buffer.length));
		return onWriteMediaBufferCallback(nativeHandle, action, mimeType, buffer);
	}

	public static boolean onTextExtracted(long nativeHandle, char text[], int offset, int length, boolean isFinal)
			throws NativeError {
		Core.Assert(nativeHandle != 0, "Native handle cannot be null");
		if (length == 0)
			return true;

		return onTextExtractedCallback(nativeHandle, text, offset, length, isFinal, memoryUsed());
	}

	public static boolean onTableExtracted(long nativeHandle, char text[], int offset, int length, boolean isFinal)
			throws NativeError {
		Core.Assert(nativeHandle != 0, "Native handle cannot be null");
		if (length == 0)
			return true;

		return onTableExtractedCallback(nativeHandle, text, offset, length, isFinal, memoryUsed());
	}

	public static void onDocumentParsed(long nativeHandle, Metadata metadata) {
		Core.Assert(nativeHandle != 0, "Native handle cannot be null");

		// Serialize metadata to arrays of names and values
		ArrayList<String> metadataPropertyNames = new ArrayList<String>();
		ArrayList<String> metadataPropertyValues = new ArrayList<String>(); 
		MetadataSerializer.serializeMetadata(metadata, metadataPropertyNames, metadataPropertyValues);

		try {
			onDocumentParsedCallback(nativeHandle, metadataPropertyNames.toArray(), metadataPropertyValues.toArray(),
					memoryUsed());
		} catch (NativeError e) {
			logger.log(Level.SEVERE, "Failed to finalize parsed document:\n" + e.toString());
		}
	}
	
	/**
	 * Easily determine the OS type
	 */
	private static boolean isWindows() {
		return SYSTEM_NAME_STRING.toLowerCase().contains("windows");
	}

	private static boolean isMac() {
		return SYSTEM_NAME_STRING.toLowerCase().contains("mac");
	}

	private static boolean isLinux() {
		return SYSTEM_NAME_STRING.toLowerCase().contains("linux");
	}


	/**
	 * Handles reading from the given memory stream. that is passed by the C++ code
	 */
	public static int readFromInputStream(long nativeHandle, long offset, byte[] buffer, int length)
			throws IOException {
		Core.Assert(nativeHandle != 0, "Native handle cannot be null");

		try {
			// 0 = done, > 0 = data read from native stream
			return onReadFromInputStream(nativeHandle, offset, buffer, length);
		} catch (NativeError e) {
			throw new IOException("Failed to read from native stream", e);
		}
	}

	/**
	 * Global init/deinit of our tika parsing subsystem
	 */
	public static void init() throws Exception {
		// Get the root path
		logger.log(Level.INFO, "Tika.rootPath (Before set): " + TikaApi.rootPath);
		rootPath = System.getProperty("java.home") + "/..";
		logger.log(Level.INFO, "Tika.rootPath: " + TikaApi.rootPath);

		// Protect against double initialization
		if (initialized)
			throw new Exception("Already initialized");

		logger.log(Level.INFO, "Initializing TikaAPI ...");
		logger.log(Level.INFO, "Aspose parsers available: " + asposeAvailable);

		// Get a new encoding detector
		// encodingDetector = initEncodingDetector();

		// Get the configuration
		tikaConfig = ConfigBuilder.getConfig();

		// Start a scheduled task to clean up temporary files that are created when a
		// Tika parser uses File.createTempFile instead of Tika's
		// TemporaryResources [APPLAT-265]. This task will run every 5 minutes.
		executor.scheduleWithFixedDelay(new DeleteTemporaryFilesTask(), 5, 5, TimeUnit.MINUTES);
		initialized = true;
	}

	/**
	 * If this is not called, the JVM will refuse to exit
	 */
	public static void deinit() {
		executor.shutdown();
	}

	/**
	 * Returns the amount of memory we have used
	 * 
	 * @param None
	 */
	public static long memoryUsed() {
		// Calculate JVM heap usage
		Runtime runtime = Runtime.getRuntime();
		return runtime.totalMemory() - runtime.freeMemory();
	}

	/**
	 * Returns a PDFParserConfig object with customized configuration options.
	 * 
	 * The returned configuration object has been modified to disable the use of
	 * Tesseract OCR and set the maximum memory usage to 512Mb.
	 * 
	 * @return a PDFParserConfig object with custom configuration options.
	 */
	public static PDFParserConfig getPdfConfig() {
		// We're not going to use Tesseract OCR, so we disable the options for inline
		// image extraction and OCR strategy in PDFParserConfig.
		PDFParserConfig config = new PDFParserConfig();
		config.setExtractInlineImages(true);
		config.setExtractUniqueInlineImagesOnly(true);

		// Maximum usage is 512Mb
		config.setMaxMainMemoryBytes(512 * 1024 * 1024);

		/**
		 * We are doing ocr through separate ML pipeline, not using tesseract anymore
		 * This setting is required to avoid runtime exception for some files
		 */
		config.setOcrStrategy(PDFParserConfig.OCR_STRATEGY.NO_OCR);

		// Return the customized PDFParserConfig object
		return config;
	}

	/**
	 * This function uses Apache Tika to extract information from the provided input
	 * stream of documents and writes it to the specified writer. If documents
	 * contain images and/or the input stream is an image itself, then it invokes
	 * the Deep Neural parser for image processing and do OCR. It also populates the
	 * provided metadata object with metadata about the extracted information
	 * 
	 * https://stackoverflow.com/questions/25783212/extract-images-from-pdf-with-apache-tika
	 * 
	 * @param stream      The created tika input stream
	 * @param extractPath The actual pathname to extract from - this doesn't have to
	 *                    be real, but the file extension is passed to assist tika
	 *                    in recognizing the file
	 * @param writer      tika will output to this SAX writer
	 * @param metadata    Sends/receives the tika metadata
	 * @param flags       OCR/MAGICK enabled or not
	 * @throws Exception
	 */

	public static boolean extractInformation(long nativeHandle, TikaInputStream stream, String extractPath, Writer writer,
			Metadata metadata, long flags, boolean printTables) throws Exception {
		// If we're only extracting metadata, dump any extracted text
		BodyContentHandler handler = new BodyContentHandler(writer);
		AutoDetectParser parser = new AutoDetectParser(tikaConfig);
		logger.log(Level.INFO, "The flags value is : " + flags);

		// Set Awt headless mode for the Mac
		String os = System.getProperty("os.name").toLowerCase();
		boolean isMac = os.contains("mac");
		if(isMac){
			System.setProperty("java.awt.headless","true");
		}
		
		try {
			// Detect the media type
			Detector detector = parser.getDetector();
			MediaType mediaType = detector.detect(stream, metadata);
			String mimeType = mediaType.toString();

			// Configure the parse context, sets the OCR configuration and encoding detectors
			ParseContext context = new ParseContext();

			// Replace email parser with our custom parser
			Map<MediaType, Parser> parsers = parser.getParsers(context);
			parsers.put(MediaType.parse(MIME_TYPE_EMAIL), new CustomRFC822Parser());
			parser.setParsers(parsers);

			// Wrap the handler in our filter to exclude non-printable characters
			StructureContentHandler filter = new StructureContentHandler(handler, metadata);

			if (asposeAvailable && (mimeType.startsWith(MIME_TYPE_EXCEL)
					|| mediaType.toString().startsWith(MIME_TYPE_EXCEL_XLSX))) {
				// Use Aspose ExcelParser via reflection
				Parser excelParser = createAsposeExcelParser(extractPath, mediaType);
				context.set(Parser.class, excelParser);
				excelParser.parse(stream, filter, metadata, context);

			} else if (asposeAvailable && mimeType.startsWith(MIME_TYPE_PDF)) {
				// Use Aspose PDFParser via reflection
				EmbeddedContentProcessor extractor = new EmbeddedContentProcessor(nativeHandle, MIME_TYPE_IMAGE);
				Parser docParser = createAsposePDFParser(extractor, extractPath, mediaType);
				context.set(Parser.class, docParser);
				docParser.parse(stream, filter, metadata, context);

			} else if (mimeType.startsWith(MIME_TYPE_IMAGE) || mimeType.startsWith(MIME_TYPE_AUDIO) || mimeType.startsWith(MIME_TYPE_VIDEO)) {
				logger.log(Level.INFO, "Current processing media type is : " + mimeType);
				// Wrap with duplicator to safely reuse the stream
				Util.StreamDuplicator duplicator = new Util.StreamDuplicator(stream);
				logger.log(Level.INFO, "Buffered stream size: " + duplicator.size());
				
				long bytesBefore = duplicator.getParserStream().available();

				logger.log(Level.INFO, "Bytes available BEFORE parser.parse(): " + bytesBefore);
				logger.log(Level.INFO, "\nInvoke parse() method (standalone " + mimeType + " type)\n");

				// Perform metadata extraction
				parser.parse(duplicator.getParserStream(), filter, metadata, context);

				long bytesAfter = duplicator.getParserStream().available();
				logger.log(Level.INFO, "Bytes available AFTER parser.parse(): " + bytesAfter);
				
				// Send media stream to native layer
				EmbeddedContentProcessor extractor = new EmbeddedContentProcessor(nativeHandle, mimeType);
				extractor.processEmbeddedMediaStream(duplicator.getBinaryStream(), mimeType);
				
			} else {
				// Configure the parse context and encoding config
				context.set(Parser.class, parser);
				context.set(PDFParserConfig.class, getPdfConfig());

				EmbeddedContentProcessor extractor = new EmbeddedContentProcessor(nativeHandle, mimeType);
				context.set(EmbeddedDocumentExtractor.class, extractor);

				logger.log(Level.INFO, "\nInvoke parse() method (on doc type)\n");
				parser.parse(stream, filter, metadata, context); // Invoke deafult autodect parser
				logger.log(Level.INFO, "extracted texts from the parent Input Stream : " + filter.toString());
			}

			// If we found any tables, add them to the metadata
			List<String> tables = filter.getDocumentTables();

			// If we found tables...
			if (tables.size() != 0) {
				if (printTables) {
					// Output the header
					System.out.println(" ");
					System.out.println("Extracted tables:");
					System.out.println("---------------------------------------------------------");
				}

				// Signal/print the tables we found
				for (String table : tables) {
					if (printTables) {
						System.out.println(table);
					} else {
						onTableExtracted(nativeHandle, table.toCharArray(), 0, table.length(), false);
					}
				}
			}
		} catch (Exception e) {
			logger.log(Level.WARNING, "Failed to parse file: " + extractPath); // optional file reference
			logger.log(Level.WARNING, "Exception type: " + e.getClass().getName());
			logger.log(Level.WARNING, "Message: " + e.getMessage());

			// Print root cause if available
			Throwable cause = e.getCause();

			if (cause != null) {
				logger.log(Level.WARNING, "Root cause: " + cause.getClass().getName() + " - " + cause.getMessage());
				cause.printStackTrace();
			} else {
				e.printStackTrace();
			}
		} finally {
			// Close the input stream
			stream.close();
		}

		return true;
	}

	/**
	 * Internal method that all native-invoked extractText variants chain to
	 * 
	 * @param stream       The input stream created by the native interface
	 * @param extractPath  The actual pathname to extract from - this doesn't have
	 *                     to be real, but the file extension is passed to assist
	 *                     tika in recognizing the file
	 * @param metadata     Sends/receives the tika metadata
	 * @param flags        OCR/MAGICK enabled or not
	 * @param nativeHandle The handle to the context in the native interface
	 */
	private static boolean extractTextForNative(TikaInputStream stream, String extractPath, Metadata metadata,
			long flags, long nativeHandle) throws Exception {
		try {
			return extractInformation(nativeHandle, stream, extractPath, new NativeWriter(nativeHandle), metadata, flags, false);
		} finally {
			onDocumentParsed(nativeHandle, metadata);
		}
	}

	/**
	 * Extract text by file path (invoked from main)
	 * 
	 * @param extractPath  The actual pathname to extract from
	 * @param flags        OCR/MAGICK enabled or not
	 * @param nativeHandle The handle to the context in the native interface
	 */
	public static boolean extractTextFromPath(String extractPath, long flags, long nativeHandle) throws Exception {
		logger.log(Level.INFO, "Extracting text to native from path: " + extractPath);
		Metadata metadata = new Metadata();

		// Include metadata in TikaInputStream.get to allow it to set path-based
		// properties
		TikaInputStream ts = TikaInputStream.get(Paths.get(extractPath), metadata);
		return extractTextForNative(ts, extractPath, metadata, flags, nativeHandle);
	}

	/**
	 * Extract text - this is called by the C++ API to process the file
	 * 
	 * @param stream       The input stream created by the native interface
	 * @param extractPath  The actual pathname to extract from - this doesn't have
	 *                     to be real, but the file extension is passed to assist
	 *                     tika in recognizing the file
	 * @param length       The overall length of the stream (if unknown, set to 0)
	 * @param flags        OCR/MAGICK enabled or not
	 * @param nativeHandle The handle to the context in the native interface
	 * @throws Exception
	 */
	public static boolean extractTextFromStream(InputStream stream, String extractPath, long length, long flags,
			long nativeHandle) throws Exception {
		logger.log(Level.INFO, "Extracting text to native from stream: " + extractPath);
		Metadata metadata = new Metadata();

		// Set the metadata properties normally set by TikaInputStream.get variants
		if (!extractPath.isEmpty()) {
			try {
				metadata.set("resourceName", Paths.get(extractPath).getFileName().toString());
			} catch (Exception e) {
				// Log the error but continue processing - use extractPath as fallback
				logger.log(Level.WARNING, "Failed to extract filename from path: " + extractPath + ", using path as fallback", e);
				metadata.set("resourceName", extractPath);
			}
		}

		if (length > 0)
			metadata.set(Metadata.CONTENT_LENGTH, Long.toString(length));

		TikaInputStream ts = TikaInputStream.get(stream);
		return extractTextForNative(ts, extractPath, metadata, flags, nativeHandle);
	}

	/**
	 * Create the Aspose-based ExcelParser via reflection.
	 * The class com.rocketride.tika_api.parsers.excel.ExcelParser is provided
	 * by the optional aspose-parsers JAR (engine-ads overlay).
	 */
	private static Parser createAsposeExcelParser(String fileName, MediaType mediaType) throws Exception {
		Class<?> clazz = Class.forName("com.rocketride.tika_api.parsers.excel.ExcelParser");
		Object instance = clazz.getDeclaredConstructor().newInstance();
		clazz.getMethod("setFileName", String.class).invoke(instance, fileName);
		clazz.getMethod("setMediaType", MediaType.class).invoke(instance, mediaType);
		return (Parser) instance;
	}

	/**
	 * Create the Aspose-based PDFParser via reflection.
	 * The class com.rocketride.tika_api.parsers.pdf.PDFParser is provided
	 * by the optional aspose-parsers JAR (engine-ads overlay).
	 */
	private static Parser createAsposePDFParser(EmbeddedContentProcessor extractor, String fileName, MediaType mediaType) throws Exception {
		Class<?> clazz = Class.forName("com.rocketride.tika_api.parsers.pdf.PDFParser");
		Constructor<?> ctor = clazz.getDeclaredConstructor(EmbeddedContentProcessor.class);
		Object instance = ctor.newInstance(extractor);
		clazz.getMethod("setFileName", String.class).invoke(instance, fileName);
		clazz.getMethod("setMediaType", MediaType.class).invoke(instance, mediaType);
		return (Parser) instance;
	}

	/**
	 * To extract text from a file to the console, use:
	 * 
	 * java -cp <path to this jar> com.rocketride.tika_api.TikaApi <path> [--ENABLEOCR
	 * --DEBUG --MARKUP]
	 * 
	 * For example: java -cp tika.jar com.rocketride.tika_api.TikaApi x:\file.txt
	 *
	 * @throws Exception
	 */
	public static void main(String[] args) throws Exception {
		// Parse CLI parameters
		if (args.length < 1)
			throw new Exception("Path required");

		Level logLevel = Level.INFO;
		String path = null;
		long flags = 0;
		for (String arg : args) {
			if (path == null) {
				path = arg;
				// System.out.println("Extracting text: " + path);
				logger.log(Level.INFO, "Extracting text: " + path);
			} else {
				switch (arg.toUpperCase()) {
					case "--DEBUG":
						logLevel = Level.CONFIG;
						break;

					case "--MARKUP":
						enableMarkup = true;
						// System.out.println("Enabling markup output");
						logger.log(Level.INFO, "Enabling markup output");
						break;

					default:
						throw new Exception("Argument not understood: " + arg);
				}
			}
		}

		// Initialize logging
		// Logging.redirectStandardStreamsToNative = false;
		// Logging.init(logLevel);
		logger.setLevel(logLevel);
		logger.addHandler(new ConsoleHandler());

		try {
			// Initialize the API
			TikaApi.init();

			// Log maxHeapMemory for JVM
			long maxHeapBytes = Runtime.getRuntime().maxMemory();
			long maxHeapMB = maxHeapBytes / (1024 * 1024);

			System.out.println("💡 Max Heap Memory: " + maxHeapMB + " MB");

			System.out.println("JVM Arg: ");
			for (String arg : java.lang.management.ManagementFactory.getRuntimeMXBean().getInputArguments()) {
				System.out.println("JVM Arg: " + arg);
			}
		
			// Include metadata in TikaInputStream.get to allow it to set path-based
			// properties
			Metadata metadata = new Metadata();
			TikaInputStream ts = TikaInputStream.get(Paths.get(path), metadata);
			PrintWriter writer = new PrintWriter(System.out, false);

			System.out.println(" ");
			System.out.println("Extracted text:");
			System.out.println("---------------------------------------------------------");
			if (!TikaApi.extractInformation(0, ts, path, writer, metadata, flags, true))
				throw new Exception("Parse aborted!");

			ArrayList<String> names = new ArrayList<String>();
			ArrayList<String> values = new ArrayList<String>();
			MetadataSerializer.serializeMetadata(metadata, names, values);

			System.out.println(" ");
			System.out.println("Extracted metadata:");
			System.out.println("---------------------------------------------------------");
			for (int i = 0; i < names.size(); i++) {
				System.out.println(names.get(i) + "=" + values.get(i));
			}
		} catch (Error e) {
			// System.out.printf("Exception: %s", e.toString());
			logger.log(Level.SEVERE, "Exception: " + e.toString());
		} finally {
			TikaApi.deinit();
		}
	}
}

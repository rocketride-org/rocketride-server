package com.rocketride.tika_api;

import org.apache.commons.lang3.StringUtils;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.mime.MediaType;
import org.apache.tika.sax.ContentHandlerDecorator;
import org.xml.sax.ContentHandler;
import org.xml.sax.SAXException;
import org.xml.sax.Attributes;
import java.util.ArrayList;
import java.util.List;

import java.util.logging.Level;
import java.util.logging.Logger;

public class StructureContentHandler extends ContentHandlerDecorator {
	private Metadata metadata;
	private int charactersWritten = 0;
	boolean tablesInContent = false;
	List<String> tables = new ArrayList<String>();
	Table table;

	private static Logger logger = Logger.getLogger("TikaApi");
	private static final MediaType APPLICATION_SHELL_SCRIPT = MediaType.parse("application/x-sh");

	/**
	 * Constructor - we pass the metadata over that we have received so we can check
	 * the content type
	 * 
	 * @param handler  current handler to attach to
	 * @param metadata the metadata information
	 */
	public StructureContentHandler(ContentHandler handler, Metadata metadata) {
		super(handler);
		this.metadata = metadata;
	}

	/**
	 * This function will output starting/ending element codes based on the element
	 * name
	 * 
	 * @param elementName name of the element (like div, b, table, etc)
	 * @throws SAXException
	 */
	private void writeElement(String elementName) throws SAXException {
		// If markup is not enabled, skip this
		if (!TikaApi.enableMarkup)
			return;

		// Write it to the output
		super.characters(elementName.toCharArray(), 0, elementName.length());
	}

	/**
	 * Called when we are starting a document
	 */
	@Override
	public void startDocument() throws SAXException {
		// The parser sends this back to tell us that the
		// contents of the table are already in the content
		// body - get the value
		String tic = this.metadata.get("tablesInContent");

		// Must be set to:
		// "1" = anythime in <th>/<td> is already stored in the content
		// other = all table text must be put into the content as well as processed
		if (tic != null && tic.equals("1"))
			this.tablesInContent = true;

		// Call the base class
		super.startDocument();
	}

	/**
	 * We get this when an opening element such as div, table, meta etc is produced
	 * by the parser
	 */
	@Override
	public void startElement(String uri, String localName, String name, Attributes atts) throws SAXException {
		String lcname = localName.toLowerCase();

		// If this is a table element
		switch (lcname) {
			case "table":
				// Starting a new table
				this.table = new Table();
				this.table.tableStart();
				break;

			case "thead":
				safeExecutor(() -> this.table.tableHeaderStart(), "thead");
				break;

			case "tbody":
				safeExecutor(() -> this.table.tableBodyStart(), "tbody");
				break;

			case "tfoot":
				safeExecutor(() -> this.table.tableFooterStart(), "tfoot");
				break;

			case "tr":
				// Starting a new regular row
				safeExecutor(() -> this.table.tableRowStart(), "tr");
				break;

			case "th":
				// Starting a new header row
				safeExecutor(() -> this.table.tableHeaderCellStart(), "th");
				break;

			case "td":
				// Starting a new data cell
				safeExecutor(() -> this.table.tableDataCellStart(), "td");
				break;

			default:
				// Write the element
				writeElement("<" + localName + ">");
				break;
		}

		// Call our parent
		super.startElement(uri, localName, name, atts);
	}

	/**
	 * We get this when a closing element such as div, table, meta etc is produced
	 * by the parser
	 */
	@Override
	public void endElement(String uri, String localName, String name) throws SAXException {
		String lcname = localName.toLowerCase();

		// If this is a table element
		switch (lcname) {
			case "table":
				if (this.table != null) {
					// Starting a new table
					this.table.tableEnd();

					// If we found a valid table
					if (this.table.isValidTable()) {
						// Get the table in html format
						String tableText = this.table.getTableText();

						// Append the table to tables
						this.tables.add(tableText);
					}

					// Reset the table
					this.table = null;
				} else {
					logger.log(Level.INFO, "Skipping </table> — table context missing");
				}
				break;

			case "thead":
				safeExecutor(() -> this.table.tableHeaderEnd(), "thead");
				break;

			case "tbody":
				safeExecutor(() -> this.table.tableBodyEnd(), "tbody");
				break;

			case "tfoot":
				safeExecutor(() -> this.table.tableFooterEnd(), "tfoot");
				break;

			case "tr":
				// Ending a new regular row
				safeExecutor(() -> this.table.tableRowEnd(), "tr");
				break;

			case "th":
				// Ending a new header row
				safeExecutor(() -> this.table.tableHeaderCellEnd(), "th");
				break;

			case "td":
				// Ending a new data cell
				safeExecutor(() -> this.table.tableDataCellEnd(), "td");
				break;

			default:
				// Write the element
				writeElement("<" + localName + ">");
				break;
		}

		// Call our parent
		super.endElement(uri, localName, name);
	}

	/**
	 * Currently, this behavior is only used for shell scripts because our
	 * installers (.run files) are shell scripts followed by a GZIP'd binary
	 * payload, and the admixture is confusing Tika and resulting in the binary
	 * content being extracted as gibberish text.
	 * 
	 * The GZIP'd content starts with the magic number {0x1f, 0x8B}, which the
	 * SafeContentHandler replaces with
	 * org.apache.tika.sax.SafeContentHandler.REPLACEMENT, i.e. the Unicode
	 * replacement character, 0xFFFD.
	 * 
	 * So, when processing files Tika identifies as shell scripts, we'll stop
	 * extracting text at the first invalid character.
	 */
	private boolean haltAtFirstInvalidCharacter() {
		// Get the content type
		String contentType = metadata.get(Metadata.CONTENT_TYPE);

		// If it is unknown, don't halt
		if (StringUtils.isEmpty(contentType))
			return false;

		// Get the media type from the content, if it is unknown
		// then don't galt
		MediaType type = MediaType.parse(contentType);
		if (type == null)
			return false;

		// If the media type is a shell script...
		return type.getBaseType() == APPLICATION_SHELL_SCRIPT;
	}

	/**
	 * This is the main interface that is called when tika found characters to write
	 * to the output stream
	 */
	@Override
	public void characters(char ch[], int start, int length) throws SAXException {
		// If we're set to halt at the first invalid character, search the text for the
		// first instance of the Unicode replacement character (0xFFFD)
		boolean invalidCharacterFound = false;

		// If this is a shell script...
		if (haltAtFirstInvalidCharacter()) {
			// Loop through the characters
			for (int i = start; i < start + length; ++i) {
				// If we found one, note it, truncate the text (by adjusting the length),
				// and process the characters preceding the invalid character
				if (Character.codePointAt(ch, i) == 0xFFFD) {
					invalidCharacterFound = true;
					length = i - start;
					break;
				}
			}
		}

		// Replace non-printable characters with spaces
		Util.filterNonPrintableCharacters(ch, start, length);

		// If we are in the middle of a table, send the data to the table
		if (this.table != null) {
			// Create a new string
			String str = new String(ch, start, length);

			// Send it to the table
			this.table.tableCellData(str);

			// If we need to send it along in the content as well?
			// This is the case, which is the default, that the parser
			// removes the text if it is within a table.
			if (!this.tablesInContent)
			super.characters(ch, start, length);
		} else {
			// Send it along
			super.characters(ch, start, length);
		}

		// Add the text
		charactersWritten += length;

		// If we found an invalid character, throw now
		if (invalidCharacterFound) {
			// Close the document, i.e. flush all content to the writer
			endDocument();
			throw new ExtractionAbortedException(
					String.format("Stopped extraction at invalid character at offset %d (binary content detected)",
							charactersWritten));
		}
	}

	/*
	 * Return the tables we gathered
	 */
	public List<String> getDocumentTables() {
		return this.tables;
	}

	/**
	 * Safely executes an action on the current table object, if it exists.
	 * Logs a message if the table context is missing to help identify structural issues
	 * in the parsed document (e.g., encountering <td> or <tr> outside of a <table>).
	 *
	 * @param action The action to execute if the table is not null.
	 * @param tag    The XML/HTML tag associated with the action (used for logging).
	 * 
	 * See APPLAT-12280 bug for more detail
	 */
	private void safeExecutor(Runnable action, String tag) {
		if (this.table != null) {
			action.run();
		} else {
			logger.log(Level.INFO, "Skipping <" + tag + "> — table context missing");
		}
	}
}

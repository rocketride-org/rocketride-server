package com.rocketride.tika_api;

import com.rocketride.*;
import java.util.ArrayList;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.metadata.TikaCoreProperties;

/**
 * Extends Tika's metadata class to intercept unwanted metadata properties and
 * remove non-printable characters from metadata values.
 * 
 * Only the Tika metadata functions that actually modify the internal dictionary
 * are overridden (other functions forward to these functions).
 */
public final class MetadataSerializer {
	/**
	 * Transformation of common properties listed by Tika. Tika 2.x takes care of
	 * most of these, but eliminate the ones it doesn't, and map meta:last-author
	 * over to dc:modifier
	 */
	private final static CanonicalProperty canonicalProperties[] = {
			new CanonicalProperty(TikaCoreProperties.COMMENTS, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.CONTRIBUTOR, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.COVERAGE, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.CREATED,
					new String[] { "created", "date", "meta:created", "pdf:docinfo:created", }),
			new CanonicalProperty(TikaCoreProperties.CREATOR, new String[] { "pdf:docinfo:creator" }),
			new CanonicalProperty(TikaCoreProperties.DESCRIPTION, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.FORMAT, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.IDENTIFIER, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.SUBJECT, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.LANGUAGE, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.MODIFIED,
					new String[] { "modified", "meta:modified", "File Modified Date", }),
			new CanonicalProperty(TikaCoreProperties.MODIFIER, new String[] { "Last-Author", "meta:last-author" },
					"dc:modifier"),
			new CanonicalProperty(TikaCoreProperties.PRINT_DATE, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.PUBLISHER, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.RELATION, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.RIGHTS, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.SOURCE, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.TITLE, new String[] {}),
			new CanonicalProperty(TikaCoreProperties.TYPE, new String[] {}), };

	/**
	 * Some metadata fields have very long values. We already exclude some of them
	 * using excludedNames below.
	 * But right now we do it only for known properties. We need to come up with
	 * general solution to not
	 * to pollute engine output file with "unlimited" strings. As it stands we`ll
	 * throw away each property
	 * longer than MAX_METADATA_VALUE_LEN symbols
	 */
	private final static int MAX_METADATA_VALUE_LEN = 4000;

	/**
	 * Metadata properties that will be removed
	 */
	private final static String[] excludedNames = {
			// .bmp - huge entries with no value
			"Chroma Palette PaletteEntry", "Chroma Palette",

			// .png - huge entries with no value
			"Text TextEntry" + "", "IHDR", "iTXt iTXtEntry", "zTXt zTXtEntry",

			// File properties; the caller already knows these
			"resourceName", "Content-Length",

			// JPEG metadata that can be quite large and don't seem useful
			"Blue TRC", "Green TRC", "Red TRC",

			// Machine metadata; not needed
			"machine:architectureBits", "machine:endian", "machine:machineType", "machine:platform",

			// PDF metadata that can be quite large don't seem useful
			"pdf:charsPerPage", "pdf:encrypted", // We track this via X-RocketRide:Encrypted
			"pdf:unmappedUnicodeCharsPerPage",
			"pdf:annotationTypes",

			// Metadata added by Tika that we don't need (all file types)
			"embeddedRelationshipId", "X-Parsed-By", "X-TIKA:Parsed-By", "X-TIKA:embedded_depth",
			"X-TIKA:parse_time_millis", };

	/**
	 * Same as above, but using prefix matching to discard whole classes of metadata
	 * properties
	 */
	private final static String[] excludedNamePrefixes = {

			"extended-properties:", // Properties defined by the Office
									// Open XML specification;
									// duplicative of other properties
			"pdf:docinfo:", // PDF metadata; duplicated by Dublin Core properties
			"meta:", // Deprecated Open Office metadata,
			"tiff:", // tiff info duplicated
			"Message:Raw-Header:" // email Metadata
	};

	/**
	 * Metadata property names with special handling
	 */
	public final static String ROCKETRIDE_IS_ENCRYPTED = "X-RocketRide:IsEncrypted";
	public final static String TIKA_EMBEDDED_STREAM_EXCEPTION = TikaCoreProperties.TIKA_META_EXCEPTION_EMBEDDED_STREAM
			.getName();

	/**
	 * Prevent construction of instances of this class
	 */
	private MetadataSerializer() {
	}

	/**
	 * Transform all special properties under a consistent name
	 * 
	 * @param metadata the metadata to process
	 */
	private static void canonicalizeMetadata(Metadata metadata) {
		// In Tika 2.0, they will consolidate metadata
		// properties: https://issues.apache.org/jira/browse/TIKA-1691.
		// Until then, we canonicalize metadata using a combination of
		// Tika's core properties' aliases and manually associated aliases
		for (CanonicalProperty property : canonicalProperties) {
			property.processMetadata(metadata);
		}
	}

	/**
	 * Based on the name, should this property be returned
	 * 
	 * @param name
	 * 
	 * @return true = exclude the property
	 */
	private static boolean isPropertyNameExcluded(String name) {
		// Exclude properties with empty names
		if (name.isEmpty())
			return true;

		// Exclude anything on our list of excluded property names -
		// we must use intern here, otherwise they don't match
		for (String excluded : excludedNames) {
			if (name.intern() == excluded)
				return true;
		}

		// Exclude anything that matches our list of excluded property name prefixes
		for (String prefix : excludedNamePrefixes) {
			if (name.startsWith(prefix))
				return true;
		}

		return false;
	}

	/**
	 * Based on the name, should this property value be returned
	 * 
	 * @param name
	 * 
	 * @return true = exclude the value
	 */
	private static boolean isPropertyValueExcluded(String name, String value) {
		// If the content type is unknown, ignore it
		if (name == Metadata.CONTENT_TYPE && value == "application/octet-stream")
			return true;
		return false;
	}

	/**
	 * Retrieves the metadata value and stringifies it
	 * 
	 * @param metadata the metadata
	 * @param name     the name to retrieve
	 * 
	 * @return the stringified value
	 */
	private static String buildValue(Metadata metadata, String name) {
		// Get a string builder
		StringBuilder sb = new StringBuilder();

		// For each sub-value in the value
		for (String value : metadata.getValues(name)) {
			if (value.isEmpty())
				continue;

			// Is this to be excluded?
			if (isPropertyValueExcluded(name, value))
				continue;

			// Insert "; " between multivalued property values
			if (sb.length() != 0)
				sb.append("; ");

			// Apend to the end
			sb.append(value);
		}

		// And done
		return sb.toString();
	}

	/**
	 * Add the property to the return propertys
	 * 
	 * @param name   the name of the property
	 * @param value  the value of the property
	 * @param names  array of names
	 * @param values array of values
	 */
	private static void serializeProperty(String name, String value, ArrayList<String> names,
			ArrayList<String> values) {
		// Sanitize the name and value to ensure valid UTF-8 and remove non-printable characters
		// The name almost certainly is already clean, but we might as well be safe
		names.add(Util.sanitizeString(name));
		values.add(Util.sanitizeString(value));
	}

	/**
	 * Maps a complex property to another - changes a tika stream encryption
	 * exception over to an rocketride specific code
	 * 
	 * @param name   the name of the property
	 * @param value  the value of the property
	 * @param names  array of names
	 * @param values array of values
	 */
	private static boolean mapProperty(String name, String value, ArrayList<String> names, ArrayList<String> values) {
		// Intercept EncryptedDocumentExceptions reported for substreams
		if (name == TIKA_EMBEDDED_STREAM_EXCEPTION) {
			if (value.indexOf("org.apache.tika.exception.EncryptedDocumentException") != -1) {
				serializeProperty(ROCKETRIDE_IS_ENCRYPTED, String.valueOf(true), names, values);
				return true;
			}
		}

		return false;
	}

	/**
	 * Determines if the metadata has been marked as an rocketride encrypted stream
	 *
	 * @param metadata
	 */
	public static boolean getIsEncrypted(Metadata metadata) {
		return Boolean.parseBoolean(metadata.get(ROCKETRIDE_IS_ENCRYPTED));
	}

	/**
	 * Set/reset the rocketride encrpyted metadata property
	 * 
	 * @param metadata
	 * @param value
	 */
	public static void setIsEncrypted(Metadata metadata, boolean value) {
		if (value) {
			// Forward to superclass because our set method will discard any RocketRide
			// properties
			metadata.set(ROCKETRIDE_IS_ENCRYPTED, String.valueOf(value));
		} else
			metadata.remove(ROCKETRIDE_IS_ENCRYPTED);
	}

	/**
	 * Transform, sanitize and serialize the metadata
	 * 
	 * @param metadata the metadata to serialize
	 * @param names    recieves an array of names
	 * @param values   recevies an array of value
	 */
	public static void serializeMetadata(Metadata metadata, ArrayList<String> names, ArrayList<String> values) {
		// Clear any existing properties in case of re-use
		names.clear();
		values.clear();

		// Canonicalize the metadata by transforming properties
		canonicalizeMetadata(metadata);

		// Iterate over the property names (no access to the Metadata object's
		// internal map)
		for (String name : metadata.names()) {
			// Shouldn't be possible, but skip properties with empty names
			if (name.isEmpty())
				continue;

			// Skip excluded properties, e.g. X-Parsed-By
			if (isPropertyNameExcluded(name))
				continue;

			// Skip properties with empty values
			String value = buildValue(metadata, name);
			if (value.isEmpty())
				continue;

			// Skip properties with too long values
			if (name != "functions" &&
					name != "references" &&
					name != "numberOfBaseFunctionsPerFormula" &&
					name != "numberOfLinksPerFormula" &&
					name != "sheetsWithFormulasLongerThan50AndHave3baseFunctions" &&
					value.length() > MAX_METADATA_VALUE_LEN)
				continue;

			// If the property is mapped to some other name or value, skip
			if (mapProperty(name, value, names, values))
				continue;

			// Add the property
			serializeProperty(name, value, names, values);
		}

		Core.Assert(names.size() == values.size(), "Serialized metadata has differing numbers of names and values");
	}
}
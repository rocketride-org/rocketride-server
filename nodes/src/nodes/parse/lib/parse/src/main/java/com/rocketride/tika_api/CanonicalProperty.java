package com.rocketride.tika_api;

import org.apache.tika.metadata.Property;
import org.apache.tika.metadata.Metadata;

public class CanonicalProperty {
	final public String propName;
	final public String[] aliases;
	final public Property coreProperty;

	/**
	 * Constructor
	 * 
	 * @param coreProperty the dublin core property name
	 * @param aliases      aliases that we care going to remove
	 */
	public CanonicalProperty(Property coreProperty, String[] aliases) {
		this.coreProperty = coreProperty;
		this.aliases = aliases;
		this.propName = coreProperty.getName();
	}

	/**
	 * Constructor
	 * 
	 * @param coreProperty the dublin core property name
	 * @param aliases      aliases that we care going to remove
	 * @param propName     the name we should change this property to
	 */
	public CanonicalProperty(Property coreProperty, String[] aliases, String propName) {
		this.coreProperty = coreProperty;
		this.aliases = aliases;
		this.propName = propName;
	}

	/**
	 * If the dublin core property has been set, make sure any aliases are thus
	 * removed
	 * 
	 * @param metadata the metadata info to check
	 */
	public void processMetadata(Metadata metadata) {
		// Is the property present with its canonical name?
		String value = metadata.get(propName);

		// If it isn't present, rip through and see if we can find one
		// of it's aliases
		if (value == null) {
			for (String alias : this.aliases) {
				// Get the alias if present
				value = metadata.get(alias);

				// If it has the alias, set it under the prop name
				if (value != null) {
					metadata.set(propName, value);
					break;
				}
			}
		}

		// Remove any property listed as an alias to this property
		for (String alias : this.aliases) {
			metadata.remove(alias);
		}
	}
}
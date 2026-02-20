package com.rocketride.tika_api;

import org.apache.log4j.Logger;

import java.io.File;
import java.io.IOException;
import java.io.StringWriter;

import org.w3c.dom.Element;
import org.w3c.dom.Text;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.w3c.dom.Document;

import javax.xml.xpath.XPath;
import org.xml.sax.SAXException;
import javax.xml.xpath.XPathFactory;
import javax.xml.xpath.XPathConstants;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.Transformer;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.stream.StreamResult;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;

import org.apache.tika.config.TikaConfig;
import org.apache.tika.exception.TikaException;

public class ConfigBuilder {
	public static boolean ocrEnabled = false;
	public static boolean magickEnabled = false;
	public static String languages = null;
	private static String defaultParserName = "org.apache.tika.parser.DefaultParser";
	private static Logger logger = Logger.getLogger(ConfigBuilder.class);

	/**
	 * Sets a nodes text value
	 * 
	 * @param doc   The parent document
	 * @param node  The node to set
	 * @param value The value to set
	 */
	public static void setNodeValue(Document doc, Node node, String value) {
		// Remove all the child nodes - should only be 1 really
		while (node.hasChildNodes())
			node.removeChild(node.getFirstChild());

		// Doesn't have the parameter, we need to create it
		Text valueElement = doc.createTextNode(value);

		// And add it to the parameters
		node.appendChild(valueElement);
	}

	/**
	 * Gets a nodes text value
	 * 
	 * @param doc   The parent document
	 * @param node  The node to set
	 */
	public static String getNodeValue(Document doc, Node node) {
		// Return the value
		return node.getFirstChild().getTextContent();
	}

	/**
	 * Removes a nodes value by removing all its children
	 * 
	 * @param doc  The parent document
	 * @param node The node to set
	 */
	public static void removeNodeValue(Document doc, Node node) {
		// Remove all the child nodes - should only be 1 really
		while (node.hasChildNodes())
			node.removeChild(node.getFirstChild());
	}

	/**
	 * Find the node with the given tag
	 * 
	 * @param doc    The parent document
	 * @param parent The parent element to search
	 * @param tag    The teag to find
	 */
	public static Node findNode(Document doc, Node parent, String tag) {
		// If the parent is null, no child
		if (parent == null)
			return null;

		// Loop to get the first node with this tag
		NodeList childList = parent.getChildNodes();
		for (int index = 0; index < childList.getLength(); index++) {
			if (childList.item(index).getLocalName() == tag)
				return childList.item(index);
		}

		// Could find it
		return null;
	}

	/**
	 * Find the node with the given tag. If it doesn't exist, create it
	 * 
	 * @param doc    The parent document
	 * @param parent The parent element to search
	 * @param tag    The teag to find or add
	 */
	public static Node findOrAddNode(Document doc, Node parent, String tag) {
		// Find it first
		Node node = findNode(doc, parent, tag);
		if (node != null)
			return node;

		// It didn't exist, create it
		node = doc.createElement(tag);
		parent.appendChild(node);
		return node;
	}

	/**
	 * Find the parser if it exists
	 * 
	 * @param doc        The parent document
	 * @param parserName The name of the parser (class=) attribute
	 */
	public static Node findParser(Document doc, String parserName) {
		// Find the properties.parsers
		Node properties = findNode(doc, doc, "properties");
		if (properties == null)
			return null;

		Node parsers = findNode(doc, properties, "parsers");
		if (parsers == null)
			return null;

		// Get the list of parsers specified
		NodeList parserList = parsers.getChildNodes();

		// Walk the list
		for (int index = 0; index < parserList.getLength(); index++) {
			// Get the parser
			Node parser = parserList.item(index);

			// If this is not a parser entry, skip it
			if (parser.getLocalName() != "parser")
				continue;

			// Now walk each one and update it if needed
			Element parserElement = (Element) parser;
			if (parserElement.getAttribute("class").contentEquals(parserName))
				return parserElement;
		}

		return null;
	}

	/**
	 * Find or add a parser to the properties.parsers
	 * 
	 * @param doc        The parent document
	 * @param parserName The name of the parser (class=) attribute
	 */
	public static Node findOrAddParser(Document doc, String parserName) {
		// Get the properties.parsers
		Node properties = findOrAddNode(doc, doc, "properties");
		Node parsers = findOrAddNode(doc, properties, "parsers");

		// Find the parser to see if it is already there
		Element parser = (Element) findParser(doc, parserName);

		// If we do not have the parser, create it
		if (parser == null) {
			// Create the parser
			parser = doc.createElement("parser");
			parser.setAttribute("class", parserName);

			// And add it to the parameters
			parsers.appendChild(parser);
		}

		// Find the default parser entry if it exists
		Node defaultParser = findParser(doc, defaultParserName);

		// If we have a default parser entry
		if (defaultParser != null) {
			// Now, get the parser-excludes
			NodeList parserList = defaultParser.getChildNodes();

			// Walk the list to see if it specifies the parser we are adding
			for (int index = 0; index < parserList.getLength(); index++) {
				// Get the parser
				Node excludeParser = parserList.item(index);

				// If this is not a parser-exclude entry, skip it
				if (excludeParser.getLocalName() != "parser-exclude")
					continue;

				// If this is excluding the target parser we are creating, remove it
				Element parserElement = (Element) excludeParser;
				if (parserElement.getAttribute("class").contentEquals(parserName)) {
					defaultParser.removeChild(excludeParser);
				}
			}
		}

		return parser;
	}

	/**
	 * Remove the parser entry and add it to the parser-exclude list of the default parser
	 * 
	 * @param doc        The parent document
	 * @param parserName The name of the parser (class=) attribute
	 */
	public static void removeParser(Document doc, String parserName) {
		// Get the properties.parsers - we will need these either way
		Node properties = findOrAddNode(doc, doc, "properties");
		Node parsers = findOrAddNode(doc, properties, "parsers");

		// If the parse exists, remove it
		Element parser = (Element) findParser(doc, parserName);
		if (parser != null)
			parsers.removeChild(parser);

		// Find or add the default parser entry
		Node defaultParser = findOrAddParser(doc, defaultParserName);

		// Now, get the parser-excludes
		NodeList parserList = defaultParser.getChildNodes();

		// Walk the list
		for (int index = 0; index < parserList.getLength(); index++) {
			// Get the parser
			Node excludeParser = parserList.item(index);

			// If this is not a parser-exclude entry, skip it
			if (excludeParser.getLocalName() != "parser-exclude")
				continue;

			// If this is excluding the target parser we re removing, done
			Element parserElement = (Element) excludeParser;
			if (parserElement.getAttribute("class").contentEquals(parserName))
				return;
		}

		// Doesn't have the parser excluded, se create an entry to exclude it
		parser = doc.createElement("parser-exclude");
		parser.setAttribute("class", parserName);

		// And add it to the parameters
		defaultParser.appendChild(parser);
	}

	/**
	 * Set a parameter in a parser entry
	 * 
	 * @param doc    The parent document
	 * @param parent The parser node
	 * @param name   The name of the value to set
	 * @param type   The type of the value
	 * @param value  The value to set
	 */
	public static void setParam(Document doc, Node parent, String name, String type, String value) {
		NodeList childList = parent.getChildNodes();

		// Look for this parameter
		for (int index = 0; index < childList.getLength(); index++) {
			// Get the child and see if it is a param tag
			Node child = childList.item(index);
			if (child.getLocalName() != "param")
				continue;

			// Yep, get it as an element
			Element param = (Element) child;

			// If this is the element we are looking for
			if (param.getAttribute("name").contentEquals(name)) {
				// Sets its value
				setNodeValue(doc, param, value);
				return;
			}
		}

		// Doesn't have the parameter, we need to create it
		Element param = doc.createElement("param");
		param.setAttribute("name", name);
		param.setAttribute("type", type);
		setNodeValue(doc, param, value);

		// And add it to the parameters
		parent.appendChild(param);
	}

	/**
	 * Get a parameter value in a parser entry
	 * 
	 * @param doc    The parent document
	 * @param parent The parser node
	 * @param name   The name of the value to set
	 * @param type   The type of the value
	 */
	public static String getParam(Document doc, Node parent, String name, String type) {
		NodeList childList = parent.getChildNodes();

		// Look for this parameter
		for (int index = 0; index < childList.getLength(); index++) {
			// Get the child and see if it is a param tag
			Node child = childList.item(index);
			if (child.getLocalName() != "param")
				continue;

			// Yep, get it as an element
			Element param = (Element) child;

			// If this is the element we are looking for
			if (param.getAttribute("name").contentEquals(name)) {
				// Return its value
				return getNodeValue(doc, param);
			}
		}

		// No value
		return null;
	}

	/**
	 * Remove a parameter from a parser entry
	 * 
	 * @param doc    The parent document
	 * @param parent The parser node
	 * @param name   The name of the value to set
	 */
	public static void removeParam(Document doc, Node parent, String name) {
		NodeList childList = parent.getChildNodes();

		// Look for this parameter
		for (int index = 0; index < childList.getLength(); index++) {
			// Get the child and see if it is a param tag
			Node child = childList.item(index);
			if (child.getLocalName() != "param")
				continue;

			// Yep, get it as an element
			Element param = (Element) child;

			// If this is the element we are lookinf for
			if (param.getAttribute("name").contentEquals(name)) {
				parent.removeChild(child);
				return;
			}
		}
	}

	/**
	 * Pretty print the xml we created
	 * 
	 * @param doc    The parent document
	 * @param indent The number of spaces to indent
	 */
	public static String xmlToString(Document doc, int indent) {
		try {
			// Remove whitespaces outside tags
			doc.normalize();
			XPath xPath = XPathFactory.newInstance().newXPath();
			NodeList nodeList = (NodeList) xPath.evaluate("//text()[normalize-space()='']", doc,
					XPathConstants.NODESET);

			for (int i = 0; i < nodeList.getLength(); ++i) {
				Node node = nodeList.item(i);
				node.getParentNode().removeChild(node);
			}

			// Setup pretty print options
			TransformerFactory transformerFactory = TransformerFactory.newInstance();
			transformerFactory.setAttribute("indent-number", indent);
			Transformer transformer = transformerFactory.newTransformer();
			transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
			transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes");
			transformer.setOutputProperty(OutputKeys.INDENT, "yes");

			// Return pretty print xml string
			StringWriter stringWriter = new StringWriter();
			transformer.transform(new DOMSource(doc), new StreamResult(stringWriter));
			return stringWriter.toString();
		} catch (Exception e) {
			throw new RuntimeException(e);
		}
	}

	/**
	 * Returns the Tika configuration loaded from the tika-config.xml file located
	 * at the root path of the TikaApi.
	 *
	 * @return the TikaConfig instance containing the configuration loaded from the
	 *         tika-config.xml file.
	 * @throws TikaException                if there is an error loading the
	 *                                      configuration.
	 * @throws ParserConfigurationException if there is an error creating the
	 *                                      document builder for the configuration
	 *                                      file.
	 * @throws SAXException                 if there is an error parsing the
	 *                                      configuration file.
	 * @throws IOException                  if there is an error reading the
	 *                                      configuration file.
	 */
	public static TikaConfig getConfig() throws TikaException, ParserConfigurationException, SAXException, IOException {
		// Setup the tika-config.xml file name
		String tikaConfigPath = TikaApi.rootPath + "/tika-config.xml";

		// Get a builder factory with name space awareness so DOM level 2/3
		DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
		dbf.setNamespaceAware(true);

		// Get document buildrer
		DocumentBuilder db = dbf.newDocumentBuilder();

		// Load and parse the file
		Document doc = db.parse(new File(tikaConfigPath));

		// Get the properties.parsers - we will need these either way
		Node properties = findNode(doc, doc, "properties");
		Node lang = findNode(doc, properties, "languages");

		// Grab the languages
		if (lang != null)
			languages = getParam(doc, lang, "languages", "string");
		
		removeParser(doc, "org.apache.tika.parser.ocr.TesseractOCRParser"); // Explicitely removed it, otherwise it will throw error

		// Output the xml
		logger.debug(xmlToString(doc, 4));
							   
		// Create the configuration
		TikaConfig tikaConfig = new TikaConfig(doc);
													
		// And return it
		return tikaConfig;
	}
}

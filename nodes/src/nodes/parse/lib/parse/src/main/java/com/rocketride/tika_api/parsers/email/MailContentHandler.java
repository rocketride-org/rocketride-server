/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.rocketride.tika_api.parsers.email;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Map.Entry;
import java.util.Stack;

import org.apache.commons.io.IOUtils;
import org.apache.commons.io.input.UnsynchronizedByteArrayInputStream;
import org.apache.commons.io.output.UnsynchronizedByteArrayOutputStream;
import org.apache.james.mime4j.MimeException;
import org.apache.james.mime4j.codec.DecodeMonitor;
import org.apache.james.mime4j.codec.DecoderUtil;
import org.apache.james.mime4j.dom.address.Address;
import org.apache.james.mime4j.dom.address.AddressList;
import org.apache.james.mime4j.dom.address.Mailbox;
import org.apache.james.mime4j.dom.address.MailboxList;
import org.apache.james.mime4j.dom.field.AddressListField;
import org.apache.james.mime4j.dom.field.MailboxListField;
import org.apache.james.mime4j.dom.field.ParsedField;
import org.apache.james.mime4j.dom.field.UnstructuredField;
import org.apache.james.mime4j.field.LenientFieldParser;
import org.apache.james.mime4j.message.MaximalBodyDescriptor;
import org.apache.james.mime4j.parser.ContentHandler;
import org.apache.james.mime4j.stream.BodyDescriptor;
import org.apache.james.mime4j.stream.Field;
import org.xml.sax.SAXException;

import org.apache.tika.detect.Detector;
import org.apache.tika.exception.TikaException;
import org.apache.tika.extractor.EmbeddedDocumentExtractor;
import org.apache.tika.extractor.EmbeddedDocumentUtil;
import org.apache.tika.io.TikaInputStream;
import org.apache.tika.metadata.Message;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.metadata.Property;
import org.apache.tika.metadata.TikaCoreProperties;
import org.apache.tika.mime.MediaType;
import org.apache.tika.parser.ParseContext;
import org.apache.tika.parser.Parser;
import org.apache.tika.parser.csv.TextAndCSVParser;
import org.apache.tika.parser.html.JSoupParser;
import org.apache.tika.parser.mailcommons.MailDateParser;
import org.apache.tika.parser.mailcommons.MailUtil;
import org.apache.tika.parser.txt.TXTParser;
import org.apache.tika.sax.BodyContentHandler;
import org.apache.tika.sax.EmbeddedContentHandler;
import org.apache.tika.sax.XHTMLContentHandler;

/**
 * Bridge between mime4j's content handler and the generic Sax content handler
 * used by Tika. See
 * http://james.apache.org/mime4j/apidocs/org/apache/james/mime4j/parser/ContentHandler.html
 */
class MailContentHandler implements ContentHandler {

    //TODO -- specific handling for other multipart subtypes?  mixed, parallel, digest
    private static final String MULTIPART_ALTERNATIVE = "multipart/alternative";

    private final XHTMLContentHandler handler;
    private final Metadata metadata;
    private final ParseContext parseContext;
    private final boolean extractAllAlternatives;
    private final EmbeddedDocumentExtractor extractor;
    private final Detector detector;
    private boolean strictParsing = false;
    //this is used to buffer a multipart body that
    //keeps track of multipart/alternative and its children
    private Stack<Part> alternativePartBuffer = new Stack<>();
    private Stack<BodyDescriptor> parts = new Stack<>();
    MailContentHandler(XHTMLContentHandler xhtml, Detector detector, Metadata metadata,
                       ParseContext context, boolean strictParsing,
                       boolean extractAllAlternatives) {
        this.handler = xhtml;
        this.metadata = metadata;
        this.parseContext = context;
        this.strictParsing = strictParsing;
        this.extractAllAlternatives = extractAllAlternatives;

        // Fetch / Build an EmbeddedDocumentExtractor with which
        //  to handle/process the parts/attachments

        // Was an EmbeddedDocumentExtractor explicitly supplied?
        this.extractor = EmbeddedDocumentUtil.getEmbeddedDocumentExtractor(context);
        this.detector = detector;
    }

    @Override
    public void body(BodyDescriptor body, InputStream is) throws MimeException, IOException {
        // use a different metadata object
        // in order to specify the mime type of the
        // sub part without damaging the main metadata

        Metadata submd = new Metadata();
        submd.set(Metadata.CONTENT_TYPE, body.getMimeType());
        submd.set(Metadata.CONTENT_ENCODING, body.getCharset());

        // TIKA-2455: flag the containing type.
        if (parts.size() > 0) {
            submd.set(Message.MULTIPART_SUBTYPE, parts.peek().getSubType());
            submd.set(Message.MULTIPART_BOUNDARY, parts.peek().getBoundary());
        }
        if (body instanceof MaximalBodyDescriptor) {
            handleMaximalBodyDescriptor((MaximalBodyDescriptor)body, submd);
        }
        //if we're in a multipart/alternative or any one of its children
        //add the bodypart to the latest that was added
        if (!extractAllAlternatives && alternativePartBuffer.size() > 0) {
            UnsynchronizedByteArrayOutputStream bos = UnsynchronizedByteArrayOutputStream.builder().get();
            IOUtils.copy(is, bos);
            alternativePartBuffer.peek().children.add(new BodyContents(submd, bos.toByteArray()));
        } else if (!extractAllAlternatives && parts.size() < 2) {
            //if you're at the first level of embedding
            //and you're not in an alternative part block
            //and you're text/html, put that in the body of the email
            //otherwise treat as a regular attachment
            UnsynchronizedByteArrayOutputStream bos = UnsynchronizedByteArrayOutputStream.builder().get();
            IOUtils.copy(is, bos);
            final byte[] bytes = bos.toByteArray();
            if (detectInlineTextOrHtml(submd, bytes)) {
                handleInlineBodyPart(new BodyContents(submd, bytes));
            } else {
                //else handle as you would any other embedded content
                try (TikaInputStream tis = TikaInputStream.get(bytes)) {
                    handleEmbedded(tis, submd);
                }
            }
        } else {
            //else handle as you would any other embedded content
            try (TikaInputStream tis = TikaInputStream.get(is)) {
                handleEmbedded(tis, submd);
            }
        }
    }

    private void handleMaximalBodyDescriptor(MaximalBodyDescriptor body, Metadata submd) {
        String contentDispositionType = body.getContentDispositionType();
        if (contentDispositionType != null && !contentDispositionType.isEmpty()) {
            StringBuilder contentDisposition = new StringBuilder(contentDispositionType);
            if ("attachment".equalsIgnoreCase(contentDispositionType)) {
                submd.set(TikaCoreProperties.EMBEDDED_RESOURCE_TYPE,
                        TikaCoreProperties.EmbeddedResourceType.ATTACHMENT.toString());
            } else if ("inline".equalsIgnoreCase(contentDispositionType)) {
                submd.set(TikaCoreProperties.EMBEDDED_RESOURCE_TYPE,
                        TikaCoreProperties.EmbeddedResourceType.INLINE.toString());
            }
            Map<String, String> contentDispositionParameters =
                    body.getContentDispositionParameters();
            for (Entry<String, String> param : contentDispositionParameters.entrySet()) {
                contentDisposition.append("; ").append(param.getKey()).append("=\"")
                        .append(param.getValue()).append('"');
                if ("creation-date".equalsIgnoreCase(param.getKey())) {
                    tryToAddDate(param.getValue(), TikaCoreProperties.CREATED, submd);
                } else if ("modification-date".equalsIgnoreCase(param.getKey())) {
                    tryToAddDate(param.getValue(), TikaCoreProperties.MODIFIED, submd);
                }
                //do anything with "size"?
            }

            String contentDispositionFileName = body.getContentDispositionFilename();
            if (contentDispositionFileName != null) {
                submd.set(TikaCoreProperties.RESOURCE_NAME_KEY, contentDispositionFileName);
            }
            submd.set(Metadata.CONTENT_DISPOSITION, contentDisposition.toString());
        }
    }

    private void tryToAddDate(String value, Property property, Metadata metadata) {
        Date d = MailDateParser.parseDateLenient(value);
        if (d != null) {
            metadata.set(property, d);
        }
    }

    private boolean detectInlineTextOrHtml(Metadata submd, byte[] bytes) {
        String attachmentType = submd.get(TikaCoreProperties.EMBEDDED_RESOURCE_TYPE);
        if (TikaCoreProperties.EmbeddedResourceType.ATTACHMENT.toString().equals(attachmentType)) {
            return false;
        }

        String mediaTypeString = submd.get(Metadata.CONTENT_TYPE);
        if (mediaTypeString != null) {
            if (mediaTypeString.startsWith("text")) {
                return true;
            } else {
                return false;
            }
        }

        try (TikaInputStream tis = TikaInputStream.get(bytes)) {
            MediaType mediaType = detector.detect(tis, submd);
            if (mediaType != null) {
                //detect only once
                submd.set(TikaCoreProperties.CONTENT_TYPE_PARSER_OVERRIDE, mediaType.toString());
                if (mediaType.toString().startsWith("text")) {
                    return true;
                }
            }
        } catch (IOException e) {
            //swallow
        }
        return false;
    }

    private void handleEmbedded(TikaInputStream tis, Metadata metadata)
            throws MimeException, IOException {

        if (metadata.get(TikaCoreProperties.EMBEDDED_RESOURCE_TYPE) == null) {
            metadata.set(TikaCoreProperties.EMBEDDED_RESOURCE_TYPE,
                    TikaCoreProperties.EmbeddedResourceType.ATTACHMENT.toString());
        }

        try {
            if (extractor.shouldParseEmbedded(metadata)) {
                // Wrap the InputStream before passing on, as the James provided
                //  one misses many features we might want eg mark/reset
                extractor.parseEmbedded(tis, handler, metadata, false);
            }
        } catch (SAXException e) {
            throw new MimeException(e);
        }

    }

    @Override
    public void endBodyPart() throws MimeException {
        //if we're buffering for a multipart/alternative
        //don't write </p></div>
        if (alternativePartBuffer.size() > 0) {
            return;
        }
        try {
            handler.endElement("p");
            handler.endElement("div");
        } catch (SAXException e) {
            throw new MimeException(e);
        }
    }

    @Override
    public void endHeader() throws MimeException {
    }

    @Override
    public void startMessage() throws MimeException {
    }

    @Override
    public void endMessage() throws MimeException {
    }

    @Override
    public void endMultipart() throws MimeException {

        if (alternativePartBuffer.size() == 1) {
            Part alternativeRoot = alternativePartBuffer.pop();
            try {
                handleBestParts(alternativeRoot);
            } catch (IOException e) {
                throw new MimeException(e);
            }
        } else if (alternativePartBuffer.size() > 1) {
            alternativePartBuffer.pop();
        }
        //test that parts has something
        //if it doesn't, there's a problem with the file
        //e.g. more endMultiPart than startMultipart
        //we're currently silently swallowing this
        if (parts.size() > 0) {
            parts.pop();
        }
    }

    @Override
    public void epilogue(InputStream is) throws MimeException, IOException {
    }

    /**
     * Header for the whole message or its parts
     *
     * @see <a href="http://james.apache.org/mime4j/apidocs/org/apache/james/mime4j/parser/">
     * http://james.apache.org/mime4j/apidocs/org/apache/james/mime4j/parser/</a>
     * Field.html
     */
    public void field(Field field) throws MimeException {

        // Forward the field as regular text so it's included in the final body
        try {
            handler.characters(field.toString() + "\n");
        }
        catch (SAXException e) {
            e.printStackTrace();
        }

        // if we're in a part, skip.
        // We want to gather only the metadata for the whole msg.
        if (parts.size() > 0) {
            return;
        }

        try {
            String fieldname = field.getName();

            ParsedField parsedField =
                    LenientFieldParser.getParser().parse(field, DecodeMonitor.SILENT);
            if (fieldname.equalsIgnoreCase("From")) {
                MailboxListField fromField = (MailboxListField) parsedField;
                MailboxList mailboxList = fromField.getMailboxList();
                if (fromField.isValidField() && mailboxList != null) {
                    for (Address address : mailboxList) {
                        String from = getDisplayString(address);
                        MailUtil.setPersonAndEmail(from, Message.MESSAGE_FROM_NAME,
                                Message.MESSAGE_FROM_EMAIL, metadata);
                        metadata.add(Metadata.MESSAGE_FROM, from);
                        metadata.add(TikaCoreProperties.CREATOR, from);
                    }
                } else {
                    String from = stripOutFieldPrefix(field, "From:");
                    MailUtil.setPersonAndEmail(from, Message.MESSAGE_FROM_NAME,
                            Message.MESSAGE_FROM_EMAIL, metadata);

                    if (from.startsWith("<")) {
                        from = from.substring(1);
                    }
                    if (from.endsWith(">")) {
                        from = from.substring(0, from.length() - 1);
                    }
                    metadata.add(Metadata.MESSAGE_FROM, from);
                    metadata.add(TikaCoreProperties.CREATOR, from);
                }
            } else if (fieldname.equalsIgnoreCase("Subject")) {
                metadata.set(TikaCoreProperties.TITLE,
                        ((UnstructuredField) parsedField).getValue());
                metadata.set(TikaCoreProperties.SUBJECT,
                        ((UnstructuredField) parsedField).getValue());
            } else if (fieldname.equalsIgnoreCase("To")) {
                processAddressList(parsedField, "To:", Metadata.MESSAGE_TO);
            } else if (fieldname.equalsIgnoreCase("CC")) {
                processAddressList(parsedField, "Cc:", Metadata.MESSAGE_CC);
            } else if (fieldname.equalsIgnoreCase("BCC")) {
                processAddressList(parsedField, "Bcc:", Metadata.MESSAGE_BCC);
            } else if (fieldname.equalsIgnoreCase("Content-Type")) {
                final MediaType contentType = MediaType.parse(parsedField.getBody());

                if (contentType.getType().equalsIgnoreCase("multipart")) {
                    metadata.set(Message.MULTIPART_SUBTYPE, contentType.getSubtype());
                    metadata.set(Message.MULTIPART_BOUNDARY,
                            contentType.getParameters().get("boundary"));
                } else {
                    metadata.add(Metadata.MESSAGE_RAW_HEADER_PREFIX + parsedField.getName(),
                            field.getBody());
                }
            } else if (fieldname.equalsIgnoreCase("Date")) {
                String dateBody = parsedField.getBody();
                Date date = null;
                try {
                    date = MailDateParser.parseDateLenient(dateBody);
                    metadata.set(TikaCoreProperties.CREATED, date);
                } catch (SecurityException e) {
                    throw e;
                } catch (Exception e) {
                    //swallow
                }
            } else {
                metadata.add(Metadata.MESSAGE_RAW_HEADER_PREFIX + parsedField.getName(),
                        field.getBody());
            }
        } catch (RuntimeException me) {
            if (strictParsing) {
                throw me;
            }
        }
    }

    private void processAddressList(ParsedField field, String addressListType, String metadataField)
            throws MimeException {
        AddressListField toField = (AddressListField) field;
        if (toField.isValidField()) {
            AddressList addressList = toField.getAddressList();
            for (Address address : addressList) {
                metadata.add(metadataField, getDisplayString(address));
            }
        } else {
            String to = stripOutFieldPrefix(field, addressListType);
            for (String eachTo : to.split(",")) {
                metadata.add(metadataField, eachTo.trim());
            }
        }
    }

    private String getDisplayString(Address address) {
        if (address instanceof Mailbox) {
            Mailbox mailbox = (Mailbox) address;
            String name = mailbox.getName();
            if (name != null && name.length() > 0) {
                name = DecoderUtil.decodeEncodedWords(name, DecodeMonitor.SILENT);
                return name + " <" + mailbox.getAddress() + ">";
            } else {
                return mailbox.getAddress();
            }
        } else {
            return address.toString();
        }
    }

    @Override
    public void preamble(InputStream is) throws MimeException, IOException {
    }

    @Override
    public void raw(InputStream is) throws MimeException, IOException {
    }

    @Override
    public void startBodyPart() throws MimeException {
        //if we're buffering for a multipart/alternative
        //don't write <div><p>
        if (alternativePartBuffer.size() > 0) {
            return;
        }
        try {
            handler.startElement("div", "class", "email-entry");
            handler.startElement("p");
        } catch (SAXException e) {
            throw new MimeException(e);
        }
    }

    @Override
    public void startHeader() throws MimeException {
        // TODO Auto-generated method stub

    }

    @Override
    public void startMultipart(BodyDescriptor descr) throws MimeException {
        parts.push(descr);
        if (!extractAllAlternatives) {
            if (alternativePartBuffer.size() == 0 &&
                    MULTIPART_ALTERNATIVE.equalsIgnoreCase(descr.getMimeType())) {
                Part part = new Part(descr);
                alternativePartBuffer.push(part);
            } else if (alternativePartBuffer.size() > 0) {
                //add the part to the stack
                Part parent = alternativePartBuffer.peek();
                Part part = new Part(descr);
                alternativePartBuffer.push(part);

                if (parent != null) {
                    parent.children.add(part);
                }
            }
        }
    }

    private String stripOutFieldPrefix(Field field, String fieldname) {
        String temp = field.getRaw().toString();
        int loc = fieldname.length();
        while (temp.charAt(loc) == ' ') {
            loc++;
        }
        return temp.substring(loc);
    }

    private void handleBestParts(Part part) throws MimeException, IOException {
        if (part == null) {
            return;
        }
        if (part instanceof BodyContents) {
            handleInlineBodyPart((BodyContents) part);
            return;
        }


        if (MULTIPART_ALTERNATIVE.equalsIgnoreCase(part.bodyDescriptor.getMimeType())) {
            int bestPartScore = -1;
            Part bestPart = null;
            for (Part alternative : part.children) {
                int score = score(alternative);
                if (score > bestPartScore) {
                    bestPart = alternative;
                    bestPartScore = score;
                }
            }
            handleBestParts(bestPart);
        } else {
            for (Part child : part.children) {
                handleBestParts(child);
            }
        }
    }

    private void handleInlineBodyPart(BodyContents part) throws MimeException, IOException {
        String contentType = part.metadata.get(Metadata.CONTENT_TYPE);
        Parser parser = null;
        boolean inlineText = false;
        if (MediaType.TEXT_HTML.toString().equalsIgnoreCase(contentType)) {
            // In Tika 3.x, HtmlParser has been renamed to JSoupParser
            parser = EmbeddedDocumentUtil
                    .tryToFindExistingLeafParser(JSoupParser.class, parseContext);
        } else if (MediaType.TEXT_PLAIN.toString().equalsIgnoreCase(contentType)) {
            parser =
                    EmbeddedDocumentUtil.tryToFindExistingLeafParser(TXTParser.class, parseContext);
            if (parser == null) {
                parser = EmbeddedDocumentUtil
                        .tryToFindExistingLeafParser(TextAndCSVParser.class, parseContext);
                inlineText = true;
            }
        }


        if (parser == null) {
            //back off and treat it as an embedded chunk
            try (TikaInputStream tis = TikaInputStream.get(part.bytes)) {
                handleEmbedded(tis, part.metadata);
            }
        } else {

            //parse inline
            try {
                Metadata inlineMetadata = new Metadata();
                if (inlineText) {
                    inlineMetadata.set(TikaCoreProperties.CONTENT_TYPE_PARSER_OVERRIDE,
                            MediaType.TEXT_PLAIN.toString());
                }
                parser.parse(UnsynchronizedByteArrayInputStream.builder().setByteArray(part.bytes).get(),
                        new EmbeddedContentHandler(new BodyContentHandler(handler)), inlineMetadata,
                        parseContext);
            } catch (SAXException | TikaException e) {
                throw new MimeException(e);
            }
        }
    }

    private int score(Part part) {
        if (part == null) {
            return 0;
        }
        if (part instanceof BodyContents) {
            String contentType = ((BodyContents) part).metadata.get(Metadata.CONTENT_TYPE);
            if (contentType == null) {
                return 0;
            } else if (contentType.equalsIgnoreCase(MediaType.TEXT_PLAIN.toString())) {
                return 1;
            } else if (contentType.equalsIgnoreCase("application/rtf")) {
                //TODO -- is this the right definition in rfc822 for rich text?!
                return 2;
            } else if (contentType.equalsIgnoreCase(MediaType.TEXT_HTML.toString())) {
                return 3;
            }
        }
        return 4;
    }

    private static class Part {
        private final BodyDescriptor bodyDescriptor;
        private final List<Part> children = new ArrayList<>();

        public Part(BodyDescriptor bodyDescriptor) {
            this.bodyDescriptor = bodyDescriptor;
        }

        @Override
        public String toString() {
            return "Part{" + "bodyDescriptor=" + bodyDescriptor + ", children=" + children + '}';
        }
    }

    private static class BodyContents extends Part {
        private final Metadata metadata;
        private final byte[] bytes;

        private BodyContents(Metadata metadata, byte[] bytes) {
            super(null);
            this.metadata = metadata;
            this.bytes = bytes;
        }
    }
}

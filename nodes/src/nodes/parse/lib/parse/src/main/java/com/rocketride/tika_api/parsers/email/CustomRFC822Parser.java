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
import java.util.Collections;

import org.apache.james.mime4j.MimeException;
import org.apache.james.mime4j.message.DefaultBodyDescriptorBuilder;
import org.apache.james.mime4j.parser.MimeStreamParser;
import org.apache.james.mime4j.stream.MimeConfig;
import org.apache.tika.config.Field;
import org.apache.tika.detect.Detector;
import org.apache.tika.exception.TikaException;
import org.apache.tika.extractor.EmbeddedDocumentUtil;
import org.apache.tika.io.TikaInputStream;
import org.apache.tika.mime.MediaType;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.parser.ParseContext;
import org.apache.tika.parser.Parser;
import org.apache.tika.sax.XHTMLContentHandler;

import org.xml.sax.ContentHandler;
import org.xml.sax.SAXException;

import java.util.Set;

import static com.rocketride.tika_api.TikaApi.MIME_TYPE_EMAIL;


public class CustomRFC822Parser implements Parser {
    
    private static final Set<MediaType> SUPPORTED_TYPES =
            Collections.singleton(MediaType.parse(MIME_TYPE_EMAIL));

    private Detector detector;

    @Field
    private boolean extractAllAlternatives = false;

    @Override
    public Set<MediaType> getSupportedTypes(ParseContext context) {
        return SUPPORTED_TYPES;
    }

    @Override
    public void parse(InputStream stream, ContentHandler handler, Metadata metadata, ParseContext context) 
        throws IOException, SAXException, TikaException {

        final int DEFAULT_MAX_LINE_LEN = 100000;
        final int DEFAULT_MAX_HEADER_LEN = 100000;

        // Get the mime4j configuration, or use a default one
        MimeConfig config = new MimeConfig.Builder()
                .setMaxLineLen(DEFAULT_MAX_LINE_LEN)
                .setMaxHeaderLen(DEFAULT_MAX_HEADER_LEN)
                .build();

        config = context.get(MimeConfig.class, config);
        Detector localDetector = context.get(Detector.class);
        if (localDetector == null) {
            //lazily load this if necessary
            if (detector == null) {
                EmbeddedDocumentUtil embeddedDocumentUtil = new EmbeddedDocumentUtil(context);
                detector = embeddedDocumentUtil.getDetector();
            }
            localDetector = detector;
        }
        MimeStreamParser parser = new MimeStreamParser(config, null, new DefaultBodyDescriptorBuilder());
        XHTMLContentHandler xhtml = new XHTMLContentHandler(handler, metadata);

        MailContentHandler mch = new MailContentHandler(xhtml, localDetector, metadata, context, config.isStrictParsing(), extractAllAlternatives);
        
        parser.setContentHandler(mch);
        parser.setContentDecoding(true);
        parser.setNoRecurse();
        xhtml.startDocument();
        
        TikaInputStream tstream = TikaInputStream.get(stream);

        try {
            parser.parse(tstream);
        } catch (IOException e) {
            tstream.throwIfCauseOf(e);
            throw new TikaException("Failed to parse an email message", e);
        } catch (MimeException e) {
            // Unwrap the exception in case it was not thrown by mime4j
            Throwable cause = e.getCause();
            if (cause instanceof TikaException) {
                throw (TikaException) cause;
            } else if (cause instanceof SAXException) {
                throw (SAXException) cause;
            } else {
                throw new TikaException("Failed to parse an email message", e);
            }
        }
        xhtml.endDocument();
    }

    /**
     * Until version 1.17, Tika handled all body parts as embedded objects (see TIKA-2478).
     * In 1.17, we modified the parser to select only the best alternative body
     * parts for multipart/alternative sections, and we inline the content
     * as we do for .msg files.
     * <p>
     * The legacy behavior can be set by setting {@link #extractAllAlternatives}
     * to <code>true</code>.  As of 1.17, the default value is <code>false</code>
     *
     * @param extractAllAlternatives whether or not to extract all alternative parts
     * @since 1.17
     */
    public void setExtractAllAlternatives(boolean extractAllAlternatives) {
        this.extractAllAlternatives = extractAllAlternatives;
    }
}

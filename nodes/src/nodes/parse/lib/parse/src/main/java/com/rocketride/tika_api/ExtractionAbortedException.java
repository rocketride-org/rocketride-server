package com.rocketride.tika_api;

import org.xml.sax.SAXException;

public class ExtractionAbortedException extends SAXException {
    public ExtractionAbortedException(String message) {
        super(message);
    }
}

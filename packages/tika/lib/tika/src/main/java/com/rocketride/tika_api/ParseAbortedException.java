package com.rocketride.tika_api;

import java.io.IOException;

public class ParseAbortedException extends IOException {
    public ParseAbortedException() {
        super("Parse aborted");
    }
}
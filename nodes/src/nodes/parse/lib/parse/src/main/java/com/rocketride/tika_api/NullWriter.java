package com.rocketride.tika_api;

import java.io.IOException;

public class NullWriter extends java.io.Writer {
    @Override
    public void write(char cbuf[], int off, int len) throws IOException {
        // Do nothing
    }
    
    @Override
    public void flush() throws IOException {
        // Do nothing
    }

    @Override
    public void close() throws IOException {
        // Do nothing
    }
}

package com.rocketride;

import java.io.IOException;
import java.util.Objects;

public class LogStream extends java.io.OutputStream {
    @Override
    public void write(int b) throws IOException {
        Logging.log(Integer.toString(b));
    }

    @Override
    public void write(byte b[]) throws IOException {
        Logging.log(b.toString());
    }

    @Override
    public void write(byte b[], int off, int len) throws IOException {
        Objects.checkFromIndexSize(off, len, b.length);
        Logging.log(new String(b, off, len));
    }
}

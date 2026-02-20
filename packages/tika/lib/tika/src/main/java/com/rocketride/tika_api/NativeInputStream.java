package com.rocketride.tika_api;

import com.rocketride.*;
import java.io.IOException;
import java.util.Objects;
import org.apache.log4j.Logger;

public class NativeInputStream extends java.io.InputStream {
    private static Logger logger = Logger.getLogger(NativeInputStream.class);

    private long nativeHandle;
    private byte[] buffer;
    // We should be fine leaving bufferLength & bufferOffset
    // as int since the max size of buffer should be less than
    // MAX_INT_VAL (2^31-1) 
    private int bufferLength;
    private int bufferOffset;
    private long fileOffset;
    private long markedOffset;
    private long fileLength;
    
    public NativeInputStream(long nativeHandle) {
        this.nativeHandle = nativeHandle;
        // Create a buffer with a capacity of 8 MB
        this.buffer = new byte[1024 * 1024 * 8];
        this.bufferLength = 0;
        this.bufferOffset = 0;
        this.fileOffset = 0;
        this.markedOffset = -1;
        this.fileLength = -1;
    }

    @Override
    public int available() throws IOException {
        return bufferLength - bufferOffset;
    }

    // The offset within the file of the start of the buffer
    private long fileOffsetOfBuffer() {
        return fileOffset - (long)bufferLength;
    }

    private void invalidateBuffer() {
        bufferLength = 0;
        bufferOffset = 0;
    }    
    
    // Our absolute position within the file
    private long tell() {
        return fileOffsetOfBuffer() + (long)bufferOffset;
    }

    // Move to an absolute position within the file
    private void seek(long offset) {
        // If we know the file length, bound the offset
        if (fileLength != -1)
            offset = Math.min(offset, fileLength);

        // Is the offset within the currently loaded buffer?
        if (offset >= fileOffsetOfBuffer() && offset < fileOffset) {
            // Yes -- just adjust the buffer offset
            long newOffset = offset - fileOffsetOfBuffer();
            Core.Assert(newOffset < (long)Integer.MAX_VALUE, "Buffer offset overflow");
            bufferOffset = (int)(newOffset);
        }
        else {
            // No-- reposition the file offset and invalidate the buffer so we start reading from that new offset
            fileOffset = offset;
            invalidateBuffer();
        }
    }

    @Override
    public int read() throws IOException {
        if (available() == 0 && !readFromNativeStream())
            return -1;

        // Mask the byte or we get gibberish
        return buffer[bufferOffset++] & 0xff;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        Objects.checkFromIndexSize(off, len, b.length);
        if (len == 0)
            return 0;

        if (available() == 0 && !readFromNativeStream())
            return -1;            

        int bytesRead = Math.min(available(), len);
        System.arraycopy(buffer, bufferOffset, b, off, bytesRead);
        bufferOffset += bytesRead;
        return bytesRead;
    }

    boolean readFromNativeStream() throws IOException {
        // We should have emptied our buffer before reading more
        Core.Assert(available() == 0, "Reading from native stream prematurely");

        // Check whether we've already read to the end of the file
        if (fileLength != -1 && fileOffset == fileLength)
            return false;

        // Read from the native stream
        int read = TikaApi.readFromInputStream(nativeHandle, fileOffset, buffer, buffer.length);
        // A length of -1 indicates an error, but that should be handled within TikaApi.readFromInputStream
        Core.Assert(read >= 0, "Unexpected result from readFromInputStream");

        if (read > 0) {
            // Adjust the file offset based on what we read and reset the buffer offset
            fileOffset += (long)read;
            bufferLength = read;
            bufferOffset = 0;
            return true;
        }
        else {
            // Record the file length so we can avoid invoking JNI again if Tika hops around the file
            fileLength = fileOffset;
            return false;
        }
    }

    @Override
    public long skip(long n) throws IOException {
        long position = tell();
        seek(position + n);
        return tell() - position;
    }

    @Override
    public boolean markSupported() {
        // Supporting mark isn't that complicated because our native streams support fseek
        return true;
    }

    @Override
    public synchronized void mark(int readlimit) {
        // Record our current offset
        markedOffset = tell();
    }

    @Override
    public synchronized void reset() throws IOException {
        // If a mark isn't set, just rewind
        if (markedOffset == -1) {
            long offset = tell();
            if (offset != 0) {
                logger.error("reset called with no mark set while at offset " + offset);
                seek(0);
            }
            else
                logger.warn("reset called with no mark set while at offset 0");
        }
        else {
            seek(markedOffset);
            markedOffset = -1;
        }
    }
}



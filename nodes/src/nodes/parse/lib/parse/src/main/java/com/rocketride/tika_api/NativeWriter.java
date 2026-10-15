package com.rocketride.tika_api;

import com.rocketride.*;
import java.io.IOException;
import java.util.Objects;
import org.apache.log4j.Logger;

public class NativeWriter extends java.io.Writer {
    private static Logger logger = Logger.getLogger(NativeWriter.class);
    private long nativeHandle = 0;
    private char[] buffer = new char[1024 * 1024];
    private int length = 0;

    public NativeWriter(long nativeHandle) {
        this.nativeHandle = nativeHandle;
    }

    public NativeWriter() {
    }

    public long getNativeHandle() {
        return nativeHandle;
    }

    public void setNativeHandle(long nativeHandle) {
        // Don't allow updating the native handle after we've already started text extraction
        Core.Assert(length == 0, "Native handle has already been written to and cannot be updated");
        this.nativeHandle = nativeHandle;
    }

    private int capacity() {
        return buffer.length - length;
    }

    private void checkNativeHandle() throws IOException {
        if (nativeHandle == 0)
            throw new IOException("NativeWriter has no native handle to write to");
    }
    
    @Override
    public void write(char cbuf[], int off, int len) throws IOException {
		Objects.checkFromIndexSize(off, len, cbuf.length);
        checkNativeHandle();
        
        // If the data is larger than our buffer's capacity, flush it
        if (len > capacity()) {
			// Flush the data we have in the buffer
            flush(false);

            // Our buffer should be empty now; if the data is still larger than our capacity, it must be larger than
            // 1 MB-- just send it directly to native
            if (len > capacity()) {
                onTextExtracted(this.nativeHandle, cbuf, off, len, false);
                return;
            }
        } 
            
        // Append to our buffer
        System.arraycopy(cbuf, off, buffer, length, len);
        length += len;
    }
    
    @Override
    public void flush() throws IOException {
       flush(true);
    }

    private void flush(boolean isFinal) throws IOException {
        checkNativeHandle();

        // If the buffer is empty, do nothing
        if (length == 0)
            return;

        // Send the buffer to native and mark it empty
        onTextExtracted(this.nativeHandle, buffer, 0, length, isFinal);
        length = 0;
    }

    private static void onTextExtracted(long nativeHandle, char text[], int offset, int length, boolean isFinal) throws IOException {
        try {
            if (!TikaApi.onTextExtracted(nativeHandle, text, offset, length, isFinal)) {
                logger.warn("onTextExtracted callback returned false");
                throw new ParseAbortedException();    
            }
        }
        catch (NativeError e) {
            throw new IOException("Native onTextExtracted callback failed", e);
        }
	}

    private static void onTableExtracted(long nativeHandle, char text[], int offset, int length, boolean isFinal) throws IOException {
        try {
            if (!TikaApi.onTableExtracted(nativeHandle, text, offset, length, isFinal)) {
                logger.warn("onTableExtracted callback returned false");
                throw new ParseAbortedException();    
            }
        }
        catch (NativeError e) {
            throw new IOException("Native onTableExtracted callback failed", e);
        }
	}

    @Override
    public void close() throws IOException {
        try {
            // Make sure all content is written to native
            flush();
        }
        finally {
            // Reset the native handle so that anything trying to use this object to write after it's been closed will throw
            this.nativeHandle = 0;
        }
   }
}

package com.rocketride;

import java.io.OutputStream;
import java.io.PrintStream;

import org.apache.log4j.PatternLayout;
import org.apache.log4j.Level;
import org.apache.log4j.Logger;
import org.apache.log4j.LogManager;
import org.apache.log4j.WriterAppender;

public final class Logging {
    public static boolean redirectStandardStreamsToNative = true;
    private static Level logLevel = null;

    // From engLib/engLib/java/Logging.hpp
    public enum NativeLogLevel {
		FATAL,
		ERROR,
		WARN,
		INFO,
		DEBUG,
		TRACE
	}

    private static native void logCallback(String text);

    // Prevent construction of instances of this class
    private Logging() {
    }

    public static void log(String text) {
        // Log4j should be suppressing any unwanted logging, so just forward the call to JNI
        logCallback(text);
    }    

    public static void init(Level logLevel) {
        // If writing to stdout/stderr has been disabled, log to native via callback
        OutputStream logStream;
        if (redirectStandardStreamsToNative)
            logStream = new LogStream();
        else
            logStream = System.out;
        configureLog4j(logLevel, logStream);

        // Disable stdout and stderr to stop Tika from leaking exceptions (if indicated)
        if (redirectStandardStreamsToNative) {
            System.setOut(new PrintStream(new LogStream()));
            System.setErr(new PrintStream(new LogStream()));
        }
    }

    // Set log level as an int (JNI helper)
    public static void init(int nativeLogLevel) {
        Core.Assert(nativeLogLevel >= 0 && nativeLogLevel <= NativeLogLevel.values().length, "Invalid log level: " + nativeLogLevel);
        // Convert from the native log level to a log4j level
        Level log4jLevel = toLog4jLevel(NativeLogLevel.values()[nativeLogLevel]);
        init(log4jLevel);
    }

    public static Level getLogLevel() {
        return logLevel;
    }
    
    // Log a message of each possible level and write to stdout and stderr [APPLAT-1506]
    public static void testMonitor() {
        // Emit log messages in descending order of severity
        Logger logger = Logger.getLogger(Logging.class);
        for (NativeLogLevel nativeLevel : NativeLogLevel.values()) {
            logger.log(toLog4jLevel(nativeLevel), "Testing Java logging with severity " + nativeLevel);
        }
        
        // Write to stdout and stderr
        System.out.println("Testing writing to stdout from Java");
        System.err.println("Testing writing to stderr from Java");
    }

    private static void configureLog4j(Level level, OutputStream stream) {
        // Discard any existing configuration
        LogManager.resetConfiguration();
       
        /* These settings are the runtime equivalent of tika-bundle\src\test\resources\log4j.properties:

            log4j.rootLogger=info,stderr

            #console
            log4j.appender.stderr=org.apache.log4j.ConsoleAppender
            log4j.appender.stderr.layout=org.apache.log4j.PatternLayout
            log4j.appender.stderr.Target=System.err

            log4j.appender.stderr.layout.ConversionPattern= %-5p %m%n
        */
        
        Logger rootLogger = Logger.getRootLogger();
        rootLogger.setLevel(level);
        PatternLayout layout = new PatternLayout("%-5p %m%n");
        WriterAppender appender = new WriterAppender(layout, stream);
        
        rootLogger.addAppender(appender);
    }

    private static Level toLog4jLevel(NativeLogLevel value) {
        switch (value) {
            case FATAL:
                return Level.FATAL;
            case ERROR:
                return Level.ERROR;
            case WARN:
                return Level.WARN;
            case INFO:
                return Level.INFO;
            case DEBUG:
                return Level.DEBUG;
            case TRACE:
                return Level.TRACE;
            default:
                return Level.INFO;
        }
    }
}

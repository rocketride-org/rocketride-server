package com.rocketride;

import org.apache.log4j.Logger;

public final class Core {
    private static Logger logger = Logger.getLogger(System.class);

    // Prevent construction of instances of this class
    private Core() {
    }

    public static String renderStackTrace(String callingMethodName) {
        StringBuilder sb = new StringBuilder();
        StackTraceElement[] stackTrace = Thread.currentThread().getStackTrace();
        
        // Skip the 2 topmost calls, which will be java.lang.Thread.getStackTrace and this function
        int i = 2;

        // If the caller specified a jumping-off point, advanced until we get past the indicated element
        if (!callingMethodName.isEmpty()) {
            for (int j = i; j < stackTrace.length; j++) {
                if (stackTrace[i].getMethodName() == callingMethodName) {
                    i = j + 1;
                    break;
                }
            }
        }

        // Build the stack trace
        for (; i < stackTrace.length; i++) {
            if (sb.length() > 0)
                sb.append("\n");
            sb.append(stackTrace[i]);
        }
        return sb.toString();
    }

    public static void fatal(String message) {
        logger.fatal(message);
        // We can get this using reflection, but meh
        logger.fatal(renderStackTrace("Fatal"));
        System.exit(1);
    }
    
    // assert() in Java is disabled by default, so provide our own always-on version
    // "assert" is also a keyword, so we have to name the function something different
    public static void Assert(boolean expressionResult, String message) {
        if (!expressionResult)
            fatal("Assertion failed: " + message);
    }
}
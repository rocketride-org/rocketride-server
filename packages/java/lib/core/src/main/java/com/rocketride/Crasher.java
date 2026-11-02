package com.rocketride;

import java.lang.reflect.Field;
import sun.misc.Unsafe;

import org.apache.log4j.Logger;

// Utility class for forcing crashes within the JVM
public class Crasher {
    private static Logger logger = Logger.getLogger(Crasher.class);

    // Force the JVM to crash
    // From https://stackoverflow.com/a/1378388
    public static void crash() throws Exception {
        Field f = Unsafe.class.getDeclaredField("theUnsafe");
        f.setAccessible(true);
        Unsafe unsafe = (Unsafe) f.get(null);
        logger.fatal("Crashing self: wheeeeee!");
        unsafe.putAddress(0, 0);        
    }
}

package com.rocketride.tika_api;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Iterator;
import java.util.LinkedHashSet;

import org.apache.log4j.Logger;

class DeleteTemporaryFilesTask implements Runnable {
    private static Logger logger = Logger.getLogger(DeleteTemporaryFilesTask.class);

    @Override
    @SuppressWarnings("unchecked")
    public void run() {
        try {
            // Use reflection to access the private DeleteOnExitHook class and its static files member 
            Class<?> deleteOnExitHookClass = Class.forName("java.io.DeleteOnExitHook");
            Field filesField = deleteOnExitHookClass.getDeclaredField("files");
            filesField.setAccessible(true);

            // Synchronize on the DeleteOnExitHook class, just as it does when executing the hook
            synchronized (deleteOnExitHookClass) {
                // Access the list of files that will be deleted when the JVM exits
                LinkedHashSet<String> pendingDeletes = (LinkedHashSet<String>)filesField.get(null);
                
                // Iterate the list of pending deletions, deleting what we can and removing successfully deleted paths
                // from the list
                Iterator<String> it = pendingDeletes.iterator();
                while (it.hasNext()) {
                    String path = it.next();
                    try {
                        Files.delete(Paths.get(path));
                        it.remove();
                        logger.trace("Deleted temporary file: " + path);
                    }
                    catch (Exception e) {
                        logger.debug("Failed to delete temporary file: " + path, e);
                    }
                }
            }
        }
        catch (Exception e) {
            logger.debug("Failed to execute DeleteTemporaryFilesTask", e);
        }
    }    
}

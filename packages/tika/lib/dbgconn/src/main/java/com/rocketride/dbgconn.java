/**
 * Engine debug support 
 */

package com.rocketride;

public final class dbgconn {
	/**
	 * Declare the native function for processing the arguments
	 */
    private static native void processArguments(String[] args);

	/**
	 * Support for debugging under vscode 
	 */
	public static void main(String[] args) {
		System.out.println("--------------------------------------------------");
		System.out.println("RocketRide Java Debug Connector");
		System.out.println("Version 0.2.0");
		System.out.println("Copyright (c) 2026 RocketRide, Inc");
		System.out.println("--------------------------------------------------");

		// Java args includes only the arguments specified by user
		// and don't include the path to the executable as the first argument.
		// C++ args (processArguments) expects the path to the executable as the first argument.
		// Lets amend Java args with additional argument and pass to processArgs.
		// System property 'java.home' is not the path to the real executable binary (.\engine.exe or ./engine),
		// but it is not supposed to be an issue.
		String[] procArgs = new String[args.length + 1];
		procArgs[0] = System.getProperty("java.home");
		for (int i = 0; i < args.length; ++i)
			procArgs[i + 1] = args[i];

		processArguments(procArgs);
	}
}

#include <apLib/ap.h>

namespace ap::application {
ap::FormatOptions options;

void banner() {
    LOGOUTPUT("-------------------------------------------------");
    LOGOUTPUT("RocketRide Data Engine");
    LOGOUTPUT("Version {} {}", projectVersion(), buildStamp());
    LOGOUTPUT("Copyright (c) 2026 Aparavi Software AG");
    LOGOUTPUT("-------------------------------------------------");
    LOGOUTPUT("\n");
}

void engine() {
    LOGOUTPUT("Task execution");
    LOGOUTPUT("------------------------------");
    LOGOUTPUT("  engine [options] [taskFile|taskDir [...taskFile|taskDir]]");
    LOGOUTPUT("\n");
    LOGOUTPUT(
        "  Executes the given task file, or if a directory is specified,");
    LOGOUTPUT("  all task files within that directory and all subdirectories");
    LOGOUTPUT("\n");
    LOGOUTPUT("  Options:");
    LOGOUTPUT(
        "    --stream     Sends task instructions via stdin. If not specified");
    LOGOUTPUT(
        "                 tasks must be specified as taskFile or taskDir");
    LOGOUTPUT("\n");
}

void python() {
    LOGOUTPUT("Python");
    LOGOUTPUT("------------------------------");
    LOGOUTPUT("  engine [--python] [options] [-m module] [file] [arguments]");
    LOGOUTPUT("\n");
    LOGOUTPUT("  Executes a python module or script");
    LOGOUTPUT("\n");
    LOGOUTPUT("  Options:");
    LOGOUTPUT(
        "    --python     By default, the engine recognizes python (via ");
    LOGOUTPUT(
        "                 the -m option or the first file specified ending ");
    LOGOUTPUT(
        "                 with .py). If the engine does not recognize that ");
    LOGOUTPUT(
        "                 the command is a python command, you can specify");
    LOGOUTPUT("                 this option to force into python mode");
    LOGOUTPUT("    [options]    Any python option you normally pass to the ");
    LOGOUTPUT("                 python interpreter");
    LOGOUTPUT("    [-m module]  A python module path to execute");
    LOGOUTPUT("    [file]       A python file to execute");
    LOGOUTPUT(
        "    [args]       Arguments passed to the python module or file ");
    LOGOUTPUT("                 when executed");
    LOGOUTPUT("\n");
}

void java() {
    LOGOUTPUT("Java");
    LOGOUTPUT("------------------------------");
    LOGOUTPUT(
        "  engine [--java] [options] [-cp class [-cp class]] mainClass [args]");
    LOGOUTPUT("\n");
    LOGOUTPUT("  Executes a java class");
    LOGOUTPUT("\n");
    LOGOUTPUT("  Options:");
    LOGOUTPUT(
        "    --java       By default, the engine recognizes java (via the -cp");
    LOGOUTPUT(
        "                 option). If the engine does not recognize that the");
    LOGOUTPUT(
        "                 command is a python command, you can specify this");
    LOGOUTPUT("                 option to force into java mode");
    LOGOUTPUT("    [options]    Any java option you normally pass to the java");
    LOGOUTPUT("                 interpreter");
    LOGOUTPUT("    [-cp class]  Any number of classes to load");
    LOGOUTPUT(
        "    mainClass    The name of the main class which contains the Main");
    LOGOUTPUT("                 function to execute");
    LOGOUTPUT(
        "    [args]       Arguments passed to the java Main when executed");
    LOGOUTPUT("\n");
}

void tika() {
    LOGOUTPUT("Tika");
    LOGOUTPUT("------------------------------");
    LOGOUTPUT("  engine --tika document [-enableOCR] [-debug] [--markup]");
    LOGOUTPUT("\n");
    LOGOUTPUT("    --tika       Setup for processing a document");
    LOGOUTPUT("    document     File/path of the document to parse");
    LOGOUTPUT("    --debug      Output additional debug information from the");
    LOGOUTPUT("                 parsing process");
    LOGOUTPUT(
        "    --enableOCR  Enable OCR to read the document if an image file");
    LOGOUTPUT("                 or embedded image is encountered");
    LOGOUTPUT(
        "    --markup     Output embedded HTML markup information obtained");
    LOGOUTPUT("                 while parsing the document");
    LOGOUTPUT("\n");
}

void init() noexcept {
    Options::get().init();

    // If we are to output help
    if (cmdline().option("--engine_help", true)) {
        banner();
        engine();
        python();
        java();
        tika();
        quickExit();
    }

    if (cmdline().option("--version", true)) {
        LOGOUTPUT("Version: {} hash: {} stamp: {}", projectVersion(),
                  buildHash(), buildStamp());
        quickExit();
    }

#if ROCKETRIDE_PLAT_UNX
    signal::init();
#endif
}

void deinit() noexcept {
#if ROCKETRIDE_PLAT_UNX
    signal::deinit();
#endif
}

}  // namespace ap::application

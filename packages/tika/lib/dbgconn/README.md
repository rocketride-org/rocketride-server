# RocketRide Tika API Wrapper

## Building from the console

### Requirements
* JDK 1.8 or later, e.g. from https://adoptopenjdk.net
  * If not using the OpenJDK installer, manually set the JAVA_HOME environment variable to the JDK's installation path or add the JDK's bin subdirectory the system path
* Apache Maven, https://maven.apache.org/download.cgi
  * Add Maven's bin subdirectory to the system path
  * Run `mvn -v` to verify

#### Build instructions
* Navigate to the rocketride-tika project folder, engine/engLib/rocketride-tika
* Run the command `mvn clean compile assembly:single`

## Building with Visual Studio Code

### Requirements
* Requirements given above (JDK and Maven)
* Visual Studio Code
* Java Extension Pack

### Build Instructions

* In Visual Studio Code, open the folder engine/engLib/rocketride-tika
* In the VS Code Explorer, navigate to the "MAVEN PROJECTS" panel
* Right-cick on "rocketride-tika" and select "Custom ..."
* Run the command `clean compile assembly:single`

# Tesseract OCR Support

Tesseract is downloaded as part of engDeps.json. The Tesseract package consists of:
* Tesseract executable, which is built using vcpkg and our triplet.  The vcpkg port is currently at 4.1.0.  This produces a statically linked executable suitable for the platform.
* tessdata directory, which contains Tesseract's training data and some utility scripts.  These files were gathered from the [UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki) build of Tesseract for Windows at https://digi.bib.uni-mannheim.de/tesseract/tesseract-ocr-w32-setup-v4.1.0-elag2019.exe

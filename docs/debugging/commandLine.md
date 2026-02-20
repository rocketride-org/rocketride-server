# Engine command line parameters

The engine command line is very flexible and start any number of tasks or processes

## Executing test tasks

* engine [file|dir [file|dir] ] [options]

	### Executing Tasks
	* If the first file specification has a .json or .task extension, it will be assumed that you are executing a series of tasks so each file|dir specified will be executed
		* If file specification is a directory, all .json and .task files in the directory and all subdirectories will be executed.

	### Executing a python script
	* If the file specified has a .py, it will be assumed that you are executing a python script
		* All arguments and parameters beyond the first .py will be passed to the python script you specify as its arguments

	### Executing a python module
	* If you specify the -m [module] option, it will be assumed you are executing a python module. In this case, the -m must be followed by a python module
		* All arguments and parameters beyond the module name will be passed to the python module you specify as its arguments

	### Executing a java a class
	* If you specify a file that starts with org. or com. it will be considered an invocation to main() within the given class
		* All arguments and parameters beyond the class name will be passed to the java class you specify as its arguments
	* If you need to add a class path, you may use the -cp path option. You may need to add this option if the class to execute is not contained within any of the jar files within the java/lib or java/nodes folders

	### Exuting standalone tika
	* You can specify <code>engine --tika documentPath [--ENABLEOCR] [--DEBUG]</code> to invoke the tika processor and display the raw tika results to the console. This is identical to specifying <code>engine com.aparavi.tika_api.TikaApi documentPath --trace=Java</code>

	### Engine options
	* Regardless of which type of script/task you are executing, all recognized --options are stripped from the command line prior to processing. For example, issuing <code>engine myscript.py --trace=debug arg1"</code> will set the engine trace level to debug and execute the myscript.py python script passing arg1 as a parameter

## Common command line options
| Option			| Description											|
|-------------------|-------------------------------------------------------|
| --tika			| Invoke tika to process document and display results	|
| --version			| output the version of the engine						|
| --trace=lvl[,lvl]	| turns tracing on for a given level					|
| --monitor=type	| sets output and formatting to the given type <ul><li>app</li><li>console (*default)</li><li>testConsole</li></ul> |

## Trace levels
| lvl							| Description									|
|-------------------------------|-----------------------------------------------|
| All							| Enables all trace messages
| Azure							| Trace Azure node
| Buffer						| Trace on Buffers class
| Classify						| Trace classifications
| ClassifyContext				| Trace classification evaluation contexts
| ClassifyDetails				| Trace classify logging
| ClassifyDoc,      			| Trace classified document text
| ClassifyPolicies				| Trace classification policies and rules
| ClassifyResults				| Trace classify XML results
| Compress						| Trace on Compress class
| Connection					| Trace on Connection class
| Crypto						| Trace on encryption operations
| Data							| Trace on Data class
| Dev							| Trace extended developers logging
| Error							| Trace whenever an error code is created
| ExtractedMetadata				| Trace metadata extracted by Tika
| ExtractedText					| Trace text extracted by Tika
| Factory						| Trace whenever a new factory object is created or destroy
| Fatality						| Trace fatal errors
| File							| Trace all physical file operations
| FileStat						| Trace file stat info
| FileStream					| Trace file stream operations
| Framer						| Obsolete
| Glob							| Trace glb matching operations
| HandleTable					| Obsolete
| Heap							| Create full dumps vs minidumps
| Icu							| Trace ICU operations
| Index							| Trace indexing operations
| Init							| Trace init/deinig
| Java	         				| Trace Info, Warn, and Error logging from java
| JavaDetails	  				| Trace logging from Tika (in addition to above )
| JavaHeap						| Trace java heap information
| Jni	          				| Trace JNI logging
| Job							| Trace job execution
| JobAction						| Trace an action task
| JobClassify					| Trace a classify task
| JobClassifyFiles				| Trace a standalon file classification task
| JobConfigureService			| Trace a configuration task
| JobExec						| Trace general task execution
| JobFileScan					| Obsolete
| JobGenerateKey				| Trace a generate key task
| JobIndex						| Trace an index/re-index task
| JobInstance					| Trace an instance task
| JobMonitorTest				| Trace the monitor unit test 
| JobPermissions				| Trace the file OS permission task
| JobScan						| Trace a scan task
| JobSearchBatch				| Trace a search task
| JobSign						| Obsolete
| JobStat						| Trace a stat task
| JobSysInfo					| Trace a sysinfo task
| JobTokenize					| Trace a phrase tokenize task
| JobTransform					| Trace an exec/transform task
| JobUpdateScan					| Trace an update task
| JobValidate					| Trace a validation task
| Json							| Trace json class
| Jvm	          				| Trace data coming from the java virtual machine
| Lines							| Trace input/output pipe lines
| Match							| Obsolete
| Mount							| Trace SMB operations
| Parse							| Trace the tika parser
| ParsedDoc						| Obsolete
| Perf							| Trace permformance monitor data
| PerfD							| Obsolete
| Permissions					| Trace OS permissions
| Pipe							| Trace storage pipe operations
| Python		 				| Trace python interpeter
| Regex							| Trace regex class
| ScanContainers				| Trace containers as they are scanned
| ScanObjects					| Trace objects as they are scanned
| Search						| Trace search progress
| Selections					| Trace selections from includes/excludes
| ServiceAparavi				| Trace the aparavi format filter
| ServiceAzureBlob				| Trace the azure endpoint
| ServiceBottom					| Trace the bottom filter
| ServiceCapture				| Obsolete
| ServiceClassify				| Trace the classification filter
| ServiceCollapse				| Trace the text collapse filter
| ServiceCompression			| Trace the compression filter
| ServiceEncryption				| Trace the encryption filter
| ServiceEndpoint				| Trace the generic endpoint filter
| ServiceFilesys				| Trace the filesys endpoint
| ServiceFilter					| Trace the base filter
| ServiceHash					| Trace the hash filter
| ServiceIndexer				| Trace the indexer filter
| ServiceInput					| Obsolete
| ServiceLogger					| Trace the logger output filter
| ServiceNative					| Trace the native format filter
| ServiceNull					| Trace the null endpoint
| ServiceObjectDetail			| Obsolete
| ServiceObjectStore			| Trace the base filter
| ServiceObjectStoreDetails		| Obsolete
| ServiceOutput					| Obsolete
| ServiceParser					| Trace the parser filter
| ServicePermissions			| Trace the permissions filter
| ServicePipe					| Trace the pipe filter
| ServicePython					| Trace the python filter
| Services						| Trace the services registry
| ServiceScan					| Obsolete
| ServiceSmb					| Trace the smb endpoint
| ServiceTokenize				| Trace the text tokenize filter
| ServiceZip					| Trace the zip endpoint
| Smb							| Trace specific smb actions
| Snap							| Trace VSS snap operations
| Socket						| Trace Socket class
| SQLite						| Obsolete
| StackTrace					| Trace stack traces on errors
| StreamDatafile				| Trace datafile:// operations
| StreamDatanet					| Trace datanet:// operations
| StreamZipfile					| Trace zipfile:// operations
| StreamZipnet					| Trace zipnet:// operations
| Tag							| Obsolete
| Test							| Trace unit tests
| Thread						| Trace thread creation/destruction
| Tls							| Trace thread local storage
| Usn							| Trace USN walker
| UsnDetails					| Trace USN operations
| Volume						| Trace physical disk volume operations
| WordDb						| Trace word database information
| Words							| Obsolete
| Work							| Trace work to do queue
| WorkExec						| Trace work execution
| Xml							| Trace XML class





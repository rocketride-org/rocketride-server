# Debugging C++ components

> The ${workspace}/.vscode directory contains launch.template.json that contains the latest updates for 
debugging in various components

> The launch template contains references to `cppvsdbg` which must all be changed to your preferred Linux debugger
> You can do this by going to the debug explorer in vscode, and select the config icon at the top

## Launch configurations

* Engine - Tasks
	* Starts an engine/engine.exe to process the tasks specified
	* The tasks to execute are specified as parameters in the launch.json file
	* Uncomment that individual task, directory of tasks, or groups of tasks you want to execute
* Engine - Stream
	* Puts the engine into streaming mode where commands are sent to the engine via stdin
* Engine - Test
	* Executes the engine unit tests

## user.json

Many of the tasks have replaceable paramters to customize them for a given data set, 
source, target, trace values, etc. These replaceable parameters are defined in user.json

## Task type exec/transform

The exec and transform task types are a special kinds of tasks utilized to test and debug 
the engine itself with a series of tasks and options. The exec tasks takes the task file 
given, uses it as a template to create actual executable tasks from. The transform task type
creates task to import results into a "database" that emulates the application.

For example, the 00-scan.json task file, creates a scan task to scan a given source. Lets say
the source returns 3 pipe files of ~250K per pipe output file. The transform task, then imports
the 3 pipe files, creating 3 "databases", 1 for each scan pipe and imports the results of the
scan into the database.

We can then run an exec instance type task, which will actually create 3 instances tasks,
with pipe files for each database, launch those tasks, then import the results of those 
tasks, using transform, back into the database.

In order to accomplish this, the exec task uses the task provide as a template of what
to actually execute. The exec section of the task template has the following values:
* task.exec.batchId - specifies the starting batch id, should be 1
* task.exec.type - specifies the actual type of task to run
* task.exec.action - optional action if an action task
* task.exec.inputSet - specifies a pattern to use for the input set passed to config.input
* task.exec.outputSet - specifies a pattern to use for the output set passed to config.output

When an exec task is also execute, we can customize the task template by using replaceable 
parameters from user.json. If any of the following value in the template is a string, rather
than an object or undefined, the object in user.json is used to set the value in the template

* config.encryptionKey 
* config.decryptionKeys
* config.service
* config.source
* config.target

For example, if the template has `"config.service": "myService"`, then exec will look user.json
for services.myService, and if found, will issue the actual service info from there. This allows
us to quickly change an entire series of tasks, or the whole pipeline by changing just the
user.json file

## testdata/tasks

The testdata/tasks folder contains default tasks that can be configured for very easy access. This includes a series of 
tasks to run for scanning, instances, classifying, etc. They are prebuilt tasks just as the application would send 
them to the engine

## testdata/source

The testdata/source folder contains weired patterns of files, files that can and will fail and tests data sets
that can be used to test the outer bounds of the engine

## Engine command line

The engine command line is very flexible and start any number of tasks or processes

* engine task1.json [task2.json [task3.json]]
	* Starts the engine, executing task1.json, followed by task2.json, followed by task3.json
	* If any tasks fails, the process is stopped
* engine taskdir1 [taskdir2]
	* You can also specify a directory to execute tasks from, which will execute all tasks
	within the directory
* engine python.py
	* Execute a python script
* engine -cp java.jar className
	* Execute a java jar file calling the give class name

Common command line options
* --version					output the version of the engine
* --trace=lvl[,lvl]			turns tracing on for a given level
* --monitor=type			sets output and formatting to the given type
	* app					outputs in app meta tags
	* console				outputs in readable format with performance metrics if specified
	* testConsole			outputs in more terse test unit format

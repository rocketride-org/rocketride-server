# Test Tasks

Test tasks that can be executed by the engine, without the intervention of the application are includd in the testdata/tasks folder of the project. These tasks are designed to emulate how the application runs, building input pipes, inmporting output pipes, even creating a sort of "database" to track object/instance states.

The goal is to enable running these test tasks in an environment that does not require the application as a driver in any way.

## user.json

A critical component of the test tasks is the user.json file. This file is loaded from the current working directory. 

Many of the tasks have replaceable paramters to customize them for a given data set, source, target, trace values, etc. These replaceable parameters are defined in user.json

Using and modifying user.json allows you to update all the test tasks by changing this single file. For example, to scan an smb:// share, import the objects from it, parse and index the data, classify it etc, requires you to change only services.sourceService parameters in user.json. 

## Task type exec/transform

The exec and transform task types are a special kinds of tasks utilized to test and debug the engine itself with a series of tasks and options. The exec tasks takes the task file given, uses it as a template to create actual executable tasks to issue to the engine. The transform task type creates tasks to import results into a "database" that emulates the application.

For example, the 00-scan.json task file, creates a scan task to scan a given source. The source to scan is specified in user.json. Lets say the source returns 3 pipe files of ~250K per pipe output file. The transform task, then creates 3 tasks to import the 3 pipe files, creating 3 "databases", 1 for each scan pipe to import the results of the scan into the database.

We can then run an exec instance type task, which will actually create 3 instance tasks, with pipe files for each database, launch those tasks, then import the results of those tasks, using transform, back into the database.

In order to accomplish this, the exec task uses the task provide as a template of what to actually execute. The exec section of the task template has the following values:
* task.exec.batchId - specifies the starting batch id, should be 1
* task.exec.type - specifies the actual type of task to run
* task.exec.action - optional action if an action task
* task.exec.inputSet - specifies a pattern to use for the input set passed to config.input
* task.exec.outputSet - specifies a pattern to use for the output set passed to config.output

When an exec task is executed, we can customize the task template by using replaceable parameters from user.json. If any of the following value in the template is a string, rather than an object or undefined, the object in user.json is used to set the value in the template

* config.encryptionKey 
* config.decryptionKeys
* config.service
* config.source
* config.target

For example, if the template has `"config.service": "myService"`, then exec will look in user.json for services.myService, and if found, will issue the actual service info from there. This allows us to quickly change an entire series of tasks, or the whole pipeline by changing just the user.json file

## testdata/tasks

The testdata/tasks folder contains default tasks that can be configured for very easy access. This includes a series of tasks to run for scanning, instances, classifying, etc. They are prebuilt tasks just as the application would send them to the engine. By passing a directory to the engine, the engine executes all tasks within the directory so you can run an entire pipeline easily.

## testdata/source

The testdata/source folder contains weired patterns of files, files that can and will fail and tests data sets
that can be used to test the outer bounds of the engine

## Executing test tasks

engine task [task [task]] [options]
* task can be either an individual task of a directory, in which case all tasks in that directory and all its subdirectories will be executed
* If you specify "engine testdata/tasks", all tasks in the testdata/tasks folder will be executed, including the scan, instance, classify, actions, download, remove and search
* If you specify "engine testdata/tasks/0200-scan", only the scan pipeline will be executed
* If you specify "engine testdata/tasks/0200-scan/00-scan.json" only the scan task itself will be executed

>Most tasks build on input/output from previous tasks. For example, you cannot execute the 0300-instance pipe tasks until a succesful run of 0200-scan has been executed.


# Data mover architecture

This document provides details about how the data mover and data handling feature in engine works. 

## General sequence of operations for the data mover

* All data mover task operations are copy operations between a source endpoint and a target endpoint
* The typical sequence a task will use:
	* Get a source endpoint (which represents data storage services like file, smb, s3, azure etc.)
	* Get a target endpoint
	* For each url to be operated on
		* Get a pipe from the source endpoint
		* Get a pipe from the target endpoint
		* Call open on the target pipe giving the url
		* Call renderObject on the source pipe giving it the target pipe
		* Call close on the target pipe
		* Release the source pipe
		* Release the target pipe
	* Release the target endpoint
	* Release the source endp

## What is...
* Endpoint - an endpoint holds configuration information, credentials, paths, urls, etc to gain access to data stored on a service of a particular type
* Pipe - a pipe is a stack of linked filter drivers where data can be read from or written to depending on the mode of the endpoint
	* A pipe itself is a single threaded, synchronous structure - completely thread safe
	* Multiple pipes are created on an endpoint to provide mutlithreaded, overlapped I/O to the endpoint
	* Pipes are reusable across many operations so special care needs to be taken to reset any local member variables in, for example, `renderObject` when used as a source, or open/write/close when used as target
* Pipe Stack
	* The pipe stack is a an array of text strings which defines how the pipes for an endpointwill be constructed [here](../../engLib/engLib/store/stack.cpp)
	* A tech debt ticket should be setup to allow the definition of the stack in an engine.json file so
	it can be dynamically changed and updated
* Lanes
	* A lane is a set of APIs on a target pipe that go together as a group. The primary lane, which is the Tag lane is where a target filter driver accepts data coming from the source
	* Different lanes include, but not limited to tag (writeTag), text (writeText), words (writeWords)
* Filter driver
	* A filter driver such as index, parse, compression, etc is used to intercept data on its way to the eventual target endpoint
	* A filter driver can determine if it needs to 
		* Modify incoming data and send it on to the next filter in the stack
		* Completely ignore the data and return without forwarding the data
		* Switch the data to a different lane
			* For example, the parse filter accepts data incoming on the tag lane, but parses the data into text (using Tika) and forwards the parsed text on the text lane (writeText)
			* A filter driver, like parse, can choose whether or not to continue sending data down the original lane (writeTag) and/or sending the parsed text down the text lane (writeText) 
	* The filter driver defines two classes - IFilterInstance (instance) and IFilterGlobal (global)
* Instance
	* An instance is an IServiceFilterInstance associated with a single pipe. The instance is bound to it's pipe, to it's global data (IFilterGlobal), to the filter driver "above" it and "below" it
	* It contains information and controls access to the operation on a single file, email, etc
* Global
	* Often times, global data is needed to coordinate between  multiple instances running
	in separate pipes
	* You cannot store global data in the endpoint, since filter drivers do not have an endpoint stucture and since the filters are dynmically bound to an endpoint (you can't store it in the IServiceEndpoint), global data that the instances need to be stored somewhere, and that is the purpose of global
	* Not all filter instance classes need this kind of global data, so no additional work needs to be done, just derive your IFilterInstance/IFilterGlobal from IServiceFilterInstance and IServiceFilterGlobal
	* If you do need the type of global data, for example, exclusive locking, database handles, etc see the constructor of IFilterInstance in [indexer.hpp](../../engLib/engLib/store/filters/indexer/indexer.hpp) for an example on how to accomplish this
	* Note that any access or updates to global must be controlled and locked by the instances themselves

## Base Classes

* [IServiceEndpoint](../../engLib/engLib/store/headers/endpoint.hpp)
	* Typically named (engine::store::filter::[endpoint]::IFilterEndpoint)
	* Claims a particular uri protocol (for example file://, smb://, etc)
	* This class represents a connection to source or target data
	* There is exactly one of these instantiated for a source operation, and one instantiated for a target operation to execute a task
	* Multiple endpoints MAY be created to support concurrent task operations
	* The IServiceEndpoint derives from IServiceInstanceFilter so it represents a filter driver itself as well as an endpoint
	* Some endpoints can be target mode only (they can only be written to), source mode only (they can only be read from) or both modes.
	* Primary methods
		* `beginEndpoint/endEndpoint` (optional override)
			* beginEndpoint is guaranteed to be the first call after construction
			* endEndpoint is guaranteed to be the last call just prior to destruction
		* `getPipe/putPipe` (optional override)
			* Called to allocate and release a pipe
			* A pipe must be allocated to call any of the source filter functions (render*) or target filter functions (write*)
		* `scanObjects` (optional override)
			* Used to discover objects given a path or url
		* `validate` (optional override)
			* Used to validate that the "raw" configuration information supplied to the endpoint is valid and can be stored for furture access to the endpoint
			* The base handler of this method handles security encoding for protected fields within the configuration
		* `getConfigSubkey` (required)
			* The application requires a unique "key" to be generated from a service. This key is used to make sure there an no duplicate services defined, so the key must be derived from the service configuration itself and not just some random key
* [IServiceFilterInstance](../../engLib/engLib/store/headers/filter.hpp)
	* This class represents operations where data comes from or flows "through" on its way to the final target of an operation. 
	* For each pipe allocated from your IFilterEndpoint, there will be one of these structures for each pipe
	* Source primary methods 
		* `renderObject` (required override)
			* Renders an object into tags
			* It should call `pBottom->renderTag` to forward tag flow through the filter stack
		* `renderTag` (optional override)
			* Provides each filter driver the opportunity to decompress/decrypt/recompose tags and process the tagged data before it reaches the target
	* Target primary methods
		* `open` (optional override)
			* Opens an object by path, componentId, objectId etc.
			* There will only be a single object open at any given time on each pipe
		* `close` (optional override)
			* Closes an object
		* Lanes (optional override)
			* `writeTag` - provides each filter driver opportunity to process any incoming data
			* `writeText` - writes the text to the pipe
			* `writeTable` - writes the table to the pipe
			* `writeWords` - writes the words to the pipe
			* `writeAudio` - writes the audio to the pipe
			* `writeVideo` - writes the video to the pipe
			* `writeImage` - writes the video to the pipe
			* `writeDocuments` - writes the documents to the pipe
	* Public members
		* `pTop` = points to the root filter of the pipe
		* `pUp` = points to the previous filter in the stack
		* `pDown` = points to the next filter in the stack
		* `pBottom` = points to the very bottom filter in the stack
		* `pipe` = points to the IServiceFilterGlobal associated for this endpoint/filter
		* `endpoint` = points to the IServiceEndpoint which is associated with this pipe
		* `currentEntry` - points to the Entry structure that is being accessed with all
		the metadata information about the object
* [IServiceFilterGlobal](../../engLib/engLib/store/headers/filter.hpp)
	* This class represents the global data used by your IServiceFilterInstance
	* There is exactly one of these allocated for each endpoint/filter combination

There is a pretty good depiction of how all these components fit together in the source code itself [here](../../engLib/engLib/store/headers/types.hpp)

## Adding a new endpoints/filters

* C++ endpoint
	* You must define all 3 classes within a namespace IFilterEndpoint, IFilterGlobal and IFilterInstance
	* For sources, you will typically need to override scanObjects and renderObject
	* For targets, you will need to override the writeTag to received incoming data
	* Add your factory to the fixed engine initialization [init.cpp](../../engLib/engLib/store/core/init.cpp)
	* Add a service definition json file into the services folder /engLib/engLib/services
* C++ filter
	* You only need to define 2 classes within a namespace IFilterGlobal and IFilterInstance
	* For sources, you will typically intercept scanObjects, renderObject and/or renderTag
	* For targets, you will typically intercept writeTag although if you are intercepting a different lane, you may override any of the lane access methods (writeText, etc)
	* Add your factory to the fixed engine initialization [init.cpp](../../engLib/engLib/store/core/init.cpp)
* Python endpoint
	* Your python code/module must define
		* IEndpoint
			* Represents the IServiceFilterEndpoint in python
			* Under the covers, your IEndpoint and an internal C++ IServiceEndpoint are linked by the python endpoint driver
			* Store any python "global" data you need in your IEndpoint as there is no need for an IServiceFilterGlobal on python
			* Your IEndpoint, when instantiated, will have an `endpoint` attribute to access all task configuration information
		* IInstance
			* Represents the IServiceFilterInstance in python
			* Under the covers, your IInstance and an internal C++ IServiceFilterInstance are linked by the python endpoint driver
			* Your IInstance, when instantiated, will have an `endpoint` attribute to access your IEndpoint, from which you can then get configuration information and access any global information you stored on your IEndpoint
	* Drop any additional libraries you need into /englib/aparavi-pthon/lib (for global, generic libraries) or into the /englib/aparavi-python/connections/library folder for those specific to a set of nodes
	* Add a service definition json file into the services folder /engLib/engLib/services
	* Most binary python libraries (including those shipped as .dll or .so in a standard python distribution)
	are statically linked into the engine. Those libaries that are python source from the standard distribution are zipped up into python.zip, which is added automatically as a library path

## Example of data flow - assumptions

* Source and target pipe are initialized on a single machine. For exa., in our app, think of source and target pipe on same collector (or aggregator-collector/aggregator). 
* Source pipe is responsible for reading data from source, passing it to target pipe for final packaging via the writeTag interface
* Target pipe is responsible for data transfer to final destination in required format.

> NOTE: These examples are shown with knows filters as of today. In the future there may be additional filters in the stack. Overall data flow will remain same.

## Example 1: Source "file::/", target "s3://"

The source filter stack will be constructed as

	pipe			the very top level - always present
	filesys			the endpoint 
	bottom			the very bottom level - always present

The target filter stack will be constructed as

	pipe			the very top level - always present
	s3				the endpoint 
	bottom			the very bottom level - always present

Order of operations
* The task manager allocates a source pipe from the source endpoint and a target pipe from the target endpoint
* On the target pipe, `pTarget->open` is called to prepare the target to recieve data
* The task manager then calls `pipe->renderObject` on the allocated source pipe
	* [source.pipe] The pipe filter passes the request down to the next filter via `pNext->renderObject`
	* [source.filesys]
		* Receives the `renderObject` and opens the file via an OS call
		* Starts reading blocks of data for the file using OS calls and formatting the data into the tag format
		* For each tag it creates
			* Calls `pBottom->renderTag` which traverses up the chain of filters
				* [source.bottom] - Calls `pPrev->renderTag`
				* [source.file] - Calls `pPrev->renderTag`
				* [source.pipe] - Calls `pTarget->writeTag` to forward the unencrpyted/decompressed tag data to the target
				* [target.pipe] The pipe filter receives the `pTarget->writeTag` and passes it directly to the nextfilter via `pNext->writeTag`
				* [target.s3]  The S3 driver procesess the `pTarget->writeTag` and writes the data accordingly
		* After all data is read and completed, [file] returns from the `pSource->renderObject`
* After completion, `pTarget->close` is called to indicate data transfer is complete. The `close` call is very important and return codes MUST be paid attention to. A lot of filter drivers do a lot of processing on `close` - for example, the aparavi driver flushes any buffered data to the S3 filter driver, the indexer writes the documents words and commits the document to the database, etc

## Example 2: Indexing a file or object (instance task)

Indexing (parsing words out of a document) works exactly the same. Data is read from a source endpointand sent to the target endpoint. In the case of the instance task, how is this accomplished?

If we are indexing something like a file on the files system, it is exactly the same, from the source side as Example 1. The difference is in the target pipe filter stack:

The target filter stack will be constructed as

	pipe			the very top level - always present
	hash			creates a SHA signature on data passed through it (componentId)
	permissions		gathers permissions from OS file objects
	parse			parses a raw document into text
	tokenize		parses the text into words
	indexer			adds the words into the database
	null			throws away any incoming data
	bottom			the very bottom level - always present

So, in this case

* hash
	* Receives data on the `pTarget->writeTag` and hashes all incoming data andsets `pTarget->currentEntry.componentId()` from the generated hash
* permissions
	* Collects OS permissions on an object (users/groups/sids/etc) and sets the the `pTarget->currentEntry.permissionId()` with the identifier of the permissions
* parse
	* Parses the incoming tags on the `pTarget->writeTag` lane and sends the data to be indexed over to Tika
	* Once text is received from Tika, the parser switches lanes over the the `pTarget->writeText` lane to send the parsed text to the next filter
* tokenize
	* Accepts data on the `pTarget->writeText` interface
	* Breaks the text down into words and symbols using the ICU boundary parser
	* Switches lanes to the `pTarget->writeWords` lane
* indexer
	* Accepts data on the `pTarget->writeWords` interface
	* Addes the words into the word database
* null
	* Basically ignores any incoming data and returns success. This is a null bucket, just like the /dev/nul on the OS

## Example 3: Classify a file or object (classify task)

Classification uses a different set of endpoints and filters to classify or reclassify data.

However, the basic premise and operation is exactly the same as Example 1. In this case, we construct the pipe filter stacks:

The source filter stack will be constructed as

	pipe			the very top level - always present
	indexer			Indexed data
	null			throws away any incoming data
	bottom			the very bottom level - always present


The target filter stack will be constructed as

	pipe			the very top level - always present
	classify 		Classifies data
	null			throws away any incoming data
	bottom			the very bottom level - always present

The really big difference here is that the data we are going to classify is not coming from a real object, file or email, or such. It is actually coming from the index operation we completed during the instance task.

We do this by creating the `renderObject` method on the indexer filter driver that reads data from the document that we have already collected and stored within the word database, reconstructs the document and sends the data over to the target on the `pTarget->writeText` lane directly. Although we could have chosen for the indexers `renderObject` call to send over the tag lane via the `pTarget->writeTag` method, we would have had to add the parser into the target stack which would hurt performance. There is no restriction that a `renderObject` call needs to render data to a specific lane, or start on a specific lane. It is up to the target to accept data on the lane that handles, converting data from an alternate to its primary lane as needed.

## Example 4: Creating a zip file from S3 aparavi format objects

In this example, we wil be using the zipfile:// endpoint which creates a zip file on disk of incoming data.

The source filter stack will be constructed as

	pipe			the very top level - always present
	s3				the endpoint 
	bottom			the very bottom level - always present


The target filter stack will be constructed as

	pipe			the very top level - always present
	zipfile			Zip file endpoint
	bottom			the very bottom level - always present

This case, it works exactly the same as Example 1. The zipfile endpoint receives data via the `pTarget->writeTag` interface, determines from the tags whether it is actual data to be put into the zip file or not, and if so, use the minizip-ng library to add the data to the target zip file

## Summary

With this arhitecture, endpoings, filters, pipes, etc we can send data from anywhere to anywhere without changing much of the underlying code. It is mainly a matter of which filter drivers you include in a stack, and which lanes those drivers operate with.

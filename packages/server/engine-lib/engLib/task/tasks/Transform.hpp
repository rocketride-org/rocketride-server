// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

#pragma once

namespace engine::task::transform {
//-------------------------------------------------------------------------
/// @details
///		Define the configured mode of the endpoint - this is what the
///		service comes configured as from the json file
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(
    TRANSFORM, 0, 2,
    IMPORT_SCAN = _begin,  // Import the scans into our "database"
    IMPORT_INSTANCE,       // Update our "database" with instance results,
    IMPORT_ACTION,         // Update our "database" with action results
    IMPORT_CLASSIFY,       // Update our "database" with classification results
    BUILD_INSTANCE,        // Generate an instance input from our database
    BUILD_ACTION,          // Generate an action input from our database
    BUILD_CLASSIFY         // Generate a classification input from our database
);

using ImportLineCallback =
    std::function<Error(Url &parent, TextChr op, json::Value &entryJson)>;
using BuildLineCallback = std::function<Error(Entry &entry)>;

//-------------------------------------------------------------------------
/// @details
///		The transform task reads an output pipe and transforms it to
///		an input pipe. This is used to create response files for further
///		tasks that we run from the command line.
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobTransform;

    //-----------------------------------------------------------------
    /// @details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("transform");

    Text dbTemplate = "db-%BatchId%.json";

    json::Value &objects() { return m_db["objects"]; }
    json::Value &instances() { return m_db["instances"]; }

    //-----------------------------------------------------------------
    /// @details
    ///		Index the object for search performance
    ///	@param[in] object
    ///		The database object for indexing
    ///	@param[in] entry
    ///		The batch object matching the database object
    //-----------------------------------------------------------------
    void indexObject(const json::Value &object, const Entry &entry) noexcept {
        return isSync(entry.url()) ? indexObjectByUniqueName(object)
                                   : indexObjectByUrl(object);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Index the object by unique name
    ///	@param[in] object
    ///		The database object for indexing
    //-----------------------------------------------------------------
    void indexObjectByUniqueName(const json::Value &object) noexcept {
        auto uniqueName = object.lookup<Text>("uniqueName");
        auto objectId = object.lookup<Text>("objectId");
        if (uniqueName && objectId)
            m_uniqueNameIndex[_mv(uniqueName)] = _mv(objectId);
        else
            LOG(Always,
                "WARNING: Invalid object for indexing by unique name:", object);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Index the object by URL
    ///	@param[in] object
    ///		The database object for indexing
    //-----------------------------------------------------------------
    void indexObjectByUrl(const json::Value &object) noexcept {
        auto parent = object.lookup<Text>("parent");
        auto name = object.lookup<Text>("name");
        auto objectId = object.lookup<Text>("objectId");
        if (parent && name && objectId) {
            auto url = Url(parent) / name;
            m_urlIndex[_mv(url)] = _mv(objectId);
        } else
            LOG(Always, "WARNING: Invalid object for indexing by URL:", object);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Looks for the object in database matching the batch object
    ///	@param[in] entry
    ///		The batch object to look for
    ///	@returns
    ///		The object id if found, empty otherwise
    //-----------------------------------------------------------------
    TextView findObjectId(const Entry &entry) noexcept {
        return isSync(entry.url()) ? findObjectIdByUniqueName(entry.name())
                                   : findObjectIdByUrl(entry.url());
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Looks for the object in database by name (sync object id)
    ///	@param[in] url
    ///		Url of the object to look for
    ///	@returns
    ///		The object id if found, empty otherwise
    //-----------------------------------------------------------------
    TextView findObjectIdByUniqueName(TextView uniqueName) noexcept {
        if (m_uniqueNameIndex.size() == 0)
            for (const auto &object : objects())
                indexObjectByUniqueName(object);

        auto it = m_uniqueNameIndex.find(uniqueName);
        if (it != m_uniqueNameIndex.end())
            return it->second;
        else
            return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Looks for the object in database by url
    ///	@param[in] url
    ///		Url of the object to look for
    ///	@returns
    ///		The object id if found, empty otherwise
    //-----------------------------------------------------------------
    TextView findObjectIdByUrl(const Url &url) noexcept {
        if (m_urlIndex.size() == 0)
            for (const auto &object : objects()) indexObjectByUrl(object);

        auto it = m_urlIndex.find(url);
        if (it != m_urlIndex.end())
            return it->second;
        else
            return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Builds a local path from a template file name and batch id
    ///	@param[in] fileTemplate
    ///		The filename template
    ///	@param[in] batchId
    ///		The batch id to replace
    //-----------------------------------------------------------------
    ErrorOr<Path> getControlPath(Text &fileTemplate, uint32_t batchId) {
        // Format it
        Text batchIdString = _tso(Format::HEX | Format::FILL, batchId);

        // Replace and create a url from it
        auto url = stream::datafile::DataFile::toUrl(
            "control",
            util::Vars::expandRequired(fileTemplate, "BatchId", batchIdString));
        if (!url) return url.ccode();

        // Get the os path
        return stream::datafile::DataFile::localPath(*url);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Builds a local path from a template file name and batch id
    ///	@param[in] fileTemplate
    ///		The filename template
    ///	@param[in] batchId
    ///		The batch id to replace
    //-----------------------------------------------------------------
    ErrorOr<Path> getDataPath(Text &fileTemplate, uint32_t batchId) {
        // Format it
        Text batchIdString = _tso(Format::HEX | Format::FILL, batchId);

        // Replace and create a url from it
        auto url = stream::datafile::DataFile::toUrl(
            "data", util::Vars::expand(fileTemplate, "BatchId", batchIdString));
        if (!url) return url.ccode();

        // Get the os path
        return stream::datafile::DataFile::localPath(*url);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Determines if the batch database exists
    //-----------------------------------------------------------------
    bool fileExists(Path &path) {
        // See if it exists
        return ap::file::isFile(path);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Determines if the batch database exists
    //-----------------------------------------------------------------
    bool batchExists(uint32_t batchId) {
        // Get the file name
        auto path = getDataPath(dbTemplate, batchId);
        if (!path) return false;

        // See if it exists
        return fileExists(*path);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Determines if the batch database exists
    //-----------------------------------------------------------------
    bool removeBatch(uint32_t batchId) {
        // If it does not exist, create it
        if (!batchExists(batchId)) return false;

        // Get the file name
        auto path = getDataPath(dbTemplate, batchId);
        if (!path) return false;

        // Remove it
        if (auto ccode = ap::file::remove(*path))
            return false;
        else
            return true;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Removes all batch database files
    //-----------------------------------------------------------------
    bool removeBatches() {
        for (uint32_t batchId = 1;; batchId++) {
            if (!removeBatch(batchId)) return {};
        }
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Load the given batch database
    //-----------------------------------------------------------------
    Error loadBatch(uint32_t batchId) {
        // Get the file name
        auto path = getDataPath(dbTemplate, batchId);
        if (!path) return path.ccode();

        // If it does not exist, create it
        if (!batchExists(batchId)) {
            // Show some status
            MONITOR(status, "Creating " + ((TextView)*path));
            m_db = json::ValueType::objectValue;
            m_db["nextObjectId"] = 1;
            m_db["nextInstanceId"] = 1;
            m_db["objects"] = json::ValueType::objectValue;
            m_db["instances"] = json::ValueType::objectValue;
            return {};
        }

        // Show some status
        MONITOR(status, "Loading " + ((TextView)*path));

        // Load it, parse it
        auto contents = file::fetchString(*path);
        if (!contents)
            return APERR(contents.ccode(), "Failed to load file", path);

        // Parse it into json
        auto database = json::parse(*contents);
        if (!database)
            return APERR(database.ccode(), "Failed to parse file", path);

        // Save it and done
        m_db = _mv(*database);
        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Save the given batch database
    //-----------------------------------------------------------------
    Error saveBatch(uint32_t batchId) {
        // Get the file name
        auto path = getDataPath(dbTemplate, batchId);
        if (!path) return path.ccode();

        // Show some status
        MONITOR(status, "Saving " + ((TextView)*path));

        // Convert to a string
        auto content = m_db.stringify(true);

        // Save it
        return file::put(*path, content);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Gets the parent url from the objects collection from the
    ///		objectId specified in the entryJson
    ///	@param[in] entryJson
    ///		The entry json from the pipe
    ///	@param[out] parent
    ///		Receives the parent url
    //-----------------------------------------------------------------
    Error getParent(json::Value &entryJson, Url &parent) {
        Text objectId;
        entryJson.lookupAssign("objectId", objectId);

        // If we don't have an object id, error
        if (!objectId)
            return APERRT(Ec::InvalidState, "No object id to get parent from");

        // Get the object
        json::Value object;
        object = objects()[objectId];

        // Lookup the text for the parent
        Text parentText;
        object.lookupAssign("parent", parentText);

        // Set the parent url
        parent = Url{parentText};

        // Update object parent with unique param for sync service
        if (isSync(parent)) {
            auto parentUnique = object.lookup<Text>("parentUnique");
            if (parentUnique) {
                Text parentQuery =
                    "unique=" + ap::url::encode(_ts(parentUnique));
                parent = Url(parent.protocol(), parent.fullpath(), parentQuery);
            }
        }

        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		This function will walk through all the batches matching
    ///		the inputSet field which are pipe result files, and
    ///		call the callback for each line. It opens the batch database
    ///		for each batch while it is walking through
    ///	@param[in] callback
    ///		The callback function for each line
    //-----------------------------------------------------------------
    Error importBatches(ImportLineCallback callback) {
        Url parent;
        SyncEntryStack entryStack;

        int iterCount = 0;

        // Do this until we run out of input files
        for (uint32_t batchId = 1;; batchId++) {
            // Build the name
            ErrorOr<Path> input = getControlPath(m_inputSet, batchId);

            // If we did not find the file, stop
            if (!fileExists(*input)) {
                // If we found at least one input file, no problem,
                // we just reached the end of the list
                if (iterCount > 0) break;

                // If we did not find the first file, error out
                LOGT("Input pipe file is not a file or is not found");
                return APERR(Ec::NotFound,
                             "No input files are available to import");
            }

            // This will create a new starting batch
            if (auto ccode = loadBatch(batchId)) return ccode;

            // Show some status
            MONITOR(status, "Importing " + (TextView)*input);

            // Load it, parse it
            auto contents = file::fetchString(*input);
            if (!contents)
                return APERR(contents.ccode(), "Failed to load database file",
                             input);

            // Split it
            auto lines = contents->split('\n');
            if (lines.size() < 1)
                return APERR(contents.ccode(), "Not enough lines", input);

            // Check the header
            auto hdr = json::parse(lines[0]);
            if (!hdr) return hdr.ccode();

            // For each line
            for (auto index = 1; index < lines.size(); index++) {
                // Get the line
                const auto line = lines[index];

                // If this is a parent line, save it
                if (line[0] == '+') {
                    parent = line.substr(1);
                    continue;
                }

                // If this is a comment line, skip it
                if (line[0] == '#') {
                    continue;
                }

                // Tokenize the line - json format
                auto op = line[0];
                auto entryStr = line.substr(2);

                // Now parse the json
                auto errorOrJson = json::parse(entryStr);
                if (!errorOrJson) return errorOrJson.ccode();

                // Get the actual json object
                auto entryJson = *errorOrJson;

                if (m_target == "importScan" && isSync(parent)) {
                    // Create the entry to update the stack, the parent does not
                    // really matter, only the chain
                    // child.parentName/parent.name makes the sense
                    auto entry = Entry::makeEntry(parent, entryJson);
                    if (entry.hasCcode()) return entry.ccode();
                    // Push the entry to the stack, the stack items get updated
                    // to the actual path to the entry
                    if (auto ccode = entryStack.push(*entry)) return ccode;

                    // Build the parent url from the entry stack
                    Url uniqueUrl = parent / entryStack.uniquePath().parent();
                    Text parentQuery =
                        "unique=" + ap::url::encode(_ts(uniqueUrl));
                    Path parentPath =
                        (parent / entryStack.path().parent()).fullpath();
                    Url stackParent =
                        Url(parent.protocol(), parentPath, parentQuery);

                    // Process the line
                    if (auto ccode = callback(stackParent, op, entryJson))
                        return ccode;
                } else {
                    // Process the line
                    if (auto ccode = callback(parent, op, entryJson))
                        return ccode;
                }
            }

            // End this batch
            if (auto ccode = saveBatch(batchId)) return ccode;

            // We imported one more batch
            iterCount++;
        }

        // And done
        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Import the scan pipes into the batch databases
    //-----------------------------------------------------------------
    Error importToObjects(TextView lineTypes) {
        // Process the import line
        auto const importLine =
            localfcn(Url & parent, TextChr op, json::Value & entryJson)->Error {
            // If this is not an op, skip it
            if (lineTypes.find(op) == TextView::npos) return {};

            // Get the object id
            Text objectId = entryJson.lookup<Text>("objectId");

            // Find parent for non-scan objects
            if (m_target == "importScan") {
                // If we don't have a parent, error
                if (!parent)
                    return APERRT(Ec::InvalidState,
                                  "No current directory set on scan import");
            } else if (m_target == "importStat") {
                // Remove the object from the database
                objects().removeMember(objectId);

                // Create the id of the appropriate instance
                Text insKey = _ts(objectId, ":", m_serviceId);
                // And remove the instance from the database if it is there
                instances().removeMember(insKey);

                // And that's all
                return {};
            } else {
                // Get the object
                const json::Value &object = objects()[objectId];

                if (!object)
                    return APERRT(Ec::InvalidState,
                                  "Object not found:", objectId);

                // Get the parent from it
                Text parentStr = object.lookup<Text>("parent");

                // And save it
                parent = Url{parentStr};
            }

            // Make an entry out of it
            auto entry = Entry::makeEntry(parent, entryJson, true);
            if (!entry) return entry.ccode();

            // Reset id if it is set by external scan service
            if (objectId && m_target == "importScan") objectId.clear();

            // If we don't have this object id look to see if we can find it
            if (!objectId) {
                // Now, look to see if we have this object already loaded
                objectId = findObjectId(*entry);
            }

            // If it isn't in there, assign one
            if (!objectId) {
                // Do nothing, if the sync object is deleted and not found in
                // the database
                if (isSync(parent) && op == Entry::OPERATION::REMOVE) return {};

                // Assign an object id
                uint32_t nextObjectId = m_db.lookup<uint32_t>("nextObjectId");
                m_db["nextObjectId"] = nextObjectId + 1;

                // This is the main entry - emulating the "objects" table
                objectId = _ts("obj-", nextObjectId);
            }

            // Add the object to the database if it is not there yet
            if (!objects()[objectId]) objects()[objectId] = {};
            // Use this to build up the object
            json::Value &object = objects()[objectId];

            // Setup the rest of the object
            entry->objectId(objectId);
            object["objectId"] = objectId;
            object["parent"] = (TextView)entry->url().parent();
            object["flags"] = entry->flags();
            if (entry->objectTags) object["objectTags"] = entry->objectTags();
            if (isSync(parent)) {
                object["name"] = entry->name();
                if (entry->isContainer())
                    object["isContainer"] = entry->isContainer();
                if (entry->uniqueName)
                    object["uniqueName"] = entry->uniqueName();
                if (entry->parentUniqueName)
                    object["parentUniqueName"] = entry->parentUniqueName();
                if (entry->uniqueUrl)
                    object["parentUnique"] =
                        (TextView)entry->uniqueUrl().parent();
                if (entry->changeKey) object["changeKey"] = entry->changeKey();
                // Update the property "deleted" according to the sync operation
                if (op == Entry::OPERATION::REMOVE)
                    object["deleted"] = true;
                else
                    object.removeMember("deleted");

                // Create an instance if the object is sync
                if (entry->isObject() && m_target == "importScan" &&
                    op != Entry::OPERATION::REMOVE) {
                    // Create the id of the appropriate instance
                    Text insKey = _ts(objectId, ":", m_serviceId);

                    // Find the instance if we have one
                    if (instances().lookup(insKey)) {
                        auto &instance = instances()[insKey];

                        // If the instance exists and the object is changed,
                        // reset the instance data
                        if (instance.lookup<Text>("changeKey") !=
                            object.lookup<Text>("changeKey")) {
                            instance.removeMember("componentId");
                            instance.removeMember("wordBatchId");
                            instance.removeMember("permissionId");
                            instance.removeMember("vectorBatchId");
                            instance.removeMember("classifications");
                            instance["flags"] = entry->flags();
                        } else {
                            // Keep OCR_DONE if the object is not changed
                            instance["flags"] =
                                entry->flags() |
                                (instance.lookup<uint32_t>("flags") &
                                 Entry::FLAGS::OCR_DONE);
                        }

                        // Update sync instance with object data
                        instance["objectId"] = objectId;
                        instance["name"] = entry->name();
                        if (entry->uniqueName)
                            instance["uniqueName"] = entry->uniqueName();
                        if (entry->parentUniqueName)
                            instance["parentUniqueName"] =
                                entry->parentUniqueName();
                        if (entry->changeKey)
                            instance["changeKey"] = entry->changeKey();
                        if (entry->size) instance["size"] = entry->size();
                        if (entry->storeSize)
                            instance["storeSize"] = entry->storeSize();
#ifdef ROCKETRIDE_PLAT_MAC
                        if (entry->createTime)
                            instance["createTime"] =
                                static_cast<unsigned long>(entry->createTime());
                        if (entry->changeTime)
                            instance["changeTime"] =
                                static_cast<unsigned long>(entry->changeTime());
                        if (entry->accessTime)
                            instance["accessTime"] =
                                static_cast<unsigned long>(entry->accessTime());
                        if (entry->modifyTime)
                            instance["modifyTime"] =
                                static_cast<unsigned long>(entry->modifyTime());
#else
                        if (entry->createTime)
                            instance["createTime"] = entry->createTime();
                        if (entry->changeTime)
                            instance["changeTime"] = entry->changeTime();
                        if (entry->accessTime)
                            instance["accessTime"] = entry->accessTime();
                        if (entry->modifyTime)
                            instance["modifyTime"] = entry->modifyTime();
#endif
                    } else {
                        // Assign an instance id
                        uint32_t nextInstanceId =
                            m_db.lookup<uint32_t>("nextInstanceId");

                        // Set the instance id to assign
                        auto instanceId = nextInstanceId++;

                        // Save it
                        m_db["nextInstanceId"] = nextInstanceId;

                        // Set the instances id
                        entry->instanceId(instanceId);

                        // Save it into the instances table
                        instances()[insKey] = _tj(*entry);
                    }
                }
            } else {
                object["name"] = (TextView)entry->url().fileName();
            }

            // Re-index the object in the database
            indexObject(object, *entry);

            // Add this batch to the total
            MONITOR(addCompleted, 1, entry->isObject() ? entry->size() : 0);

            return {};
        };

        // Remove all of our batch files
        if (m_clearDatabase) removeBatches();

        // Start/stop the counters
        util::Guard countScope{[] { MONITOR(startCounters); },
                               [] { MONITOR(stopCounters); }};

        // Import the lines
        return importBatches(importLine);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Import the instance pipes into the batch databases
    //-----------------------------------------------------------------
    Error importToInstances(TextChr lineType, bool isAdd = true) {
        // Process the import line
        auto const importLine =
            localfcn(Url & parent, TextChr op, json::Value & entryJson)->Error {
            // If this is not an add, skip it
            if (op != lineType) return {};

            // Get the parent entry
            if (auto ccode = getParent(entryJson, parent)) return ccode;

            // Make an entry out of it
            auto entry = Entry::makeEntry(parent, entryJson, true);
            if (!entry) return entry.ccode();

            // Set the service id this is using
            entry->serviceId(m_serviceId);

            // Create the objsvc mapping key to get the services instance id
            Text insKey = _ts(entry->objectId(), ":", entry->serviceId());

            // Find the instance if we have one
            auto instance = instances().lookup(insKey);

            if (isAdd) {
                // If this is the first time we have seen this instance
                if (!instance) {
                    // Assign an instance id
                    uint32_t nextInstanceId =
                        m_db.lookup<uint32_t>("nextInstanceId");

                    // Set the instance id to assign
                    auto instanceId = nextInstanceId++;

                    // Save it
                    m_db["nextInstanceId"] = nextInstanceId;

                    // Set the instances id
                    entry->instanceId(instanceId);
                }

                // Save it into the instances table
                instances()[insKey] = _tj(*entry);
            } else {
                // Remove this objid/service
                instances().removeMember(insKey);
            }

            // Add this batch to the total
            MONITOR(addCompleted, 1, entry->isObject() ? entry->size() : 0);

            // And done
            return {};
        };

        // Start/stop the counters
        util::Guard countScope{[] { MONITOR(startCounters); },
                               [] { MONITOR(stopCounters); }};

        // Import the lines
        return importBatches(importLine);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Starts a batch build
    //-----------------------------------------------------------------
    Error buildBatchBegin(uint32_t batchId) {
        // Build the name
        ErrorOr<Path> input = getDataPath(m_outputSet, batchId);

        // Show some status
        MONITOR(status, "Building " + (TextView)*input);

        // Load the batch database
        return loadBatch(batchId);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Ends a batch build
    //-----------------------------------------------------------------
    Error buildBatchEnd(uint32_t batchId, TextChr lineType,
                        std::vector<Entry> &values) {
        // The output lines
        TextVector lines;

        // Get the file name
        auto path = getControlPath(m_outputSet, batchId);
        if (!path) return path.ccode();

        // Sorts the given entries by url
        MONITOR(status, "Sorting objects " + (TextView)*path);

        _block() {
            // Start/stop the counters
            util::Guard countScope{[] {
                                       MONITOR(reset);
                                       MONITOR(startCounters);
                                   },
                                   [] { MONITOR(stopCounters); }};

            // Expected approximate number of comparisons as '2n log(n)' is
            // avarage for quicksort
            size_t cmpCount = _cast<size_t>(2 * values.size() *
                                            std::log2(values.size())),
                   cmp = 0,  // current number of comparisons
                val = 0;     // approximate number of sorted entries

            // Total size of all entries
            uint64_t totalSize = std::accumulate(
                         values.begin(), values.end(), 0ull,
                         [](uint64_t sum, const auto &entry) noexcept {
                             return sum + (entry.isObject() ? entry.size() : 0);
                         }),
                     size = 0;  // approximate size of sorted entries

            auto updateSortProgress = [&] {
                // Increment current number of comparisons
                ++cmp;
                if (val < values.size() - 1) {
                    // Calculate the next approximate number of sorted entries
                    size_t nextVal =
                        std::min(_cast<size_t>(_cast<double>(cmp) / cmpCount *
                                               values.size()),
                                 values.size() - 1);
                    // Update progress if number of sorder values increased
                    if (nextVal > val) {
                        uint64_t nextSize = _cast<uint64_t>(
                            _cast<double>(nextVal) / values.size() * totalSize);

                        MONITOR(addCompleted, nextVal - val, nextSize - size);

                        val = nextVal;
                        size = nextSize;
                    }
                }
            };

            std::sort(values.begin(), values.end(),
                      [&](const Entry &lhs, const Entry &rhs) {
                          updateSortProgress();

                          Text lhsurl = (TextView)lhs.url().parent();
                          Text rhsurl = (TextView)rhs.url().parent();

                          return lhsurl != rhsurl ? lhsurl < rhsurl
                                                  : lhs.url().fileName() <
                                                        rhs.url().fileName();
                      });

            // Update progress by rest of uncounted values
            MONITOR(addCompleted, values.size() - val, totalSize - size);
        }

        // Build the header
        PipeTaskHeader hdr = {.schema = 10, .type = m_target};

        // Save the header
        lines.push_back(_ts(hdr));

        MONITOR(status, "Building content " + (TextView)*path);

        // For each entry
        Text parent;
        for (auto index = 0; index < values.size(); index++) {
            // Get this object
            auto &entry = values[index];

            // Get this objects parent
            Text thisParent = (TextView)entry.url().parent();

            // Update object parent with unique param for sync service
            if (isSync(entry.url()) && entry.uniqueUrl) {
                Text parentQuery =
                    "unique=" +
                    ap::url::encode(_ts(entry.uniqueUrl().parent()));
                thisParent =
                    (TextView)Url(entry.url().protocol(),
                                  entry.url().parent().fullpath(), parentQuery);
            }

            // If it is different, write the parent
            if (parent != thisParent) {
                lines.push_back("+" + thisParent);
                parent = thisParent;
            }

            // Convert it to json
            const auto json = _tj(entry);

            // ?*{json}
            Text line = _ts(lineType, "*", json.stringify(false));
            lines.push_back(_mv(line));
        }

        // Join the lines
        auto content = lines.join('\n') + "\n";

        MONITOR(status, "Saving " + (TextView)*path);

        // Save it
        return file::put(*path, content);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Build the input pipes of the given type
    //-----------------------------------------------------------------
    Error buildFromObjects(TextChr lineType) {
        int iterCount = 0;

        // Do this until we run out of object files
        for (uint32_t batchId = 1;; batchId++) {
            // If we did not find the file, stop
            if (!batchExists(batchId)) {
                // If we found at least one input file, no problem,
                // we just reached the end of the list
                if (iterCount > 0) break;

                // If we did not find the first file, error out
                LOGT("Input pipe file is not a file or is not found");
                return APERR(Ec::NotFound,
                             "No input files are available to import");
            }

            // Reserve the lines we are outputing
            std::vector<Entry> values;
            values.reserve(objects().size());

            _block() {
                // Start/stop the counters
                util::Guard countScope{[] {
                                           MONITOR(reset);
                                           MONITOR(startCounters);
                                       },
                                       [] { MONITOR(stopCounters); }};

                // Load the batch database
                if (auto ccode = buildBatchBegin(batchId)) return ccode;

                // Iterate through all the objects
                for (auto &object : objects()) {
                    // Get the parent path
                    Text parentPath = object.lookup<Text>("parent");

                    // Make a url of it
                    Url parent{parentPath};

                    // Check the operation of the object if it belongs to sync
                    // endpoint
                    if (isSync(parentPath)) {
                        bool isContainer = object.lookup<bool>("isContainer");
                        if (isContainer)
                            // Skip container
                            continue;

                        bool isDeleted = object.lookup<bool>("deleted");
                        if (isDeleted)
                            // Skip if the object is deleted
                            continue;

                        // Add parameter unique to parent url
                        auto parentUnique = object.lookup<Text>("parentUnique");
                        if (parentUnique) {
                            Text parentQuery =
                                "unique=" + ap::url::encode(_ts(parentUnique));
                            parent = Url(parent.protocol(), parent.fullpath(),
                                         parentQuery);
                        }
                    }

                    // Get the object id
                    auto objectId = object.lookup<Text>("objectId");

                    // Create the objsvc mapping key to get the services
                    // instance id
                    Text insKey = _ts(objectId, ":", m_serviceId);

                    // If we have an instance for this service
                    if (instances().isMember(insKey)) {
                        // Set the object to it
                        object = instances()[insKey];
                    }

                    // Make an entry out of it
                    auto entry = Entry::makeEntry(parent, object, true);
                    if (!entry) return entry.ccode();

                    // Save the entry
                    values.push_back(_mv(entry));

                    // Add this batch to the total
                    MONITOR(addCompleted, 1,
                            entry->isObject() ? entry->size() : 0);
                }
            }

            // End this batch
            if (auto ccode = buildBatchEnd(batchId, lineType, values))
                return ccode;

            iterCount++;
        }

        // And done
        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Build the input pipes of the given type
    //-----------------------------------------------------------------
    Error buildFromInstances(TextChr lineType) {
        // Do this until we run out of object files
        for (uint32_t batchId = 1;; batchId++) {
            // If we did not find the file, stop
            if (!batchExists(batchId)) break;

            // Reserve the lines we are outputing
            std::vector<Entry> values;
            values.reserve(instances().size());

            _block() {
                // Start/stop the counters
                util::Guard countScope{[] {
                                           MONITOR(reset);
                                           MONITOR(startCounters);
                                       },
                                       [] { MONITOR(stopCounters); }};

                // Load the batch database
                if (auto ccode = buildBatchBegin(batchId)) return ccode;

                // Iterate through all the instances
                for (auto &instance : instances()) {
                    Url parent;

                    // Get the parent url from the objectId in the instance
                    // record
                    if (auto ccode = getParent(instance, parent)) return ccode;

                    if (isSync(parent) && m_target == "buildClassify") {
                        uint32_t flags = instance.lookup<uint32_t>("flags");
                        // Add object to this batch if only in case of:
                        bool doClassify
                            // classifying and not classified
                            = (flags & Entry::FLAGS::CLASSIFY) &&
                              !instance.lookup("classifications");

                        if (!doClassify) continue;
                    }

                    // Make an entry out of it
                    auto entry = Entry::makeEntry(parent, instance, true);
                    if (!entry) return entry.ccode();

                    // If this is not what we are looking for, skip it
                    if (entry->serviceId() != m_serviceId) continue;

                    // If a globber was specified...
                    if (m_glob) {
                        auto matches = globber::glob<string::Case, 0>(
                            m_glob, (TextView)entry->url());
                        if (!matches) continue;
                    }

                    // Call it
                    values.push_back(_mv(*entry));

                    // Add this batch to the total
                    MONITOR(addCompleted, 1,
                            entry->isObject() ? entry->size() : 0);
                }
            }

            // Save this batch info
            if (auto ccode = buildBatchEnd(batchId, lineType, values))
                return ccode;
        }
        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Override the execution process - we will actually be
    ///		running multiple tasks
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        Error ccode;

        // Get the parameters
        if (auto ccode =
                taskConfig().lookupAssign("clearDatabase", m_clearDatabase) ||
                taskConfig().lookupAssign("inputSet", m_inputSet) ||
                taskConfig().lookupAssign("outputSet", m_outputSet) ||
                taskConfig().lookupAssign("glob", m_glob) ||
                taskConfig().lookupAssign("serviceId", m_serviceId) ||
                taskConfig().lookupAssign("transform", m_target))
            return ccode;

        // Override the message
        Text message = _ts("Executing ", m_target);
        MONITOR(status, message);

        // SCAN
        if (m_target == "importScan") ccode = importToObjects("AMD");

        // UPDATE
        else if (m_target == "buildUpdate")
            ccode = buildFromObjects('S');

        else if (m_target == "importUpdate")
            ccode = importToObjects("S");

        // STAT
        else if (m_target == "buildStat")
            ccode = buildFromObjects('S');

        else if (m_target == "importStat")
            ccode = importToObjects("D");

        // PERMISSIONS
        else if (m_target == "buildPermissions")
            ccode = buildFromObjects('O');

        else if (m_target == "importPermissions")
            ccode = importToObjects("O");

        // INSTANCE
        else if (m_target == "buildInstance")
            ccode = buildFromObjects('I');

        else if (m_target == "importInstance")
            ccode = importToInstances('I');

        // CLASSIFY
        else if (m_target == "buildClassify")
            ccode = buildFromInstances('C');

        else if (m_target == "importClassify")
            ccode = importToInstances('C');

        // PIPELINE
        else if (m_target == "buildPipeline")
            ccode = buildFromInstances('I');

        else if (m_target == "importPipeline")
            ccode = importToInstances('A');

        // ACTION - COPY
        else if (m_target == "buildAction.copy")
            ccode = buildFromInstances('A');

        else if (m_target == "importAction.copy")
            ccode = importToInstances('A');

        // ACTION - REMOVE
        else if (m_target == "buildAction.remove")
            ccode = buildFromInstances('A');

        else if (m_target == "importAction.remove")
            ccode = importToInstances('D', false);

        else if (m_target == "importTransform")
            ccode = importToInstances('A');

        else
            ccode = APERR(Ec::InvalidParam, "Unknown transformation type");

        // And done
        return ccode;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Check if the protocol supports Sync Tokens
    //-----------------------------------------------------------------
    bool isSync(const Url &url) noexcept {
        if (!m_syncEndpoint.has_value()) {
            // Get the capabilities of this protocol
            uint32_t caps = 0;
            if (auto ccode = Url::getCaps(url, caps)) {
                MONITOR(error, _mv(ccode));
                return false;
            }

            // Set if the endpoint is sync or not
            m_syncEndpoint = 0 != (caps & Url::PROTOCOL_CAPS::SYNC);
        }
        return m_syncEndpoint.value();
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Array of entries that have been have been read
    //-----------------------------------------------------------------
    json::Value m_db;

    //-----------------------------------------------------------------
    /// @details
    ///		Map object unique name -> id for sync services
    //-----------------------------------------------------------------
    std::map<Text, Text> m_uniqueNameIndex;

    //-----------------------------------------------------------------
    /// @details
    ///		Map object url -> id for non-sync services
    //-----------------------------------------------------------------
    std::map<Url, Text> m_urlIndex;

    //-----------------------------------------------------------------
    /// @details
    //-----------------------------------------------------------------
    bool m_clearDatabase = false;
    Text m_glob;
    Text m_target;
    Text m_inputType;
    Text m_outputType;

    Text m_inputSet;
    Text m_outputSet;
    uint32_t m_serviceId = 0;

    Opt<bool> m_syncEndpoint;
};
}  // namespace engine::task::transform

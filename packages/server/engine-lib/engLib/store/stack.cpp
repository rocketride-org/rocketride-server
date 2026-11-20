// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

#include <engLib/eng.h>

namespace engine::store {

//-------------------------------------------------------------------------
/// @details
///		Determines the pipe filters to create. This uses the
///		config.serviceConfig.filters to grab parameters for each layer
///     in the stack. Override this function so the endpoint can add its
///     configuration and pipe filters at the end of the stack. Make sure
///     the parent is also called if you override so all components have
///     the opportunity to add filters as necessary.
///	@param[out] filters
///		Receives the vector of filters to create
//-------------------------------------------------------------------------
Error IServiceEndpoint::getPipeFilters(IPipeFilters &filters) noexcept {
    // If its there, then add all the filters in the array. They can
    // be either strings, or an object with config info
    if (config.serviceConfig.isMember("filters")) {
        for (const auto &configFilter : config.serviceConfig["filters"]) {
            if (configFilter.isString())
                filters.push_back(configFilter.asString());
            else
                filters.push_back(configFilter);
        }
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Compute the deterministic order in which one lifecycle region
///		receives its open / closing / close callbacks. A region is the set
///		of nodes a single root drives: the pipe head drives the source (-1)
///		region, and each control/invoke node drives the sub-pipeline it
///		reaches over data edges. bindFilters binds a region flat onto its
///		root - closing/close in this order (upstream-first, so a node
///		flushes only after ALL of its upstream parents), open reversed.
///
///		Two phases, which MUST stay separate:
///		  1. Reachability from `root` over data edges. `root` seeds the walk
///		     and is never a member of its own region. A node in `claimed`
///		     (already owned by an earlier region) is skipped entirely. A node
///		     in `barriers` (another lifecycle root) joins this region when
///		     reached - its owner region opens/closes the node itself - but its
///		     outgoing edges are not followed, because its data children belong
///		     to its own region.
///		  2. Kahn topological sort over the region only. A node's in-degree
///		     counts only edges whose endpoints are both in the region, minus
///		     edges from `root` (a pre-satisfied seed, never emitted to
///		     decrement it). Ties break by strict first-seen order, which pins
///		     the result so it does not depend on hash-map iteration order.
///
///		Reachability is computed independently of the topo walk on purpose:
///		a cycle inside the region would leave its nodes un-emitted, and a
///		"mark reachable as you emit" shortcut could not tell a real cycle
///		from a harmless one outside the region. Hence a cycle within the
///		region is an error, while a cycle confined outside it is left alone.
///	@param[in]	connections
///		The (fromIndex, toIndex, lane) data-connection table; fromIndex == -1
///		is the pipeline source (the pipe head).
///	@param[in]	root
///		The lifecycle root that seeds this region (-1 for the source/head, or
///		a control node's pipeStack index).
///	@param[in]	barriers
///		The other lifecycle roots. One reached by this region joins it
///		(ordered as a member) but is not expanded past.
///	@param[in]	claimed
///		Nodes already owned by an earlier region; excluded from this one.
///	@returns
///		The region's pipeStack indices in topological order, or
///		Ec::InvalidParam if the region contains a cycle.
//-------------------------------------------------------------------------
ErrorOr<std::vector<int>> computeLifecycleOrder(
    const std::vector<std::tuple<int, int, std::string>> &connections, int root,
    const std::unordered_set<int> &barriers,
    const std::unordered_set<int> &claimed) noexcept {
    const int SOURCE = -1;

    // Collect the graph once. nodeOrder keeps real node indices in first-seen
    // order - that is the deterministic tie-break used by the Kahn walk below.
    // adj/edges are deduped so multiple lanes between the same pair count as a
    // single dependency (and so a node is emitted exactly once).
    std::vector<int> nodeOrder;
    std::unordered_set<int> nodeSeen;
    std::unordered_map<int, std::vector<int>> adj;
    std::set<std::pair<int, int>> edgeSeen;
    std::vector<std::pair<int, int>> edges;

    // The source (-1) is the walk driver, not a walked node, so never record it
    auto seeNode = localfcn(int id) {
        if (id == SOURCE) return;
        if (nodeSeen.insert(id).second) nodeOrder.push_back(id);
    };

    for (const auto &conn : connections) {
        int from = std::get<0>(conn);
        int to = std::get<1>(conn);
        seeNode(from);
        seeNode(to);

        // Multiple lanes between the same pair are a single dependency
        if (!edgeSeen.insert({from, to}).second) continue;
        adj[from].push_back(to);
        edges.push_back({from, to});
    }

    // Phase 1: reachability from `root` over data edges. `root` is the walk
    // driver, never a member of its own region. A `claimed` node is owned by
    // an earlier region and skipped; a `barrier` node (another lifecycle root)
    // joins this region when reached but its outgoing edges are not followed -
    // its data children belong to that barrier's own region.
    std::unordered_set<int> reachable;
    std::vector<int> pending(adj[root].begin(), adj[root].end());
    while (!pending.empty()) {
        int node = pending.back();
        pending.pop_back();
        if (node == root || node == SOURCE) continue;
        if (claimed.count(node)) continue;
        if (!reachable.insert(node).second) continue;
        if (barriers.count(node)) continue;
        for (int to : adj[node]) pending.push_back(to);
    }

    // Phase 2: Kahn's topological sort over the region only. Seed the in-degree
    // table with the region's nodes, then count incoming edges - but skip edges
    // from `root` (a pre-satisfied seed that is never emitted to decrement it)
    // and edges from a node outside the region (e.g. another root feeding a
    // shared join: that edge must not hold the join back).
    std::unordered_map<int, int> inDegree;
    for (int node : nodeOrder)
        if (reachable.count(node)) inDegree[node] = 0;
    for (const auto &edge : edges) {
        if (edge.first == root) continue;
        if (!reachable.count(edge.second)) continue;
        if (!reachable.count(edge.first)) continue;
        inDegree[edge.second]++;
    }

    std::vector<int> order;
    std::unordered_set<int> emitted;
    while (order.size() < reachable.size()) {
        bool progressed = false;

        // Emit the FIRST-SEEN node whose parents are all already emitted, then
        // restart the scan. Scanning nodeOrder (not a hash set) is what makes
        // the output deterministic for a given input.
        for (int node : nodeOrder) {
            if (!reachable.count(node) || emitted.count(node) || inDegree[node])
                continue;

            emitted.insert(node);
            order.push_back(node);
            for (int to : adj[node]) {
                if (!reachable.count(to)) continue;
                if (inDegree[to] > 0) inDegree[to]--;
            }
            progressed = true;
            break;
        }

        // No emittable node but the region not exhausted => a cycle among the
        // region's nodes (a cycle outside the region never entered it, so it
        // does not trip this).
        if (!progressed)
            return APERR(Ec::InvalidParam,
                         "Cycle detected in the pipeline connections reachable "
                         "from lifecycle root ",
                         root);
    }

    return order;
}

//-------------------------------------------------------------------------
/// @details
///		Partition the pipeline into lifecycle regions and validate ownership.
///		See endpoint.hpp for the contract. Every invoked node is a lifecycle
///		root that drives exactly the nodes it reaches over data edges, as the
///		head (-1) drives its region; a node has exactly one owner (head first,
///		then control roots in first-seen order); regions stop at any other
///		root they reach (a member, not expanded past). A control root's
///		sub-pipeline must be exclusively its own - it may not data-reach a
///		node owned by the main flow (rejected).
//-------------------------------------------------------------------------
ErrorOr<LifecycleRegions> computeLifecycleRegions(
    const std::vector<std::tuple<int, int, std::string>> &connections,
    const std::vector<int> &invokedNodes,
    const std::vector<std::string> &nodeLabels) noexcept {
    const int SOURCE = -1;

    // Name a node for a rejection message: its display label when we have one,
    // otherwise its index (unit tests call this without labels).
    auto nameOf = localfcn(int index)->std::string {
        if (index == SOURCE) return "the pipeline source";
        if (index >= 0 && index < (int)nodeLabels.size() &&
            !nodeLabels[index].empty())
            return nodeLabels[index];
        return std::to_string(index);
    };

    // Deduplicate the invoked nodes into control roots, first-seen order (a
    // node invoked by two agents shows up twice but is one root).
    std::unordered_set<int> controlRoots;
    std::vector<int> rootOrder;
    for (int invoked : invokedNodes)
        if (controlRoots.insert(invoked).second) rootOrder.push_back(invoked);

    LifecycleRegions regions;

    // The head region; a cycle in it surfaces here.
    auto head = computeLifecycleOrder(connections, SOURCE, controlRoots);
    if (!head) return head.ccode();
    regions.head = _mv(*head);

    // ownerOf maps each region member to the root that owns its lifecycle
    // (SOURCE = the head). The head claims first; a node reached by a control
    // root is claimed by it. A member found already claimed is either a
    // two-control-root overlap (rejected) or - only for a control root itself -
    // a data-fed sub-pipeline owner (rejected after the loop).
    std::unordered_set<int> headClaimed(regions.head.begin(), regions.head.end());
    std::unordered_map<int, int> ownerOf;
    for (int node : regions.head) ownerOf.emplace(node, SOURCE);

    // A control root's sub-pipeline must be exclusively its own: it must not
    // data-reach a node the main flow owns. Such a node flushes with the head at
    // end-of-object, not during the invocation, so the control node would drive
    // only part of its sub-pipeline and read an incomplete result. Walk data
    // edges from each root, stopping at other control roots (their sub-pipelines
    // belong to them), and reject if a head-owned node is reached.
    std::unordered_map<int, std::vector<int>> dataAdj;
    for (const auto &conn : connections)
        dataAdj[std::get<0>(conn)].push_back(std::get<1>(conn));
    for (int rootIndex : rootOrder) {
        std::unordered_set<int> seen;
        std::vector<int> stack(dataAdj[rootIndex].begin(),
                               dataAdj[rootIndex].end());
        while (!stack.empty()) {
            int node = stack.back();
            stack.pop_back();
            if (node == rootIndex || node == SOURCE) continue;
            if (!seen.insert(node).second) continue;
            if (headClaimed.count(node))
                return APERR(Ec::InvalidParam, "Control node", nameOf(rootIndex),
                             "reaches node", nameOf(node),
                             "that the main flow owns; a control node's "
                             "sub-pipeline must not be shared with the main "
                             "pipeline or another start");
            if (controlRoots.count(node)) continue;  // barrier: its own sub-pipe
            for (int to : dataAdj[node]) stack.push_back(to);
        }
    }

    for (int rootIndex : rootOrder) {
        // Computed against the head's claim only, so a control-vs-control
        // overlap stays visible (both regions contain the shared node).
        auto region =
            computeLifecycleOrder(connections, rootIndex, controlRoots, headClaimed);
        if (!region) return region.ccode();

        for (int node : *region) {
            auto it = ownerOf.find(node);
            if (it != ownerOf.end())
                return APERR(Ec::InvalidParam, "Pipeline node", nameOf(node),
                             "is reachable from two control roots (",
                             nameOf(it->second), "and", nameOf(rootIndex),
                             ") - a node has exactly one lifecycle owner");
            ownerOf.emplace(node, rootIndex);
        }

        if (!region->empty())
            regions.control.emplace_back(rootIndex, _mv(*region));
    }

    // A control root that owns a sub-pipeline must not itself be data-fed: its
    // owning region would open/close it and cascade into that sub-pipeline,
    // double-driving it alongside the invoke node's own per-invocation drive. A
    // data-fed invoked node with NO sub-pipeline is fine (nothing to
    // double-drive), so only roots that actually own a region are checked.
    for (const auto &region : regions.control) {
        auto it = ownerOf.find(region.first);
        if (it != ownerOf.end())
            return APERR(Ec::InvalidParam, "Control node", nameOf(region.first),
                         "drives a sub-pipeline and is also data-fed (owned by",
                         nameOf(it->second),
                         "); an invoked node with a sub-pipeline must not take a "
                         "data input");
    }

    return regions;
}

//-------------------------------------------------------------------------
/// @details
///		Compute the canonical stack of a pipeline. See endpoint.hpp for the
///		contract: the members generatePipelineStack has always walked, in an
///		order that depends on the shape alone, and the shape hash.
//-------------------------------------------------------------------------
ErrorOr<PipelineStack> computePipelineStack(
    const json::Value &pipeline, const std::string &sourceId) noexcept {
    // One component as the walk sees it: an edge is (from id, lane) for
    // data and (from id, classType) for control
    struct Node {
        std::string id;
        std::string provider;
        std::vector<std::pair<std::string, std::string>> inputs;
        std::vector<std::pair<std::string, std::string>> controls;
    };

    // sha256 as lowercase hex: the canonical form's labels and the shape hash
    const auto hashOf = localfcn(const std::string &text)->std::string {
        return _ts(crypto::Sha256::make(InputData{text}));
    };

    // Step 1: the components by id. An entry with no id is skipped, as the
    // engine's walk always skipped it; two entries with one id are refused:
    // the walk could not tell which one an edge names
    std::vector<Node> nodes;
    std::unordered_map<std::string, size_t> byId;
    const auto &components = pipeline["components"];
    if (components.isArray()) {
        for (const auto &component : components) {
            if (!component.isObject()) continue;
            auto id = component.lookup<std::string>("id", "");
            if (id.empty()) continue;
            if (byId.count(id))
                return APERR(Ec::InvalidParam, "Duplicate id found: ", id);

            Node node;
            node.id = id;
            node.provider = component.lookup<std::string>("provider", "");

            // The wiring as the file states it; its order is not the shape
            const auto collect = localfcn(
                const char *member, const char *label,
                std::vector<std::pair<std::string, std::string>> &out) {
                const auto &edges = component[member];
                if (!edges.isArray()) return;
                for (const auto &edge : edges) {
                    if (!edge.isObject()) continue;
                    auto from = edge.lookup<std::string>("from", "");
                    if (from.empty()) continue;
                    out.emplace_back(from, edge.lookup<std::string>(label, ""));
                }
            };
            collect("input", "lane", node.inputs);
            collect("control", "classType", node.controls);

            byId.emplace(id, nodes.size());
            nodes.push_back(_mv(node));
        }
    }

    // Step 2: the canonical form of every component. Start from the
    // provider (the source marked as such) and refine: a component's next
    // label hashes its own with the sorted labels of its neighbours over
    // every data and control edge, in and out, each with the edge's lane or
    // classType. Stop when a round splits no class further. Ids never enter
    // a label, so the forms of two specs that differ only in ids agree.
    const size_t count = nodes.size();
    std::vector<std::vector<std::string>> neighbours(count);
    std::vector<std::string> label(count);
    for (size_t index = 0; index < count; ++index)
        label[index] =
            hashOf(nodes[index].provider +
                   (nodes[index].id == sourceId ? "\x1esource" : ""));

    const auto distinct = localfcn(const std::vector<std::string> &labels) {
        return std::unordered_set<std::string>(labels.begin(), labels.end())
            .size();
    };
    auto classes = distinct(label);
    for (size_t round = 0; round < count; ++round) {
        // Gather each component's neighbour labels, edges in both directions
        for (auto &list : neighbours) list.clear();
        for (size_t to = 0; to < count; ++to) {
            const auto link =
                localfcn(const char *kind, const std::string &from,
                         const std::string &tag) {
                auto it = byId.find(from);
                if (it == byId.end()) return;
                neighbours[to].push_back(std::string(kind) + "<\x1f" + tag +
                                         "\x1f" + label[it->second]);
                neighbours[it->second].push_back(std::string(kind) + ">\x1f" +
                                                 tag + "\x1f" + label[to]);
            };
            for (const auto &edge : nodes[to].inputs)
                link("i", edge.first, edge.second);
            for (const auto &edge : nodes[to].controls)
                link("c", edge.first, edge.second);
        }

        // The next label: own label plus the sorted neighbourhood
        std::vector<std::string> next(count);
        for (size_t index = 0; index < count; ++index) {
            auto &list = neighbours[index];
            std::sort(list.begin(), list.end());
            std::string signature = label[index];
            for (const auto &entry : list) signature += "\x1e" + entry;
            next[index] = hashOf(signature);
        }

        // A round that splits no class is the fixed point
        auto nextClasses = distinct(next);
        label = _mv(next);
        if (nextClasses == classes) break;
        classes = nextClasses;
    }

    // Step 3: the walk. Stack index 0 is the source; a member is added once,
    // in the order the walk reaches it
    std::vector<std::string> order{sourceId};
    std::unordered_map<std::string, int> indexOf{{sourceId, 0}};
    const auto add = localfcn(const std::string &id) {
        if (indexOf.count(id)) return;
        indexOf.emplace(id, (int)order.size());
        order.push_back(id);
    };

    // The data consumers of a member, depth first, as the engine has always
    // walked them: by lane name, then provider, then canonical form; the id
    // breaks a tie only between components the shape cannot tell apart
    std::unordered_set<std::string> walked;
    std::function<void(const std::string &)> walkData;
    walkData = localfcn(const std::string &fromId) {
        if (!walked.insert(fromId).second) return;

        std::vector<
            std::tuple<std::string, std::string, std::string, std::string>>
            consumers;
        for (size_t index = 0; index < count; ++index) {
            const auto &node = nodes[index];
            for (const auto &edge : node.inputs)
                if (edge.first == fromId)
                    consumers.emplace_back(edge.second, node.provider,
                                           label[index], node.id);
        }
        std::sort(consumers.begin(), consumers.end());

        for (const auto &consumer : consumers) {
            const auto &id = std::get<3>(consumer);
            add(id);
            walkData(id);
        }
    };
    walkData(sourceId);

    // The invoked components: one whose control edge comes from a member
    // (the source included) joins, with its own data consumers, until none
    // is left. Each round takes the least candidate by classType, then
    // provider, then canonical form, then the stack index of the member that
    // invokes it; the id breaks a tie only between indistinguishable ones
    for (;;) {
        bool found = false;
        std::tuple<std::string, std::string, std::string, int, std::string>
            best;
        for (size_t index = 0; index < count; ++index) {
            const auto &node = nodes[index];
            if (indexOf.count(node.id)) continue;
            for (const auto &edge : node.controls) {
                auto from = indexOf.find(edge.first);
                if (from == indexOf.end()) continue;
                auto candidate =
                    std::make_tuple(edge.second, node.provider, label[index],
                                    from->second, node.id);
                if (!found || candidate < best) best = candidate;
                found = true;
            }
        }
        if (!found) break;

        const auto &id = std::get<4>(best);
        add(id);
        walkData(id);
    }

    // Step 4: the stack, wiring by stack index. A member must name its
    // provider (the source is the endpoint, configured on its own)
    PipelineStack stack;
    for (int index = 0; index < (int)order.size(); ++index) {
        PipelineStackEntry entry;
        entry.index = index;
        entry.id = order[index];

        auto found = byId.find(entry.id);
        if (found != byId.end()) {
            const auto &node = nodes[found->second];
            entry.provider = node.provider;
            if (index > 0 && entry.provider.empty())
                return APERR(Ec::InvalidParam, "The component", entry.id,
                             "does not have a provider");

            // Edges from components outside the stack are not built
            const auto wire = localfcn(
                const std::vector<std::pair<std::string, std::string>> &edges,
                std::vector<std::pair<int, std::string>> &out) {
                for (const auto &edge : edges) {
                    auto from = indexOf.find(edge.first);
                    if (from == indexOf.end()) continue;
                    out.emplace_back(from->second, edge.second);
                }
                std::sort(out.begin(), out.end());
                out.erase(std::unique(out.begin(), out.end()), out.end());
            };
            wire(node.inputs, entry.inputs);
            wire(node.controls, entry.controls);
        }
        stack.components.push_back(_mv(entry));
    }

    // Step 5: the shape hash over the ordered (provider, inputs, controls)
    // plus avoidMocks. Built as JSON arrays only, so nothing depends on key
    // order; ids never appear
    json::Value shape(json::arrayValue);
    for (const auto &entry : stack.components) {
        json::Value inputs(json::arrayValue);
        for (const auto &edge : entry.inputs) {
            json::Value pair(json::arrayValue);
            pair.append(edge.first);
            pair.append(edge.second.c_str());
            inputs.append(pair);
        }
        json::Value controls(json::arrayValue);
        for (const auto &edge : entry.controls) {
            json::Value pair(json::arrayValue);
            pair.append(edge.first);
            pair.append(edge.second.c_str());
            controls.append(pair);
        }
        json::Value row(json::arrayValue);
        row.append(entry.provider.c_str());
        row.append(inputs);
        row.append(controls);
        shape.append(row);
    }
    const auto &mocks = pipeline["avoidMocks"];
    bool avoidMocks = mocks.isBool()
                          ? mocks.asBool()
                          : (mocks.isIntegral() ? mocks.asInt() != 0 : false);
    json::Value identity(json::arrayValue);
    identity.append(avoidMocks);
    identity.append(shape);
    stack.hash = hashOf(identity.stringify());

    return stack;
}

//-------------------------------------------------------------------------
/// @brief Creates a connection table mapping indices of components in the list
/// to their
///        dependencies and associated lanes.
///
/// This function processes the connections array, looks up the "from" and "to"
/// IDs in the components list to determine their indices, and stores a mapping
/// of these indices along with the connection lane. It enables quick access to
/// dependency relationships. It also derives the lifecycle walk order from the
/// finished connection table (see computeLifecycleOrder) so that a cycle in the
/// reachable graph is reported here, at beginEndpoint, rather than later.
///
/// std::vector<std::tuple<int, int, std::string>> A vector of tuples, where
/// each tuple
///         contains:
///         - The index of the "from" component in the components list.
///         - The index of the "to" component in the components list.
///         - The lane associated with the connection.
//-------------------------------------------------------------------------
Error IServiceEndpoint::buildConnections() noexcept {
    const auto COMPONENT_SOURCE = -1;
    const auto COMPONENT_NOT_FOUND = -2;

    // If we are not in pipeline mode, done
    if (!isPipeline()) return {};

    // Reset the connection/control tables and the derived lifecycle regions
    // (all recomputed from the fresh config at the end of this function).
    // Clearing controls matters: beginEndpoint may re-run after a partial
    // failure, and the regions below derive from controls - a stale row would
    // seed a phantom region.
    connections.clear();
    controls.clear();
    lifecycleOrder.clear();
    controlLifecycleOrders.clear();

    // If no connections are provided, return early
    auto &components = config.pipeline.components();
    auto sourceId =
        config.pipeline.source().lookup<std::string>("id", "source");

    // Get the ids of the pipestack components regardless of whether
    // or not they are used
    std::map<std::string, int> pipeId;
    for (auto index = 0; index < pipeStack.size(); ++index) {
        // Get the ID
        std::string id = pipeStack[index].id;

        // Check for uniqueness
        if (pipeId.find(id) != pipeId.end())
            return APERR(Ec::InvalidParam, "Duplicate id found: ", id);

        // Add the ID mapping
        pipeId.insert({id, index});
    }

    // Get the component id of a loaded component in the stack. This
    // does not consider the source
    auto findComponentId = localfcn(std::string & id)->int {
        // If this one was not included, return -1
        if (pipeId.find(id) == pipeId.end()) return COMPONENT_NOT_FOUND;

        // Return the pipe id
        return pipeId[id];
    };

    // Get the component id of a loaded component, or -1 for
    // the source
    auto getComponentId = localfcn(std::string & id)->int {
        if (id == sourceId) return COMPONENT_SOURCE;

        // If this one was not included, return -1
        if (pipeId.find(id) == pipeId.end()) return COMPONENT_NOT_FOUND;

        // Return the pipe id
        return pipeId[id];
    };

    // Now, for each of its connections
    for (const auto &component : components) {
        // Get this components id
        auto compId = component["id"].asString();

        // If we didn't make the cut, we were not included,
        // nobody referenced us
        auto toId = findComponentId(compId);
        if (toId < 0) continue;

        // Check to we need input from someone else
        if (component.isMember("input")) {
            auto &input = component["input"];

            // Walk through the components we need to get data from
            for (const auto &comp : input) {
                // Get the lane and the connect to target
                auto from = comp["from"].asString();
                auto lane = comp["lane"].asString();

                // Get the component id. If it is not found, it is not
                // included or it is not the source, so skip it
                auto fromId = getComponentId(from);
                if (fromId == COMPONENT_NOT_FOUND) continue;

                // See if it is already there
                auto connTuple = std::make_tuple(fromId, toId, lane);
                if (std::find(connections.begin(), connections.end(),
                              connTuple) != connections.end())
                    continue;

                // Nope, add it
                connections.emplace_back(connTuple);
            }
        }

        // Check to we need control/invoke from someone else
        if (component.isMember("control")) {
            auto &components = component["control"];

            // Walk through the components we need to get data from
            for (const auto &comp : components) {
                // Get the lane and the connect to target
                auto from = comp["from"].asString();
                auto classType = comp["classType"].asString();

                // Get the component id. If it is not found, it is not
                // included or it is not the source, so skip it
                auto fromId = getComponentId(from);
                if (fromId == COMPONENT_NOT_FOUND) continue;

                // See if it is already there
                auto ctrlTuple = std::make_tuple(fromId, toId, classType);
                if (std::find(controls.begin(), controls.end(), ctrlTuple) !=
                    controls.end())
                    continue;

                // Nope, add it
                controls.emplace_back(ctrlTuple);
            }
        }
    }

    // Partition the pipeline into lifecycle regions (the head's plus one per
    // invoked node) and validate ownership. Done here, once per endpoint, so a
    // cycle or an invalid ownership shape surfaces at beginEndpoint rather than
    // once per pipe in bindFilters.
    std::vector<int> invoked;
    invoked.reserve(controls.size());
    for (const auto &ctrl : controls) invoked.push_back(std::get<1>(ctrl));

    // Display label per node - the service title the author sees on the canvas
    // plus their component id - so a rejection points straight at the wiring.
    std::vector<std::string> nodeLabels;
    nodeLabels.reserve(pipeStack.size());
    for (size_t index = 0; index < pipeStack.size(); ++index) {
        const auto &entry = pipeStack[index];
        std::string label(entry.id);
        auto serviceInfo = IServices::getServiceDefinition(entry.logicalType);
        if (serviceInfo) {
            auto title = (*serviceInfo)->serviceDefinition["title"].asString();
            if (!title.empty()) label = "\"" + title + "\" (" + label + ")";
        }
        nodeLabels.push_back(label);
    }

    auto regions = computeLifecycleRegions(connections, invoked, nodeLabels);
    if (!regions) return regions.ccode();
    lifecycleOrder = _mv(regions->head);
    controlLifecycleOrders = _mv(regions->control);

    // And done
    return {};
}

//-----------------------------------------------------------------------------
/// @brief Builds the pipeline stack for the service endpoint.
///
/// @details
/// This function processes the pipeline configuration from the task
/// configuration, validates the components, and constructs the necessary
/// dependencies and connections to execute the pipeline. It ensures all
/// components are correctly linked and detects issues such as missing or
/// duplicate components.
///
/// The function performs the following steps:
/// - Retrieves pipeline information from the task configuration.
/// - Validates the structure and uniqueness of components.
/// - Identifies and links dependent components.
/// - Detects circular dependencies.
/// - Constructs a list of components and their connections.
///
/// @return
/// - `Error{}` on success.
/// - `APERR(Ec::InvalidParam, ...)` if an invalid pipeline configuration is
/// detected.
//-----------------------------------------------------------------------------
Error IServiceEndpoint::generatePipelineStack() noexcept {
    // Get the components
    auto &components = config.pipeline.components();

    // Add the component to the stack at its canonical stack index
    const auto addComponent =
        localfcn(const json::Value &dependent, int stackIndex)->Error {
        // Get its id
        auto id = dependent["id"].asString();

        // Get the name of the provider
        auto filterName = dependent["provider"].asString();

        // If not specified, error out
        if (filterName.empty())
            return APERR(Ec::InvalidParam, "The component", id,
                         "does not have a provider");

        // Get a default value in case a config section is not present
        json::Value def = json::objectValue;

        // Get the configuration section
        json::Value connConfig;

        // The UI and services say to put the config section under the provider
        // name
        if (dependent.isMember(id)) {
            // It is under the provider name
            connConfig = dependent[filterName];
        } else if (dependent.isMember("config")) {
            // It is under the config key
            connConfig = dependent["config"];
        } else {
            // Default value
            connConfig = json::Value(json::objectValue);
        }

        // Find the service
        auto serviceInfo = IServices::getServiceDefinition(filterName);
        if (!serviceInfo) return serviceInfo.ccode();

        // Get the capabilities of the service
        auto capabilities = (*serviceInfo)->capabilities;

        // Add it, named by its canonical stack index
        pipeStack.push_back(
            {id, capabilities, filterName, filterName, connConfig});
        pipeStack.back().stackIndex = stackIndex;
        return {};
    };

    // Get the source pipeline we need to execute
    auto sourceId =
        config.pipeline.source().lookup<std::string>("id", "source");

    // The canonical walk (plan 7.2): the members and their order depend on
    // the shape alone, so every holder of an engine names a component by
    // the same stack index (traces, the open's config). Index 0 is the
    // source, the endpoint itself, which is the walk's root and never a
    // stack member
    auto stack =
        computePipelineStack(config.pipeline.root()["pipeline"], sourceId);
    if (!stack) return stack.ccode();

    // The component entries by id, to add each member with its own config
    std::unordered_map<std::string, const json::Value *> byId;
    for (const auto &component : components)
        if (component.isObject())
            byId.emplace(component.lookup<std::string>("id", ""), &component);

    // Add every member after the source in stack order
    for (const auto &entry : stack->components) {
        if (entry.index == 0) continue;
        auto found = byId.find(entry.id);
        if (found == byId.end()) continue;
        if (auto ccode = addComponent(*found->second, entry.index))
            return ccode;
    }

    // And done
    return {};
}

//-----------------------------------------------------------------------------
/// @brief Builds the pipeline stack for the service endpoint.
///
/// @details
/// This function constructs the pipeline stack by determining the appropriate
/// filters based on the current `openMode` and `serviceMode`. It ensures the
/// correct filters are added, validates configurations, and sets up the filter
/// stack.
///
/// The function performs the following steps:
/// - Retrieves filter configurations via `getPipeFilters()`.
/// - Determines logical and physical endpoint types.
/// - Defines helper functions to push filters (`pushAbsolute`, `pushFull`,
/// `pushString`).
/// - Checks if indexing, vectorization, or OCR is enabled.
/// - Based on `openMode`, it selects the appropriate pipeline processing mode:
///   - **TARGET mode** ensures the service is a valid target.
///   - **SOURCE mode** validates source-specific processing.
///   - **PIPELINE mode** enables a defined pipeline.
/// - Adds additional filters from `filterStack` if provided.
/// - Ensures the endpoint filter is at the bottom of the stack.
///
/// @return
/// - `Error{}` on success.
/// - `APERR(Ec::InvalidParam, ...)` if pipeline validation fails.
/// - `APERR(Ec::InvalidCommand, ...)` if an invalid open mode is encountered.
///
/// @note
/// - This function is responsible for configuring the filter stack that defines
///   how data is processed through the pipeline.
/// - The function ensures that pipeline configurations are correctly
/// structured,
///   preventing misconfigured components from being added.
/// - Filters are automatically appended in the correct order to maintain
/// consistency.
///
//-----------------------------------------------------------------------------
Error IServiceEndpoint::buildPipeStack() noexcept {
    Error ccode = {};

    // Ask the endpoint if it wants to add any filters at the bottom
    IPipeFilters filterStack;
    if (auto ccode = getPipeFilters(filterStack)) return ccode;

    // Grab the logical endpoint type
    Text logicalEndpoint;
    if (auto res = getLogicalType(config.serviceConfig))
        logicalEndpoint = _mv(*res);
    else
        return res.ccode();

    // Grab the physical endpoint type
    Text physicalEndpoint;
    if (auto res = getPhysicalType(config.serviceConfig))
        physicalEndpoint = _mv(*res);
    else
        return res.ccode();

    // We use these a couple of times
    Text filterPipe = engine::store::filter::pipe::Type;
    Text filterBottom = engine::store::filter::bottom::Type;

    // A filter that ships as a node may not be available - a host that cannot
    // load nodes (engtest) runs without it, and it resolves to nothing there
    const auto declaredFilter = [](auto type) noexcept {
        return IServices::getServiceDefinition((Text) type) ? type
                                                            : decltype(type){};
    };

    // The C++ nodes may not be available
    const auto filterHash = declaredFilter("hash"_itv);
    const auto filterParse = declaredFilter("parse"_itv);
    const auto filterClassify = declaredFilter("classify"_itv);

    // Add the filter
    const auto pushAbsolute =
        localfcn(Text id, uint32_t capabilities, Text logicalType,
                 Text physicalType, json::Value connConfig = json::Value{})
            ->Error {
        // Save it
        pipeStack.push_back(
            {id, capabilities, logicalType, physicalType, connConfig});
        return {};
    };

    // Add the filter supressing the pipe and bottom filters if they
    // were specified
    const auto pushFull =
        localfcn(Text id, int32_t capabilities, Text logicalType,
                 Text physicalType, json::Value connConfig = json::Value{})
            ->Error {
        // Specifically ignore these, they absolutely have to be at the top
        // and bottom regardless of what is requested
        if (logicalType == filterPipe || logicalType == filterBottom) return {};

        // By default, the physical type is the same as the logical type
        if (!physicalType) physicalType = logicalType;

        // Save it
        return pushAbsolute(id, capabilities, logicalType, physicalType,
                            connConfig);
    };

    // Add the filter supressing the pipe and bottom filters if they
    // were specified
    const auto pushString =
        localfcn(Text logicalType, Text physicalType = {})->Error {
        // Specifically ignore these, they absolutely have to be at the top
        // and bottom regardless of what is requested
        if (logicalType == filterPipe || logicalType == filterBottom) return {};

        // By default, the physical type is the same as the logical type
        if (!physicalType) physicalType = logicalType;

        // Save it
        return pushAbsolute(logicalType, 0, logicalType, physicalType);
    };

    // Put our pipe source at the top
    pushAbsolute(filterPipe, 0, filterPipe, filterPipe);

    // Based on the mode
    switch (config.openMode) {
        case OPEN_MODE::TARGET:
        case OPEN_MODE::STAT:
        case OPEN_MODE::REMOVE: {
            break;
        }

        case OPEN_MODE::CONFIG: {
            // Config can occur in either mode
            break;
        }

        case OPEN_MODE::SOURCE:
        case OPEN_MODE::SCAN: {
            // These require a source endpoint
            if (config.serviceMode != SERVICE_MODE::SOURCE)
                return APERR(Ec::InvalidParam,
                             "The service is not a source service");

            // All these just require the endpoint
            break;
        }

        case OPEN_MODE::CLASSIFY: {
            // These require a target endpoint
            if (config.serviceMode != SERVICE_MODE::TARGET)
                return APERR(Ec::InvalidParam,
                             "The service is not a target service");

            // These require a classify filter
            if (!filterClassify)
                return APERR(Ec::InvalidCommand,
                             "The classify node is not available");

            // This is primarily used as a target to receives text
            // on the writeText interface and classify the incoming
            // documents classification
            pushString(filterClassify);
            break;
        }

        case OPEN_MODE::CLASSIFY_FILE: {
            // These require a target endpoint
            if (config.serviceMode != SERVICE_MODE::TARGET)
                return APERR(Ec::InvalidParam,
                             "The service is not a target service");

            // These require a parse filter
            if (!filterParse)
                return APERR(Ec::InvalidCommand,
                             "The parse node is not available");

            // These require a classify filter
            if (!filterClassify)
                return APERR(Ec::InvalidCommand,
                             "The classify node is not available");

            pushString(filterParse);
            // pushString(filter::tokenize::Type);

            pushString(filterClassify);
            break;
        }

        case OPEN_MODE::HASH: {
            // These require a target endpoint
            if (config.serviceMode != SERVICE_MODE::TARGET)
                return APERR(Ec::InvalidParam,
                             "The service is not a target service");

            // These require a hash filter
            if (!filterHash)
                return APERR(Ec::InvalidCommand,
                             "The hash node is not available");

            // Don't need much, just the hasher
            pushString(filterHash);
            break;
        }

        case OPEN_MODE::PIPELINE:
        case OPEN_MODE::PIPELINE_CONFIG: {
            // Say we have a defined pipeline
            m_isPipeline = true;

            // Generate the pipeline stack
            if (ccode = generatePipelineStack()) return ccode;
            break;
        }

        default:
            // Error out
            return APERR(Ec::InvalidCommand,
                         "Invalid open mode getting pipe stack");
    }

    // Then add the default filters - these are returned from overriding the
    // getPipeFilters on the endpoint. It may not have any if the endpoint
    // doesn't have any filter to add...
    for (size_t i = 0; i < filterStack.size(); ++i) {
        const auto &filter = filterStack[i];
        Error ccode;
        Text filterName;
        Text id;

        // If this is a string
        if (std::holds_alternative<Text>(filter)) {
            // Note on string --- if this is a pipeline task, it won't have
            // any connections specified so it will not be linked up to anything

            // If this is a string
            const Text &logicalType = std::get<Text>(filter);

            // Save it with default config
            if (ccode = pushString(logicalType)) return ccode;

            // If this holds an object
        } else if (std::holds_alternative<json::Value>(filter)) {
            // If this is a json value
            const json::Value &value = std::get<json::Value>(filter);

            // Get the id
            id = value.lookup<Text>("id", "");

            // Get the filterName
            filterName = value.lookup<Text>("provider", "");

            // If not specified, error out
            if (!filterName)
                return APERR(Ec::InvalidParam,
                             "The pipeline entry did not have a provider");

            // Get the configuration section
            json::Value connConfig = json::Value(json::objectValue);

            // The UI and services say to put the config section under the
            // provider name
            if (value.isMember(filterName)) {
                // It is under the provider name
                connConfig = value[filterName];
            } else if (value.isMember("config")) {
                // It is under the config key
                connConfig = value["config"];
            } else {
                // Default value
                connConfig = json::objectValue;
            }

            // Find the service
            auto serviceInfo = IServices::getServiceDefinition(filterName);
            if (!serviceInfo) return serviceInfo.ccode();

            // Get the capabilities of the service
            auto filterCapabilities = (*serviceInfo)->capabilities;

            // Pass over the string and config
            if (ccode = pushFull(id, filterCapabilities, filterName, filterName,
                                 connConfig))
                return ccode;
        } else {
            // Not the required type type
            return APERR(Ec::InvalidParam,
                         "getPipeFilter must specify an object with provider "
                         "key or a string");
        }
    }

    // Always add the endpoint filter at the end
    pushString(logicalEndpoint, physicalEndpoint);

    // Put this at the bottom
    pushAbsolute(filterBottom, 0, filterBottom, filterBottom);

    // Save the number of filters in the stack
    m_numberFilters = pipeStack.size();

    // And done
    return {};
}
}  // namespace engine::store

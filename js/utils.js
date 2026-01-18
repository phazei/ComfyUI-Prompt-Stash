/**
 * Utility functions for ComfyUI-Prompt-Stash
 */

/**
 * Check if a node matches a potentially-prefixed UNIQUE_ID from the backend.
 * Handles subgraph paths like "54:73" or "54:62:174".
 * 
 * @param {LGraphNode} node - The node to check
 * @param {string|number} uniqueId - The UNIQUE_ID from backend (e.g., "54:73" or "73")
 * @returns {boolean}
 */
export function nodeMatchesUniqueId(node, uniqueId) {
    const parts = String(uniqueId).split(':').map(Number);
    const localId = parts.pop();
    
    // Quick exit: local ID must match
    if (localId !== node.id) return false;
    
    // No prefix means node should be in root graph
    if (parts.length === 0) {
        return node.graph?.isRootGraph ?? true;
    }
    
    // Walk the path from root to find the target subgraph's UUID
    let current = node.graph?.rootGraph;
    if (!current) return false;
    
    for (const subgraphNodeId of parts) {
        const subgraphNode = current.getNodeById(subgraphNodeId);
        if (!subgraphNode?.subgraph) return false;
        current = subgraphNode.subgraph;
    }
    
    // current.id should now be the UUID of the subgraph containing the leaf
    return current.id === node.graph.id;
}

/**
 * Get the full UNIQUE_ID path for a node, matching backend format.
 * Returns "54:62:73" for nested subgraphs, or just "73" for root-level nodes.
 * 
 * @param {LGraphNode} node - The node to get the path for
 * @returns {string} The full UNIQUE_ID path
 */
export function getUniqueIdFromNode(node) {
    const leafId = node.id;
    
    // Easy case: node is in root graph
    if (node.graph?.isRootGraph) {
        return String(leafId);
    }
    
    const targetUUID = node.graph.id;
    const rootGraph = node.graph.rootGraph;
    
    if (!rootGraph) {
        return String(leafId); // Fallback
    }
    
    // Get the set of subgraph UUIDs for quick lookup
    const subgraphUUIDs = new Set(rootGraph.subgraphs?.keys() ?? []);
    
    // Recursive search: find the path of node IDs leading to targetUUID
    function findPathToUUID(graph, target) {
        for (const graphNode of graph.nodes ?? []) {
            // Check if this node is a subgraph container
            if (subgraphUUIDs.has(graphNode.type) && graphNode.subgraph) {
                if (graphNode.subgraph.id === target) {
                    // Found it! Return this node's ID as the path
                    return [graphNode.id];
                }
                
                // Not a direct match, search deeper
                const deeperPath = findPathToUUID(graphNode.subgraph, target);
                if (deeperPath) {
                    // Found it deeper, prepend this node's ID
                    return [graphNode.id, ...deeperPath];
                }
            }
        }
        return null; // Not found in this branch
    }
    
    const path = findPathToUUID(rootGraph, targetUUID);
    
    if (path) {
        return [...path, leafId].join(':');
    }
    
    // Fallback if we couldn't find the path (shouldn't happen)
    console.warn('getUniqueIdFromNode: Could not resolve subgraph path for node', node.id);
    return String(leafId);
}

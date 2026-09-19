/**
 * AgentGuard MCP v2.0.0 — Tool: Causal Chain Analysis
 *
 * Reads checkpoint history from JSONL storage and uses Breadth-First Search
 * to trace failure propagation through parent_checkpoint_id dependency links.
 * Identifies the root cause checkpoint and scores confidence based on how many
 * failure chains converge on it.
 *
 * Algorithm overview:
 *   1. Load all checkpoints for the session from JSONL storage
 *   2. Build a directed graph: parent → [children]
 *   3. For each failed checkpoint, walk UP through parent links (BFS)
 *   4. Count how often each ancestor appears across all failure chains
 *   5. The most-common ancestor = root cause; frequency / total = confidence
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import { readAll } from "../utils/storage.js";
import type { CheckpointEntry } from "../types/index.js";

// ---------------------------------------------------------------------------
// Internal graph types
// ---------------------------------------------------------------------------

interface GraphNode {
    checkpoint: CheckpointEntry;
    children:   string[];           // checkpoint IDs whose parent = this node
}

type Graph = Map<string, GraphNode>;

// ---------------------------------------------------------------------------
// Helper: build adjacency list from flat checkpoint array
// ---------------------------------------------------------------------------

function buildGraph(checkpoints: CheckpointEntry[]): {
    graph:      Graph;
    rootIds:    Set<string>;   // checkpoints with no parent
} {
    const graph: Graph    = new Map();
    const rootIds         = new Set<string>();

    // First pass — create every node
    for (const cp of checkpoints) {
        graph.set(cp.id, { checkpoint: cp, children: [] });
        if (!cp.parent_checkpoint_id) {
            rootIds.add(cp.id);
        }
    }

    // Second pass — wire children into their parent nodes
    for (const cp of checkpoints) {
        if (cp.parent_checkpoint_id && graph.has(cp.parent_checkpoint_id)) {
            graph.get(cp.parent_checkpoint_id)!.children.push(cp.id);
        }
    }

    return { graph, rootIds };
}

// ---------------------------------------------------------------------------
// Helper: walk from a given node UP through parent links (BFS)
// Returns ordered list of ancestor IDs from nearest to root,
// including the starting node itself.
// Breaks on cycles by tracking visited nodes.
// ---------------------------------------------------------------------------

function ancestorChain(
    startId:       string,
    graph:         Graph,
    rootIds:       Set<string>,
    cyclesFound:   Set<string>
): string[] {
    const chain:   string[] = [];
    const visited: Set<string> = new Set();
    let current:   string | null = startId;

    while (current !== null) {
        if (visited.has(current)) {
            // Circular reference detected — break the cycle
            cyclesFound.add(current);
            break;
        }
        visited.add(current);
        chain.push(current);

        const node = graph.get(current);
        if (!node) break;

        // Walk up
        current = node.checkpoint.parent_checkpoint_id ?? null;
    }

    return chain;   // [startId, parentId, grandparentId, ..., rootId]
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function causalChainTools(server: McpServer): void {

    server.registerTool(
        "analyze_causality",
        {
            description:
                "Traces failed checkpoints through their declared dependency graph and identifies the deepest common ancestor as a root-cause candidate. Dependency is declared via parent_checkpoint_id — this traces structural dependency, not proven causation.",
            inputSchema: {
                session_id: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe("Session to analyze. Must match the session_id used in log_checkpoint calls."),
                failed_checkpoint_ids: z
                    .array(z.string().uuid())
                    .min(1)
                    .max(50)
                    .describe(
                        "UUIDs of checkpoints known to have failed or produced bad output. " +
                        "The tool traces these back to find the root-cause candidate."
                    ),
                include_graph: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Include full dependency graph in response for debugging. " +
                        "Useful when building agent workflows that need to visualise the causal structure."
                    ),
            },
        },
        async ({ session_id, failed_checkpoint_ids, include_graph }) => {
            try {
                // ---------------------------------------------------------------
                // Phase 1 — Load session checkpoints
                // ---------------------------------------------------------------

                const allCheckpoints = await readAll<CheckpointEntry>(session_id);

                if (!allCheckpoints || allCheckpoints.length === 0) {
                    return buildResponse({
                        error:          "SESSION_NOT_FOUND",
                        session_id,
                        message:        `No checkpoints found for session "${session_id}". ` +
                                        "Ensure log_checkpoint was called with this session_id.",
                        timestamp:      new Date().toISOString(),
                    });
                }

                // ---------------------------------------------------------------
                // Phase 2 — Build graph & identify unknown IDs
                // ---------------------------------------------------------------

                const checkpointById = new Map<string, CheckpointEntry>(
                    allCheckpoints.map((cp) => [cp.id, cp])
                );

                const unknownIds:  string[] = [];
                const knownFailIds: string[] = [];

                for (const id of failed_checkpoint_ids) {
                    if (checkpointById.has(id)) {
                        knownFailIds.push(id);
                    } else {
                        unknownIds.push(id);
                    }
                }

                const { graph, rootIds } = buildGraph(allCheckpoints);
                const cyclesFound        = new Set<string>();

                // ---------------------------------------------------------------
                // Phase 3 — BFS upward from each failed checkpoint
                // ---------------------------------------------------------------

                // ancestorFrequency: how many failure chains pass through each node
                const ancestorFrequency = new Map<string, number>();
                // Per-failure ordered chains (startId → root)
                const chainsPerFailure  = new Map<string, string[]>();

                for (const failId of knownFailIds) {
                    const chain = ancestorChain(failId, graph, rootIds, cyclesFound);
                    chainsPerFailure.set(failId, chain);

                    // Weight every ancestor in this chain
                    for (const ancestorId of chain) {
                        ancestorFrequency.set(
                            ancestorId,
                            (ancestorFrequency.get(ancestorId) ?? 0) + 1
                        );
                    }
                }

                // ---------------------------------------------------------------
                // Phase 4 — Identify root cause candidate & confidence
                // ---------------------------------------------------------------

                let rootCauseId:    string | null = null;
                let rootCauseFreq:  number        = 0;

                // Prefer candidates that are actual root nodes (no parent);
                // if none found there, fall back to the most-frequent ancestor overall.
                for (const [id, freq] of ancestorFrequency) {
                    const isPreferred =
                        rootIds.has(id) || graph.get(id)?.checkpoint.parent_checkpoint_id === null;

                    if (
                        rootCauseId === null ||
                        freq > rootCauseFreq ||
                        (freq === rootCauseFreq && isPreferred)
                    ) {
                        rootCauseId   = id;
                        rootCauseFreq = freq;
                    }
                }

                // Edge case: all provided IDs were unknown — no analysis possible
                if (rootCauseId === null || knownFailIds.length === 0) {
                    return buildResponse({
                        error:                    "NO_KNOWN_FAILURES",
                        session_id,
                        unknown_checkpoint_ids:   unknownIds,
                        message:                  "None of the provided failed_checkpoint_ids were found in this session.",
                        total_checkpoints_analyzed: allCheckpoints.length,
                        timestamp:                new Date().toISOString(),
                    });
                }

                const rootCauseCheckpoint = checkpointById.get(rootCauseId)!;
                const confidenceScore = parseFloat(
                    ((rootCauseFreq / knownFailIds.length) * 100).toFixed(2)
                );

                // ---------------------------------------------------------------
                // Phase 5 — Build response
                // ---------------------------------------------------------------

                // Flatten failure chains: root → failure (reverse each chain)
                const failureChain: string[] = [];
                for (const [, chain] of chainsPerFailure) {
                    const ordered = [...chain].reverse(); // root first
                    for (const id of ordered) {
                        if (!failureChain.includes(id)) {
                            failureChain.push(id);
                        }
                    }
                }

                // Determine if root has siblings (multiple disconnected chains)
                const distinctRoots = new Set<string>();
                for (const [, chain] of chainsPerFailure) {
                    const rootOfChain = chain[chain.length - 1];
                    if (rootOfChain) distinctRoots.add(rootOfChain);
                }

                const isRootNode =
                    rootIds.has(rootCauseId) ||
                    !rootCauseCheckpoint.parent_checkpoint_id;

                // Human-readable analysis summary
                const summaryParts: string[] = [
                    `Root-cause candidate identified: checkpoint "${rootCauseId.slice(0, 8)}…" ` +
                    `(type: ${rootCauseCheckpoint.checkpoint_type}, ` +
                    `confidence: ${confidenceScore}%).`,
                ];

                if (distinctRoots.size > 1) {
                    summaryParts.push(
                        `${distinctRoots.size} disconnected failure chains detected. ` +
                        `The most common root was selected; other roots: ` +
                        [...distinctRoots]
                            .filter((id) => id !== rootCauseId)
                            .map((id) => `"${id.slice(0, 8)}…"`)
                            .join(", ") + "."
                    );
                }

                if (cyclesFound.size > 0) {
                    summaryParts.push(
                        `⚠️ Circular parent references detected and broken at: ` +
                        [...cyclesFound].map((id) => `"${id.slice(0, 8)}…"`).join(", ") + "."
                    );
                }

                if (unknownIds.length > 0) {
                    summaryParts.push(
                        `${unknownIds.length} provided checkpoint ID(s) were not found in session and were skipped.`
                    );
                }

                if (knownFailIds.length === 1 && isRootNode) {
                    summaryParts.push(
                        "Single failure checkpoint with no parent — it is the root-cause candidate (confidence 100%)."
                    );
                }

                const analysisSummary = summaryParts.join(" ");

                // Optionally include the full serialised graph for debugging
                let graphOutput: Record<string, unknown> | undefined;
                if (include_graph) {
                    const graphObj: Record<string, unknown> = {};
                    for (const [id, node] of graph) {
                        graphObj[id] = {
                            checkpoint_type: node.checkpoint.checkpoint_type,
                            parent_checkpoint_id: node.checkpoint.parent_checkpoint_id,
                            children: node.children,
                            content_preview: node.checkpoint.content.slice(0, 100),
                        };
                    }
                    graphOutput = graphObj;
                }

                return buildResponse({
                    session_id,
                    root_cause_candidate: {
                        checkpoint_id:   rootCauseCheckpoint.id,
                        checkpoint_type: rootCauseCheckpoint.checkpoint_type,
                        content:         rootCauseCheckpoint.content.slice(0, 200),
                        created_at:      rootCauseCheckpoint.created_at,
                        is_root_node:    isRootNode,
                    },
                    confidence_score:             confidenceScore,
                    failure_chain:                failureChain,
                    total_checkpoints_analyzed:   allCheckpoints.length,
                    failed_checkpoints_found:     knownFailIds.length,
                    unknown_checkpoint_ids:       unknownIds,
                    analysis_summary:             analysisSummary,
                    dependency_note:              "This analysis traces declared parent_checkpoint_id relationships. It identifies structural dependency ancestors, not proven real-world causation.",
                    ...(include_graph && graphOutput !== undefined && { graph: graphOutput }),
                    timestamp: new Date().toISOString(),
                });

            } catch (error) {
                return buildErrorResponse("analyze_causality", error);
            }
        }
    );
}

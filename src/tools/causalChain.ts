/**
 * AgentGuard MCP v3.1.2 — Tool: Causal Chain Analysis
 *
 * Reads checkpoint history from storage (SQLite recursive CTE or PostgreSQL)
 * and uses BFS graph traversal to trace failure propagation through parent_checkpoint_id links.
 * Supports optional bidirectional downstream impact tracing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import { readAll, countRecords, getLineageForFailuresAsync } from "../utils/storage.js";
import type { CheckpointEntry } from "../types/index.js";

interface GraphNode {
    checkpoint: CheckpointEntry;
    children: string[];
}

type Graph = Map<string, GraphNode>;

const MAX_GRAPH_NODES = 2000;

function buildGraph(checkpoints: CheckpointEntry[]): {
    graph: Graph;
    rootIds: Set<string>;
} {
    const graph: Graph = new Map();
    const rootIds = new Set<string>();

    for (const cp of checkpoints) {
        graph.set(cp.id, { checkpoint: cp, children: [] });
        if (!cp.parent_checkpoint_id) {
            rootIds.add(cp.id);
        }
    }

    for (const cp of checkpoints) {
        if (cp.parent_checkpoint_id && graph.has(cp.parent_checkpoint_id)) {
            graph.get(cp.parent_checkpoint_id)!.children.push(cp.id);
        }
    }

    return { graph, rootIds };
}

function ancestorChain(
    startId: string,
    graph: Graph,
    cyclesFound: Set<string>
): string[] {
    const chain: string[] = [];
    const visited: Set<string> = new Set();
    let current: string | null = startId;

    while (current !== null) {
        if (visited.has(current)) {
            cyclesFound.add(current);
            break;
        }
        visited.add(current);
        chain.push(current);

        const node = graph.get(current);
        if (!node) break;
        current = node.checkpoint.parent_checkpoint_id ?? null;
    }

    return chain;
}

function downstreamBFS(rootId: string, graph: Graph): string[] {
    const impacted: string[] = [];
    const visited = new Set<string>([rootId]);
    const queue: string[] = [...(graph.get(rootId)?.children ?? [])];

    while (queue.length > 0 && impacted.length < MAX_GRAPH_NODES) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) continue;
        visited.add(currentId);
        impacted.push(currentId);

        const node = graph.get(currentId);
        if (node) {
            for (const childId of node.children) {
                if (!visited.has(childId)) queue.push(childId);
            }
        }
    }

    return impacted;
}

export function causalChainTools(server: McpServer): void {
    server.registerTool(
        "analyze_causality",
        {
            description:
                "Traces failed checkpoints through their declared dependency graph and identifies the deepest common ancestor as a root-cause candidate. " +
                "Dependency is declared via parent_checkpoint_id — this traces structural dependency, not proven real-world causation.",
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
                        `Include dependency graph in response for debugging (capped at ${MAX_GRAPH_NODES} nodes).`
                    ),
                include_downstream: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Also perform downstream BFS from the root-cause candidate to list all impacted descendant checkpoints."
                    ),
            },
        },
        async ({ session_id, failed_checkpoint_ids, include_graph, include_downstream }) => {
            try {
                const totalCheckpointsInSession = await countRecords(session_id);

                if (totalCheckpointsInSession === 0) {
                    return buildResponse({
                        error: "SESSION_NOT_FOUND",
                        session_id,
                        message: `No checkpoints found for session "${session_id}". ` +
                            "Ensure log_checkpoint was called with this session_id.",
                        timestamp: new Date().toISOString(),
                    });
                }

                const lineageCheckpoints = await getLineageForFailuresAsync(session_id, failed_checkpoint_ids);
                let allCheckpoints = lineageCheckpoints;
                let graphTruncated = false;

                if (include_graph || include_downstream) {
                    const full = await readAll<CheckpointEntry>(session_id);
                    if (full.length > MAX_GRAPH_NODES) {
                        allCheckpoints = full.slice(-MAX_GRAPH_NODES);
                        graphTruncated = true;
                    } else {
                        allCheckpoints = full;
                    }
                }

                const checkpointById = new Map<string, CheckpointEntry>(
                    allCheckpoints.map((cp) => [cp.id, cp])
                );

                const unknownIds: string[] = [];
                const knownFailIds: string[] = [];

                for (const id of failed_checkpoint_ids) {
                    if (checkpointById.has(id)) {
                        knownFailIds.push(id);
                    } else {
                        unknownIds.push(id);
                    }
                }

                const { graph, rootIds } = buildGraph(allCheckpoints);
                const cyclesFound = new Set<string>();

                const ancestorFrequency = new Map<string, number>();
                const chainsPerFailure = new Map<string, string[]>();

                for (const failId of knownFailIds) {
                    const chain = ancestorChain(failId, graph, cyclesFound);
                    chainsPerFailure.set(failId, chain);

                    for (const ancestorId of chain) {
                        ancestorFrequency.set(
                            ancestorId,
                            (ancestorFrequency.get(ancestorId) ?? 0) + 1
                        );
                    }
                }

                let rootCauseId: string | null = null;
                let rootCauseFreq = 0;

                for (const [id, freq] of ancestorFrequency) {
                    const isPreferred =
                        rootIds.has(id) || graph.get(id)?.checkpoint.parent_checkpoint_id === null;

                    if (
                        rootCauseId === null ||
                        freq > rootCauseFreq ||
                        (freq === rootCauseFreq && isPreferred)
                    ) {
                        rootCauseId = id;
                        rootCauseFreq = freq;
                    }
                }

                if (rootCauseId === null || knownFailIds.length === 0) {
                    return buildResponse({
                        error: "NO_KNOWN_FAILURES",
                        session_id,
                        unknown_checkpoint_ids: unknownIds,
                        message: "None of the provided failed_checkpoint_ids were found in this session.",
                        total_checkpoints_analyzed: totalCheckpointsInSession,
                        timestamp: new Date().toISOString(),
                    });
                }

                const rootCauseCheckpoint = checkpointById.get(rootCauseId)!;
                const confidenceScore = parseFloat(
                    ((rootCauseFreq / knownFailIds.length) * 100).toFixed(2)
                );

                const failureChain: string[] = [];
                for (const [, chain] of chainsPerFailure) {
                    const ordered = [...chain].reverse();
                    for (const id of ordered) {
                        if (!failureChain.includes(id)) {
                            failureChain.push(id);
                        }
                    }
                }

                const distinctRoots = new Set<string>();
                for (const [, chain] of chainsPerFailure) {
                    const rootOfChain = chain[chain.length - 1];
                    if (rootOfChain) distinctRoots.add(rootOfChain);
                }

                const isRootNode =
                    rootIds.has(rootCauseId) ||
                    !rootCauseCheckpoint.parent_checkpoint_id;

                const summaryParts: string[] = [
                    `Root-cause candidate identified: checkpoint "${rootCauseId.slice(0, 8)}…" ` +
                    `(type: ${rootCauseCheckpoint.checkpoint_type}, ` +
                    `convergence: ${confidenceScore}% across ${knownFailIds.length} failure(s)).`,
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

                if (knownFailIds.length === 1) {
                    summaryParts.push(
                        isRootNode
                            ? "Single failure trace with no parent — structural root of its chain (100% single-chain trace)."
                            : "Single failure trace — supply multiple failed_checkpoint_ids for multi-branch convergence confidence."
                    );
                }

                const downstreamImpact = include_downstream
                    ? downstreamBFS(rootCauseId, graph)
                    : undefined;

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
                        checkpoint_id: rootCauseCheckpoint.id,
                        checkpoint_type: rootCauseCheckpoint.checkpoint_type,
                        content: rootCauseCheckpoint.content.slice(0, 200),
                        created_at: rootCauseCheckpoint.created_at,
                        is_root_node: isRootNode,
                    },
                    confidence_score: confidenceScore,
                    failure_chain: failureChain,
                    ...(downstreamImpact !== undefined && {
                        downstream_impact_ids: downstreamImpact,
                        downstream_impact_count: downstreamImpact.length,
                    }),
                    total_checkpoints_analyzed: totalCheckpointsInSession,
                    failed_checkpoints_found: knownFailIds.length,
                    unknown_checkpoint_ids: unknownIds,
                    analysis_summary: summaryParts.join(" "),
                    dependency_note:
                        "This analysis traces declared parent_checkpoint_id relationships. It identifies structural dependency ancestors, not proven real-world causation.",
                    ...(graphTruncated && { graph_truncated: true, max_graph_nodes: MAX_GRAPH_NODES }),
                    ...(include_graph && graphOutput !== undefined && { graph: graphOutput }),
                    timestamp: new Date().toISOString(),
                });
            } catch (error) {
                return buildErrorResponse("analyze_causality", error);
            }
        }
    );
}

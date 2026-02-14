"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import dynamic from "next/dynamic";

// Dynamically import to avoid SSR issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph2D = dynamic<any>(
  () => import("react-force-graph-2d").then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
        Loading graph...
      </div>
    ),
  }
);

export type GraphEntity = {
  entityId: string;
  typeName: string;
  name: string;
};

export type GraphRelationship = {
  relationshipId: string;
  fromTypeName: string;
  fromName: string;
  toTypeName: string;
  toName: string;
  relationshipType: string;
};

// Color palette for entity types (hex values for canvas drawing)
const TYPE_COLORS: Record<string, string> = {
  E_Person: "#8b5cf6",        // violet
  E_Organization: "#3b82f6",  // blue
  E_Location: "#10b981",      // emerald
  E_Money: "#f59e0b",         // amber
  E_Invoice: "#ef4444",       // red
  E_Date: "#06b6d4",          // cyan
  E_Product: "#f97316",       // orange
  E_Service: "#6366f1",       // indigo
  E_Project: "#14b8a6",       // teal
  E_Event: "#ec4899",         // pink
  E_Account: "#a855f7",       // purple
  E_Document: "#64748b",      // slate
  E_BankAccount: "#22c55e",   // green
  E_Address: "#eab308",       // yellow
  E_PhoneNumber: "#78716c",   // stone
  E_Deadline: "#dc2626",      // red-600
};

function getTypeColor(typeName: string): string {
  return TYPE_COLORS[typeName] ?? "#6b7280"; // default gray
}

// Strip E_ prefix for display
function displayTypeName(typeName: string): string {
  return typeName.startsWith("E_") ? typeName.slice(2) : typeName;
}

// Truncate long names
function truncateName(name: string, maxLength: number = 20): string {
  if (name.length <= maxLength) return name;
  return name.slice(0, maxLength - 2) + "...";
}

type GraphNode = {
  id: string;
  name: string;
  typeName: string;
  color: string;
  val: number;
};

type GraphLink = {
  source: string;
  target: string;
  relationshipType: string;
};

type GraphData = {
  nodes: GraphNode[];
  links: GraphLink[];
};

export function EntityGraph(props: {
  entities: GraphEntity[];
  relationships: GraphRelationship[];
  height?: number;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<{ d3Force: (name: string) => { strength: (s: number) => void } | null }>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: props.height ?? 500 });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // Update dimensions on resize
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.offsetWidth,
          height: props.height ?? 500,
        });
      }
    };
    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, [props.height]);

  // Build graph data from entities and relationships
  const graphData = useMemo((): GraphData => {
    const nodeMap = new Map<string, GraphNode>();

    // Add all entities as nodes
    for (const entity of props.entities) {
      const nodeId = `${entity.typeName}:${entity.name.toLowerCase()}`;
      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId,
          name: entity.name,
          typeName: entity.typeName,
          color: getTypeColor(entity.typeName),
          val: 1,
        });
      }
    }

    // Build links from relationships
    const links: GraphLink[] = [];
    for (const rel of props.relationships) {
      const sourceId = `${rel.fromTypeName}:${rel.fromName.toLowerCase()}`;
      const targetId = `${rel.toTypeName}:${rel.toName.toLowerCase()}`;

      // Ensure both nodes exist
      if (!nodeMap.has(sourceId)) {
        nodeMap.set(sourceId, {
          id: sourceId,
          name: rel.fromName,
          typeName: rel.fromTypeName,
          color: getTypeColor(rel.fromTypeName),
          val: 1,
        });
      }
      if (!nodeMap.has(targetId)) {
        nodeMap.set(targetId, {
          id: targetId,
          name: rel.toName,
          typeName: rel.toTypeName,
          color: getTypeColor(rel.toTypeName),
          val: 1,
        });
      }

      links.push({
        source: sourceId,
        target: targetId,
        relationshipType: rel.relationshipType,
      });
    }

    // Increase node size based on connection count
    const connectionCount = new Map<string, number>();
    for (const link of links) {
      connectionCount.set(link.source, (connectionCount.get(link.source) ?? 0) + 1);
      connectionCount.set(link.target, (connectionCount.get(link.target) ?? 0) + 1);
    }
    for (const node of nodeMap.values()) {
      const count = connectionCount.get(node.id) ?? 0;
      node.val = 1 + Math.min(count * 0.5, 3);
    }

    return {
      nodes: Array.from(nodeMap.values()),
      links,
    };
  }, [props.entities, props.relationships]);

  // Get unique types for legend
  const uniqueTypes = useMemo(() => {
    const types = new Set(graphData.nodes.map((n) => n.typeName));
    return Array.from(types).sort();
  }, [graphData.nodes]);

  if (props.entities.length === 0 && props.relationships.length === 0) {
    return (
      <div
        className={`flex items-center justify-center text-sm text-[var(--muted)] ${props.className}`}
        style={{ height: props.height ?? 500 }}
      >
        No graph data available yet.
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`relative ${props.className ?? ""}`}>
      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="#fafafa"
        nodeRelSize={8}
        nodeVal={(node: GraphNode) => node.val}
        nodeColor={(node: GraphNode) => node.color}
        nodeLabel={(node: GraphNode) => `${displayTypeName(node.typeName)}: ${node.name}`}
        linkColor={() => "#cbd5e1"}
        linkWidth={1.5}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0.1}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.4}
        cooldownTime={2000}
        onNodeClick={(node: GraphNode) => setSelectedNode(node)}
        onBackgroundClick={() => setSelectedNode(null)}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        enableNodeDrag={true}
        minZoom={0.5}
        maxZoom={4}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onEngineStop={() => {
          // Adjust forces after initial render
          if (graphRef.current) {
            const charge = graphRef.current.d3Force("charge");
            if (charge) charge.strength(-150);
          }
        }}
      />

      {/* Legend - top left */}
      <div className="absolute top-3 left-3 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="text-xs font-semibold text-slate-700 mb-2">Entity Types</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {uniqueTypes.map((typeName) => (
            <div key={typeName} className="flex items-center gap-2">
              <div
                className="h-3 w-3 rounded-full shadow-sm"
                style={{ backgroundColor: getTypeColor(typeName) }}
              />
              <span className="text-xs text-slate-600">{displayTypeName(typeName)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Selected node details - top right */}
      {selectedNode && (
        <div className="absolute top-3 right-3 max-w-[200px] rounded-xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur">
          <div className="flex items-center gap-2 mb-1">
            <div
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: selectedNode.color }}
            />
            <span className="text-xs font-medium text-slate-500">
              {displayTypeName(selectedNode.typeName)}
            </span>
          </div>
          <div className="text-sm font-semibold text-slate-800 break-words">
            {selectedNode.name}
          </div>
          <button
            onClick={() => setSelectedNode(null)}
            className="mt-2 text-xs text-slate-400 hover:text-slate-600"
          >
            Click background to close
          </button>
        </div>
      )}

      {/* Instructions - bottom right */}
      <div className="absolute bottom-3 right-3 text-[10px] text-slate-400">
        Drag to move • Scroll to zoom • Click node for details
      </div>
    </div>
  );
}

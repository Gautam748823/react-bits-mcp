import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const REGISTRY_URL = "https://reactbits.dev/r/registry.json";
const COMPONENT_URL = "https://reactbits.dev/r/";

type RegistryItem = {
  name: string;
  title?: string;
  description?: string;
  type?: string;
  dependencies?: string[];
  deps?: string[];
  registryDependencies?: string[];
  files?: Array<{ path?: string; type?: string }>;
};

type ComponentGroup = {
  name: string;
  title?: string;
  description?: string;
  variants: Array<{
    name: string;
    language: "JavaScript" | "TypeScript" | "Unknown";
    styling: "CSS" | "Tailwind" | "Unknown";
    dependencies: string[];
    registryDependencies: string[];
    files: string[];
  }>;
};

async function getRegistry(): Promise<RegistryItem[]> {
  const response = await fetch(REGISTRY_URL, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!response.ok) throw new Error(`React Bits registry returned HTTP ${response.status}`);

  const data = await response.json() as { items?: RegistryItem[] };
  if (!Array.isArray(data.items)) {
    throw new Error("React Bits registry response did not contain an items list");
  }
  return data.items;
}

// The public registry contains one entry per language/styling variant.
// Group those entries so list/search limits count unique component names.
function groupComponents(items: RegistryItem[]): ComponentGroup[] {
  const groups = new Map<string, ComponentGroup>();

  for (const item of items) {
    const match = item.name.match(/^(.*)-(JS|TS)-(CSS|TW)$/);
    const componentName = match?.[1] ?? item.name;

    if (!groups.has(componentName)) {
      groups.set(componentName, {
        name: componentName,
        title: item.title,
        description: item.description,
        variants: []
      });
    }

    const group = groups.get(componentName)!;
    if (!group.title && item.title) group.title = item.title;
    if (!group.description && item.description) group.description = item.description;

    group.variants.push({
      name: item.name,
      language: match?.[2] === "JS" ? "JavaScript" : match?.[2] === "TS" ? "TypeScript" : "Unknown",
      styling: match?.[3] === "CSS" ? "CSS" : match?.[3] === "TW" ? "Tailwind" : "Unknown",
      dependencies: item.dependencies ?? item.deps ?? [],
      registryDependencies: item.registryDependencies ?? [],
      files: (item.files ?? []).map(file => file.path).filter((path): path is string => Boolean(path))
    });
  }

  return Array.from(groups.values());
}

function createServer() {
  const server = new McpServer({ name: "react-bits-mcp-server", version: "1.1.0" });

  server.registerTool(
    "list_components",
    {
      description: "List unique React Bits components. Each result includes all available JS/TS and CSS/Tailwind variants. The limit counts unique component names, not variants.",
      inputSchema: {
        query: z.string().optional().describe("Optional filter by component name or description"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum unique components to return; default 10")
      }
    },
    async ({ query, limit }) => {
      try {
        const groups = groupComponents(await getRegistry());
        const needle = query?.trim().toLowerCase();
        const filtered = needle
          ? groups.filter(group =>
              `${group.name} ${group.title ?? ""} ${group.description ?? ""} ${group.variants.map(v => v.name).join(" ")}`
                .toLowerCase().includes(needle)
            )
          : groups;
        const selected = filtered.slice(0, limit ?? 10);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              totalComponents: groups.length,
              matchingComponents: filtered.length,
              returnedComponents: selected.length,
              totalVariantsInRegistry: groups.reduce((sum, group) => sum + group.variants.length, 0),
              components: selected
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "Could not read React Bits registry" }]
        };
      }
    }
  );

  server.registerTool(
    "search_components",
    {
      description: "Search unique React Bits components by name or description. Each match includes all available variants.",
      inputSchema: {
        query: z.string().min(1).describe("Search phrase, for example text animation, background, cursor, or SplitText"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum unique components to return; default 10")
      }
    },
    async ({ query, limit }) => {
      try {
        const groups = groupComponents(await getRegistry());
        const terms = query.toLowerCase().split(/\\s+/).filter(Boolean);
        const matches = groups.filter(group => {
          const haystack = `${group.name} ${group.title ?? ""} ${group.description ?? ""} ${group.variants.map(v => v.name).join(" ")}`.toLowerCase();
          return terms.every(term => haystack.includes(term));
        });
        const selected = matches.slice(0, limit ?? 10);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              totalMatches: matches.length,
              returnedComponents: selected.length,
              components: selected
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "Search failed" }]
        };
      }
    }
  );

  server.registerTool(
    "get_component",
    {
      description: "Fetch an exact React Bits registry variant, including source file contents, dependencies and setup metadata.",
      inputSchema: {
        name: z.string().min(1).max(120).describe("Exact variant name returned by search, e.g. SplitText-JS-CSS")
      }
    },
    async ({ name }) => {
      if (!/^[A-Za-z0-9]+-(?:JS|TS)-(?:CSS|TW)$/.test(name)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Use an exact React Bits variant name, e.g. SplitText-JS-CSS." }]
        };
      }

      try {
        const response = await fetch(`${COMPONENT_URL}${encodeURIComponent(name)}.json`, {
          headers: { Accept: "application/json" },
          cf: { cacheTtl: 300, cacheEverything: true }
        });
        if (!response.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: `React Bits returned HTTP ${response.status} for ${name}. Search the registry for a valid variant.` }]
          };
        }

        const item = await response.json() as Record<string, unknown>;
        if (!item || typeof item !== "object" || !Array.isArray(item.files)) {
          return {
            isError: true,
            content: [{ type: "text", text: "React Bits returned an unexpected registry item format." }]
          };
        }

        return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "Could not fetch component source" }]
        };
      }
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return mcpHandler(request, env, ctx);
  }
} satisfies ExportedHandler;

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

const REGISTRY_URL = "https://reactbits.dev/r/registry.json";
const COMPONENT_URL = "https://reactbits.dev/r/";

type RegistryItem = {
  name: string;
  title?: string;
  description?: string;
  type?: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files?: Array<{ path?: string; type?: string }>;
};

async function getRegistry(): Promise<RegistryItem[]> {
  const response = await fetch(REGISTRY_URL, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!response.ok) {
    throw new Error(`React Bits registry returned HTTP ${response.status}`);
  }
  const data = await response.json() as { items?: RegistryItem[] };
  if (!Array.isArray(data.items)) {
    throw new Error("React Bits registry response did not contain an items list");
  }
  return data.items;
}

function createServer() {
  const server = new McpServer({
    name: "react-bits-mcp-server",
    version: "1.0.0"
  });

  server.registerTool(
    "list_components",
    {
      description: "List React Bits components and available variants. Supports optional filtering by component name or description. Variants include JS-CSS, JS-TW, TS-CSS and TS-TW.",
      inputSchema: {
        query: z.string().optional().describe("Optional text to filter component names and descriptions"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of variants to return (default 30, max 100)")
      }
    },
    async ({ query, limit }) => {
      try {
        const items = await getRegistry();
        const needle = query?.trim().toLowerCase();
        const filtered = needle
          ? items.filter(item =>
              item.name.toLowerCase().includes(needle) ||
              (item.description ?? "").toLowerCase().includes(needle) ||
              (item.title ?? "").toLowerCase().includes(needle)
            )
          : items;
        const results = filtered.slice(0, limit ?? 30).map(item => ({
          name: item.name,
          title: item.title,
          description: item.description,
          dependencies: item.dependencies ?? [],
          registryDependencies: item.registryDependencies ?? [],
          files: (item.files ?? []).map(file => file.path).filter(Boolean)
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              totalMatches: filtered.length,
              returned: results.length,
              components: results
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
      description: "Search the official React Bits registry by component name or description and return matching variants, dependencies and file paths.",
      inputSchema: {
        query: z.string().min(1).describe("Search phrase, for example text animation, background, cursor, or SplitText"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of matches (default 20, max 50)")
      }
    },
    async ({ query, limit }) => {
      try {
        const items = await getRegistry();
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = items.filter(item => {
          const haystack = `${item.name} ${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
          return terms.every(term => haystack.includes(term));
        });
        const results = matches.slice(0, limit ?? 20).map(item => ({
          name: item.name,
          title: item.title,
          description: item.description,
          dependencies: item.dependencies ?? [],
          files: (item.files ?? []).map(file => file.path).filter(Boolean)
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              totalMatches: matches.length,
              returned: results.length,
              components: results
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
      description: "Fetch the full official React Bits registry item for one exact component variant, including source file contents when provided by the registry. Use a name returned by list_components or search_components, such as SplitText-JS-CSS.",
      inputSchema: {
        name: z.string().min(1).max(120).describe("Exact React Bits variant name, e.g. SplitText-JS-CSS")
      }
    },
    async ({ name }) => {
      if (!/^[A-Za-z0-9]+-(?:JS|TS)-(?:CSS|TW)$/.test(name)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid component name. Use an exact variant such as SplitText-JS-CSS, ending in JS-CSS, JS-TW, TS-CSS, or TS-TW." }]
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
            content: [{ type: "text", text: `React Bits could not find "${name}" (HTTP ${response.status}). Search the registry for the exact variant name first.` }]
          };
        }

        const item = await response.json() as Record<string, unknown>;
        if (!item || typeof item !== "object" || !Array.isArray(item.files)) {
          return {
            isError: true,
            content: [{ type: "text", text: "The React Bits endpoint did not return a valid component registry item." }]
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(item, null, 2)
          }]
        };
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

export default createMcpHandler(createServer);

import { json, options } from "@/lib/api/http";
import { MCP_INSTRUCTIONS, MCP_PROTOCOL_VERSIONS, MCP_SERVER_INFO, mcpToolNames } from "@/lib/api/mcp";
import { baseUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Discovery card for MCP clients (SEP-2127 shape): where the server is and how to talk to it. */
export async function GET() {
  const base = baseUrl();
  return json(
    {
      version: "1",
      servers: [
        {
          name: MCP_SERVER_INFO.name,
          title: MCP_SERVER_INFO.title,
          description: MCP_INSTRUCTIONS,
          url: `${base}/mcp`,
          transport: "streamable-http",
          protocolVersions: MCP_PROTOCOL_VERSIONS,
          authentication: { type: "none", optional: { type: "bearer", howToGet: `${base}/api/v1/keys` } },
          tools: mcpToolNames(),
          documentation: `${base}/developers`,
          openapi: `${base}/api/openapi.json`,
          llms: `${base}/llms.txt`,
          license: { code: "Apache-2.0", data: "CC-BY-4.0" },
        },
      ],
    },
    { cache: "public, max-age=300, s-maxage=3600" },
  );
}

export async function OPTIONS() {
  return options();
}

// MCP (Streamable HTTP, JSON responses) so Grok Bot can drive Idea → Product as a custom connector.
// Dependency-free: implements initialize / tools/list / tools/call / ping over JSON-RPC.

const tool = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: "object", properties, required } });

export const MCP_TOOLS = [
  tool("build_prototype", "Build a clickable prototype of an app/product idea LIVE in the user's Idea → Product studio (they watch it stream in). Use for any 'build/make/create an app/site/tool' request.", { idea: { type: "string", description: "What to build, in detail" } }, ["idea"]),
  tool("ship_current", "Ship the prototype currently open in the studio: write SPEC.md, create a private GitHub repo with the user's .cursor/rules, and have an agent build the MVP and open a PR."),
  tool("capture", "Capture anything quickly. The app decides if it's an idea, note, task (with due date) or a change to an existing project, and handles reminders like 'by end of week'.", { text: { type: "string" }, kind: { type: "string", enum: ["auto", "idea", "note", "task", "project"] } }, ["text"]),
  tool("set_reminder", "Remind the user later (macOS notification). Defaults to Friday 5pm.", { text: { type: "string" }, at: { type: "string", description: "ISO datetime; omit for end of week" } }, ["text"]),
  tool("start_job", "Run a background job on a shipped project: deep web research (RESEARCH.md), docs (PRD/architecture/user guide), or pitch & launch plan. Commits to the repo and notifies the user.", { type: { type: "string", enum: ["research", "docs", "pitch"] }, project: { type: "string", description: "project slug from list_projects" } }, ["type", "project"]),
  tool("update_project", "Send a change/feature request to an existing shipped project (Cursor agent, or a GitHub issue).", { project: { type: "string" }, instruction: { type: "string" } }, ["project", "instruction"]),
  tool("list_projects", "List the user's shipped projects with repo/PR links."),
  tool("list_tasks", "List open tasks and upcoming reminders."),
  tool("list_notes", "List recent notes (including research/docs job outputs)."),
  tool("remember", "Save a durable fact or preference about the user (applies to all their future projects and ships as Cursor rules).", { fact: { type: "string" }, scope: { type: "string", description: "global | project:<slug> | files:<glob>" } }, ["fact"]),
];

export async function handleMcp(body, ctx) {
  const one = async (msg) => {
    const { id, method, params = {} } = msg || {};
    if (id === undefined || id === null) return null; // notification
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      if (method === "initialize") return ok({ protocolVersion: params.protocolVersion || "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "idea-to-product", version: "1.0.0" }, instructions: "Idea → Product: turn any thought into a live prototype, a GitHub repo and an MVP. The user watches the studio on screen; build_prototype streams there live." });
      if (method === "ping") return ok({});
      if (method === "tools/list") return ok({ tools: MCP_TOOLS });
      if (method === "tools/call") {
        const text = await ctx.callTool(params.name, params.arguments || {});
        return ok({ content: [{ type: "text", text }] });
      }
      return fail(-32601, `Method not found: ${method}`);
    } catch (e) {
      if (method === "tools/call") return ok({ content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true });
      return fail(-32603, String(e.message || e));
    }
  };
  if (Array.isArray(body)) { const out = (await Promise.all(body.map(one))).filter(Boolean); return out.length ? out : null; }
  return one(body);
}

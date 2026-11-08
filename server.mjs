// Napkin → App: zero-dependency Node server that proxies Grok vision (streaming)
// plus a persistent memory layer (who you are, what you work on, what you've built).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ship, agentStatus, updateProject, commitFiles, cursorStatus } from "./ship.mjs";
import { handleMcp } from "./mcp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.XAI_API_KEY;
const MODEL = process.env.XAI_MODEL || "grok-4";
const PORT = Number(process.env.PORT || 3000);
const XAI = process.env.XAI_BASE_URL || "https://api.x.ai/v1";

// ---------------- memory ----------------
const MEM_PATH = path.join(__dirname, "memory.json");
const EMPTY_MEM = { profile: "", facts: [], history: [], projects: [], notes: [], tasks: [], reminders: [], fired: [], sessions: [], lastDigestWeek: null };

function loadMemory() {
  for (const p of [MEM_PATH, MEM_PATH + ".bak"]) {
    try { return { ...structuredClone(EMPTY_MEM), ...JSON.parse(fs.readFileSync(p, "utf8")) }; } catch {}
  }
  return structuredClone(EMPTY_MEM);
}
function saveMemory(mem) {
  mem.facts = (mem.facts || []).slice(-60);
  mem.history = (mem.history || []).slice(-30);
  const tmp = MEM_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
  try { if (fs.existsSync(MEM_PATH)) fs.copyFileSync(MEM_PATH, MEM_PATH + ".bak"); } catch {}
  fs.renameSync(tmp, MEM_PATH); // atomic: never leaves a half-written file
}
// A fact is { text, scope }: scope = "global" | "project:<slug>" | "files:<glob>"
function normScope(scope, project) {
  const s = String(scope || "global").trim();
  if (s === "project") return project ? `project:${project}` : "global";
  if (/^(global|project:[\w-]+|files:.+)$/.test(s)) return s;
  return "global";
}
function addFacts(newFacts = [], project = "") {
  const mem = loadMemory();
  const seen = new Set(mem.facts.map((f) => f.text.toLowerCase()));
  const added = [];
  for (const t of newFacts) {
    const text = String((t && typeof t === "object" ? t.text : t) || "").trim();
    if (text && !seen.has(text.toLowerCase())) {
      const fact = { text, scope: normScope(t?.scope, project), at: new Date().toISOString() };
      mem.facts.push(fact); added.push(fact); seen.add(text.toLowerCase());
    }
  }
  if (added.length) saveMemory(mem);
  return added;
}
function addHistory(entry) {
  const mem = loadMemory();
  mem.history.push({ ...entry, at: new Date().toISOString() });
  saveMemory(mem);
}
function memoryContext() {
  const mem = loadMemory();
  const parts = [];
  if (mem.profile.trim()) parts.push(`About the user (written by them):\n${mem.profile.trim()}`);
  if (mem.facts.length) parts.push(`Things learned about the user (scope in brackets):\n${mem.facts.map((f) => `- [${f.scope || "global"}] ${f.text}`).join("\n")}`);
  if (mem.history.length)
    parts.push(`Recent things they built/changed (oldest first):\n${mem.history.slice(-10).map((h) => `- [${h.kind}] ${h.title || ""} ${h.instruction ? `— "${h.instruction}"` : ""}`).join("\n")}`);
  return parts.length ? parts.join("\n\n") : "Nothing known about the user yet.";
}
const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/i)?.[1] || "").trim();

// ---------------- prompts ----------------
const SYSTEM = `You are a world-class front-end engineer. The user shows you a photo of a hand-drawn sketch (paper, napkin, whiteboard) of an app or UI.
Turn it into a single, complete, WORKING, delightful web app.

Rules:
- Output ONLY one HTML document, starting with <!doctype html> and ending with </html>. No markdown fences, no commentary.
- All CSS and JS inline. No external requests except optional Google Fonts. No images from the web; use emoji, CSS or inline SVG.
- Faithfully follow the sketch's layout, labels and handwritten text, but make it beautiful: modern typography, good spacing, tasteful color, subtle animations.
- Make every button and input actually work with realistic sample data. If it's a game, make it playable. If it's a tool, make it functional.
- Use what you know about the user (below) to pick realistic sample data, tone and small touches that fit them, without contradicting the sketch.
- Put <style> early in <head> so the page looks good while it streams in. Include a short <title>.
- HARD LIMIT: about 150 lines total. Compact CSS (one rule per line), no comments, no long sample data. Speed matters: this is being built live on stage.`;

const EDIT_SYSTEM = `You are a world-class front-end engineer editing an existing single-file web app.
Apply the user's requested change and return the FULL updated HTML document only, starting with <!doctype html>. No markdown fences, no commentary. Keep everything else working. Stay compact: no comments, one CSS rule per line, don't grow the file.
Use what you know about the user (below) to interpret vague requests the way they'd most likely mean them.
If there is no app yet, create a brand-new clickable prototype: HARD LIMIT about 150 lines, compact CSS, no comments, no login/auth screens, realistic sample data, delightful but small. It is being built live on stage, so speed matters.`;

const INTENT_SYSTEM = `You are the intent layer of "Napkin → App", a live tool that turns sketches into working web apps and edits them on request.
You have a memory of the user. When they say something (often short, vague, or spoken), infer what they most likely want, using their memory, the current app, and their history.

Return ONLY a JSON object with this shape:
{
  "understood": "one short sentence restating what they said, in plain words",
  "intentions": [ { "label": "short guess at the underlying goal", "why": "the clue from memory/context, max 12 words", "confidence": 0.0-1.0 } ],
  "suggestions": [ { "label": "button text, max 6 words", "instruction": "a precise, self-contained edit instruction for the app" } ],
  "question": "one short clarifying question to ask them, or empty string if intent is obvious",
  "remember": [ { "text": "durable fact or preference worth saving long-term (role, projects, tools, coding/design preferences, people, goals)", "scope": "global | project | files:<glob>" } ]
}
"remember" rules: only NEW info the user explicitly stated in THIS message; empty array if none (that's the usual case). Each fact is a full sentence about the user ("Lives with 3 roommates"), never a single word. Never derive facts from history, the current app, or your own suggestions.
Scope: "global" = applies to everything they build (who they are, general taste, favorite stack). "project" = only about the current idea/app. "files:<glob>" = a preference for certain files, e.g. "files:**/*.css" for styling rules, "files:**/*.test.*" for testing rules, "files:src/api/**" for API code.

Rules:
- 2-3 intentions, ranked. 3 suggestions: the first is the literal request done well; the other two are what they might really want given who they are.
- If there is no current app, suggestions should be ideas for an app to sketch/build that fit them; set instruction to a one-line app description.
- Personalize visibly: reference their projects/preferences when relevant. Never invent facts about them.
- Be concise: "why" max 12 words, "understood" max 20 words. No markdown.`;

const AFTER_BUILD_SYSTEM = `You are the intent layer of "Napkin → App". The user just built an app from a sketch. Using their memory, suggest what they'd most likely want next.
Return ONLY JSON: { "understood": "", "intentions": [ { "label": "...", "why": "...", "confidence": 0.0-1.0 } ], "suggestions": [ { "label": "max 6 words", "instruction": "precise edit instruction" } ], "question": "short question asking which direction they want", "remember": [] }
Give 1-2 intentions and exactly 3 suggestions tailored to who they are and what they work on. The app is already complete and working; suggest upgrades, not fixes. "understood" = max 15 words describing the app. "why" max 12 words. No markdown.`;

// ---------------- helpers ----------------
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return JSON.parse(data || "{}");
}

async function grokJSON(messages, { timeoutMs = 60000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${XAI}/chat/completions`, {
        method: "POST", signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.3, response_format: { type: "json_object" } }),
      });
      const j = await r.json();
      if (!r.ok) { const e = new Error(`xAI ${r.status}: ${JSON.stringify(j).slice(0, 300)}`); if (r.status < 500 && r.status !== 429) throw Object.assign(e, { fatal: true }); throw e; }
      const text = j.choices?.[0]?.message?.content || "{}";
      return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch (e) { lastErr = e; if (e.fatal) break; await new Promise((r) => setTimeout(r, 800)); }
  }
  throw lastErr;
}

// Streams Grok's text to the client and resolves with the full text.
async function streamGrok(res, messages) {
  if (!KEY) {
    send(res, 500, { error: "XAI_API_KEY missing. Put it in .env and restart." });
    return null;
  }
  let upstream;
  for (let attempt = 0; attempt < 2; attempt++) { // one retry if the connection fails before streaming starts
    try {
      upstream = await fetch(`${XAI}/chat/completions`, {
        method: "POST", signal: AbortSignal.timeout(120000),
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.4 }),
      });
      if (upstream.ok || upstream.status < 500) break;
    } catch (e) { if (attempt) { send(res, 504, { error: "Grok didn't respond in time. Try again." }); return null; } }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    console.error("xAI error", upstream.status, text);
    send(res, upstream.status || 502, { error: `xAI ${upstream.status}: ${text.slice(0, 400)}` });
    return null;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
  const decoder = new TextDecoder();
  let buf = "", full = "";
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) { res.write(delta); full += delta; }
      } catch {}
    }
  }
  res.end();
  return full;
}

// ---------------- routes ----------------
// ---------------- live events → studio (so Grok Bot can drive it) ----------------
const studios = new Set();
function broadcast(evt) { const line = `data: ${JSON.stringify(evt)}\n\n`; for (const r of studios) { try { r.write(line); } catch {} } return studios.size; }
setInterval(() => broadcast({ type: "ping" }), 25000);

// ---------------- Grok Bot tools (MCP) ----------------
async function callTool(name, a) {
  const mem = loadMemory();
  const local = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  if (name === "build_prototype") {
    if (!broadcast({ type: "build", idea: a.idea, from: "Grok Bot" })) throw new Error("The Idea → Product studio isn't open. Ask the user to open it.");
    return `Building "${a.idea}" live in the user's studio now (about 20-30s). It saves to their History; call ship_current afterwards to ship it.`;
  }
  if (name === "ship_current") {
    if (!broadcast({ type: "ship", from: "Grok Bot" })) throw new Error("The studio isn't open.");
    return "Shipping the current prototype: SPEC.md → private GitHub repo with the user's .cursor/rules → agent builds the MVP → PR. Use list_projects in ~1 minute for links.";
  }
  if (name === "capture") {
    const c = await local("/api/capture", { text: a.text, kind: a.kind && a.kind !== "auto" ? a.kind : null });
    if (c.error) throw new Error(c.error);
    broadcast({ type: "refresh" });
    if (c.kind === "idea") { broadcast({ type: "build", idea: c.item.body, from: "Grok Bot" }); return `That's an idea, so I'm building it live in the studio: ${c.item.title}`; }
    if (c.kind === "project" && c.project) { const u = await updateProject(c.project, c.item.body); broadcast({ type: "toast", text: `🤖 Grok Bot sent a change to ${c.project.title}` }); return `Sent to ${c.project.title} via ${u.via}${u.url ? `: ${u.url}` : ""}`; }
    broadcast({ type: "toast", text: `🤖 Grok Bot: ${c.kind === "task" ? "✅ task" : "📝 note"} “${c.item.title}”${c.reminder ? " · 🔔 reminder set" : ""}` });
    return `Saved as ${c.kind}: ${c.item.title}${c.due ? ` (due ${c.due})` : ""}${c.reminder ? `; reminder at ${c.reminder.at}` : ""}`;
  }
  if (name === "set_reminder") {
    const r = addReminder({ text: a.text, at: a.at && !isNaN(Date.parse(a.at)) ? new Date(a.at).toISOString() : endOfWeek().toISOString() });
    broadcast({ type: "toast", text: `🤖 Grok Bot set a reminder: ${a.text}` }); broadcast({ type: "refresh" });
    return `Reminder set for ${new Date(r.at).toLocaleString("en-US")}: ${a.text}`;
  }
  if (name === "start_job") {
    if (!(mem.projects || []).some((p) => p.slug === a.project)) throw new Error(`Unknown project "${a.project}". Use list_projects.`);
    startJob({ type: a.type, project: a.project });
    broadcast({ type: "toast", text: `🤖 Grok Bot started ${a.type} on ${a.project}` });
    return `${a.type} job started on ${a.project}. It commits to the repo and notifies the user when done (1-2 min).`;
  }
  if (name === "update_project") {
    const p = (mem.projects || []).find((x) => x.slug === a.project); if (!p) throw new Error(`Unknown project "${a.project}". Use list_projects.`);
    const u = await updateProject(p, a.instruction);
    broadcast({ type: "toast", text: `🤖 Grok Bot sent a change to ${p.title}` });
    return `Sent to ${p.title} via ${u.via}${u.url ? `: ${u.url}` : ""}`;
  }
  if (name === "list_projects") return (mem.projects || []).map((p) => `- ${p.slug}: ${p.title}: ${p.tagline}\n  repo: ${p.repo}${p.pr ? `\n  PR: ${p.pr}` : ""}`).join("\n") || "No shipped projects yet.";
  if (name === "list_tasks") return [`Open tasks:`, ...((mem.tasks || []).filter((t) => !t.done).map((t) => `- ${t.title}${t.due ? ` (due ${t.due})` : ""}`)), `Reminders:`, ...((mem.reminders || []).filter((r) => !r.done).map((r) => `- ${r.text} @ ${r.at}`))].join("\n");
  if (name === "list_notes") return (mem.notes || []).slice(0, 10).map((n) => `- ${n.title}: ${(n.body || "").slice(0, 200).replace(/\n/g, " ")}`).join("\n") || "No notes yet.";
  if (name === "remember") { const added = addFacts([{ text: a.fact, scope: a.scope || "global" }]); broadcast({ type: "toast", text: `🧠 Grok Bot taught me: ${a.fact}` }); broadcast({ type: "refresh" }); return added.length ? `Remembered: ${a.fact}` : "Already known."; }
  throw new Error(`Unknown tool ${name}`);
}

const server = http.createServer(async (req, res) => {
  try {
    // Public exposure (tunnel) is limited to the MCP endpoint + uploaded images. Everything else is local-only.
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || "") && !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
    const isMcp = req.url === "/mcp" || req.url.startsWith("/mcp?");
    if (!isLocal && !isMcp && !req.url.startsWith("/uploads/")) return send(res, 403, { error: "forbidden" });

    if (isMcp) {
      const tok = process.env.MCP_TOKEN;
      const given = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || new URL(req.url, "http://x").searchParams.get("key");
      if (!tok || given !== tok) return send(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } });
      if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
      const out = await handleMcp(await readJson(req), { callTool });
      if (!out) { res.writeHead(202); return res.end(); }
      return send(res, 200, out);
    }

    if (req.method === "GET" && req.url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n"); studios.add(res); req.on("close", () => studios.delete(res));
      return;
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public/index.html")), "text/html; charset=utf-8");
    }
    // Uploaded photos (products, screenshots…) so prototypes can show the real image.
    if (req.method === "POST" && req.url === "/api/upload") {
      const { image } = await readJson(req);
      const m = String(image || "").match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/);
      if (!m) return send(res, 400, { error: "expected an image data URL" });
      const dir = path.join(__dirname, "uploads"); fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now().toString(36)}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], "base64"));
      return send(res, 200, { url: `http://${req.headers.host}/uploads/${name}` });
    }
    const up = req.method === "GET" && req.url.match(/^\/uploads\/([\w-]+\.(png|jpg|webp|gif))$/);
    if (up) {
      const f = path.join(__dirname, "uploads", up[1]);
      if (!fs.existsSync(f)) return send(res, 404, { error: "not found" });
      return send(res, 200, fs.readFileSync(f), { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[up[2]]);
    }
    // Backup sketch images for demos: /samples/<name>.jpg|png
    const sample = req.method === "GET" && req.url.match(/^\/samples\/([\w-]+\.(jpg|jpeg|png|webp))$/i);
    if (sample) {
      const p = path.join(__dirname, "samples", sample[1]);
      if (!fs.existsSync(p)) return send(res, 404, { error: "no such sample" });
      return send(res, 200, fs.readFileSync(p), sample[2].toLowerCase() === "png" ? "image/png" : sample[2].toLowerCase() === "webp" ? "image/webp" : "image/jpeg");
    }
    if (req.method === "GET" && req.url === "/api/samples") {
      const dir = path.join(__dirname, "samples");
      return send(res, 200, fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)) : []);
    }
    // Preflight: are all the services the demo depends on reachable right now?
    if (req.method === "GET" && req.url === "/api/preflight") {
      const t = (ms) => AbortSignal.timeout(ms);
      const grok = fetch(`${XAI}/language-models`, { headers: { authorization: `Bearer ${KEY}` }, signal: t(8000) })
        .then(async (r) => ({ ok: r.ok, detail: r.ok ? MODEL : `HTTP ${r.status}` })).catch((e) => ({ ok: false, detail: e.name === "TimeoutError" ? "timeout" : e.message }));
      const github = (async () => {
        const { execSync } = await import("node:child_process");
        const tok = process.env.GITHUB_TOKEN || execSync("gh auth token").toString().trim();
        const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok}`, "user-agent": "idea-to-product" }, signal: t(8000) });
        const j = await r.json(); return { ok: r.ok, detail: r.ok ? j.login : `HTTP ${r.status}` };
      })().catch((e) => ({ ok: false, detail: e.message.slice(0, 80) }));
      const cs = cursorStatus();
      const cursor = !cs.configured ? Promise.resolve({ ok: true, detail: "not configured, Grok builds", fallback: true })
        : fetch("https://api.cursor.com/v0/agents", { headers: { authorization: `Bearer ${process.env.CURSOR_API_KEY}` }, signal: t(8000) })
          .then((r) => ({ ok: r.ok, detail: r.ok ? (cs.skipping ? "no repo access, Grok fallback on" : "agents API ok") : `HTTP ${r.status}`, fallback: cs.skipping }))
          .catch((e) => ({ ok: false, detail: e.message }));
      const [g, h, c] = await Promise.all([grok, github, cursor]);
      return send(res, 200, { grok: g, github: h, cursor: c, ready: g.ok && h.ok });
    }
    if (req.method === "GET" && req.url === "/api/health") {
      return send(res, 200, { ok: true, model: MODEL, hasKey: Boolean(KEY), builder: process.env.CURSOR_API_KEY ? "Cursor" : "Grok" });
    }

    // Idea → Product: streams NDJSON progress events.
    if (req.method === "POST" && req.url === "/api/ship") {
      const body = await readJson(req);
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      const emit = (step, status, data = {}) => res.write(JSON.stringify({ step, status, ...data }) + "\n");
      try {
        const result = await ship(body, { grokJSON, memoryContext, loadMemory, emit });
        addHistory({ kind: "ship", title: result.spec.title, instruction: result.repo });
        // Move this idea's project-scoped facts to the real repo slug.
        const mem = loadMemory();
        const slug = result.repoName?.split("/")[1];
        if (slug && body.project) for (const f of mem.facts) if (f.scope === `project:${body.project}`) f.scope = `project:${slug}`;
        mem.projects = [{ slug, title: result.spec.title, tagline: result.spec.tagline, idea: body.idea || "", repo: result.repo, pr: result.pr || null, agentId: result.agentId || null, agentUrl: result.agentUrl || null, builder: result.agentId ? "Cursor" : "Grok", at: new Date().toISOString() }, ...(mem.projects || [])].slice(0, 50);
        saveMemory(mem);
        result.projects = mem.projects;
        emit("all", "done", result);
      } catch (e) {
        console.error(e);
        emit("error", "error", { message: String(e.message || e) });
      }
      return res.end();
    }
    // Quick capture: Grok decides if this is an idea, a note, a task, or an update to an existing project.
    if (req.method === "POST" && req.url === "/api/capture") {
      const { text = "", kind = null } = await readJson(req);
      const mem = loadMemory();
      const projects = (mem.projects || []).map((p) => `- ${p.slug}: ${p.title}: ${p.tagline}`).join("\n") || "(none)";
      const now = new Date();
      const out = await grokJSON([
        { role: "system", content: `You triage quick captures for a personal "Idea → Product" assistant.
Classify the user's capture${kind ? ` (the user explicitly chose: ${kind}; use it)` : ""} and return ONLY JSON:
{ "kind": "idea" | "note" | "task" | "project", "title": "short title, max 8 words", "body": "cleaned-up text, keep their meaning", "due": "ISO date or null (resolve 'tomorrow', 'friday' etc. against now)", "remind_at": "full ISO datetime with the user's local offset if they asked to be reminded / gotten back to / followed up with, else null. 'end of the week' = this Friday 17:00 local; a date with no time = 09:00 local", "remind_text": "what to remind them about, short, or null", "project": "slug of the existing project it refers to, or null", "tags": ["1-3 short tags"], "remember": [ { "text": "full-sentence durable fact the user explicitly stated about themselves", "scope": "global | files:<glob>" } ] }
- idea = something to build (an app, tool, product, feature that doesn't belong to an existing project).
- note = something to remember or jot down (a thought, link, insight, meeting note).
- task = an everyday to-do or errand with an action ("call", "buy", "send", "fix", deadlines).
- project = a change/feature/bug for one of their EXISTING projects listed below; set "project" to its slug.
"remember" is usually empty.
Now (user's local time): ${localISO(now)} (${now.toLocaleDateString("en-US", { weekday: "long" })}).
EXISTING PROJECTS:\n${projects}\n\nUSER MEMORY:\n${memoryContext()}` },
        { role: "user", content: text },
      ]);
      const kindOut = ["idea", "note", "task", "project"].includes(out.kind) ? out.kind : "idea";
      const item = { id: Date.now().toString(36), title: out.title || text.slice(0, 60), body: out.body || text, tags: out.tags || [], at: now.toISOString() };
      const m2 = loadMemory();
      if (kindOut === "note") m2.notes = [item, ...(m2.notes || [])].slice(0, 200);
      if (kindOut === "task") m2.tasks = [{ ...item, due: out.due || null, done: false }, ...(m2.tasks || [])].slice(0, 200);
      if (kindOut === "note" || kindOut === "task") saveMemory(m2);
      const learned = addFacts(out.remember);
      const project = kindOut === "project" ? (m2.projects || []).find((p) => p.slug === out.project) || null : null;
      let reminder = null;
      if (out.remind_at && !isNaN(Date.parse(out.remind_at))) reminder = addReminder({ text: out.remind_text || item.title, at: new Date(out.remind_at).toISOString(), ref: project?.slug || null });
      return send(res, 200, { kind: project || kindOut !== "project" ? kindOut : "idea", item, due: out.due || null, project, learned, reminder });
    }

    // Live vision agent: Grok looks at the frame and DECIDES which tools to call.
    // mode "watch" = propose only (UI shows chips); mode "act" = execute now.
    if (req.method === "POST" && req.url === "/api/see") {
      const { image, detail = "low", mode = "watch", instruction = "" } = await readJson(req);
      if (!image) return send(res, 400, { error: "image required" });
      return send(res, 200, await seeAgent(image, detail, mode, String(instruction).slice(0, 500)));
    }
    // Chat sessions (studio history): upsert / delete.
    if (req.method === "POST" && req.url === "/api/sessions") {
      const b = await readJson(req);
      if (!b.id) return send(res, 400, { error: "id required" });
      const mem = loadMemory();
      const prev = (mem.sessions || []).find((x) => x.id === b.id) || {};
      const sess = { ...prev, ...b, html: String(b.html ?? prev.html ?? "").slice(0, 200000), updated: new Date().toISOString(), created: prev.created || new Date().toISOString() };
      mem.sessions = [sess, ...(mem.sessions || []).filter((x) => x.id !== b.id)].slice(0, 60);
      saveMemory(mem);
      return send(res, 200, { ok: true, id: sess.id });
    }
    if (req.method === "POST" && req.url === "/api/sessions/delete") {
      const { id } = await readJson(req);
      const mem = loadMemory(); mem.sessions = (mem.sessions || []).filter((x) => x.id !== id); saveMemory(mem);
      return send(res, 200, { ok: true });
    }

    // Execute one agent-proposed action (user tapped a chip).
    if (req.method === "POST" && req.url === "/api/act") {
      const { tool, args } = await readJson(req);
      try { return send(res, 200, await executeTool(tool, args || {})); } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }

    // Reminders: { text, at?: ISO (default end of this week), ref?: project slug }
    if (req.method === "POST" && req.url === "/api/reminders") {
      const { text, at, ref } = await readJson(req);
      if (!text) return send(res, 400, { error: "text required" });
      return send(res, 200, addReminder({ text, at: at && !isNaN(Date.parse(at)) ? new Date(at).toISOString() : endOfWeek().toISOString(), ref }));
    }
    const firedSince = req.method === "GET" && req.url.match(/^\/api\/reminders\/fired\?since=(\d+)$/);
    if (firedSince) return send(res, 200, (loadMemory().fired || []).filter((f) => Date.parse(f.firedAt) > +firedSince[1]));
    if (req.method === "POST" && req.url === "/api/jobs") {
      try { return send(res, 200, startJob(await readJson(req))); } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }
    if (req.method === "POST" && req.url === "/api/digest") {
      try { return send(res, 200, await weeklyDigest(true)); } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
    }

    // Send a change request to an existing project: Cursor agent on that repo, else a GitHub issue for later.
    if (req.method === "POST" && req.url === "/api/project/update") {
      const { slug, instruction } = await readJson(req);
      const p = (loadMemory().projects || []).find((x) => x.slug === slug);
      if (!p) return send(res, 404, { error: "unknown project" });
      try { return send(res, 200, await updateProject(p, instruction)); }
      catch (e) { return send(res, 502, { error: String(e.message || e) }); }
    }

    // Export to Cursor: clone the repo locally and open it in Cursor (or Finder if Cursor isn't installed).
    if (req.method === "POST" && req.url === "/api/export") {
      const { repo } = await readJson(req);
      const m = String(repo || "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/);
      if (!m) return send(res, 400, { error: "bad repo url" });
      const { execFile } = await import("node:child_process");
      const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, (e, so, se) => (e ? fail(new Error(se || e.message)) : ok(so))));
      const dir = path.join(process.env.HOME, "Code", "Ideas", m[1].split("/")[1]);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      // HTTPS + gh's stored login (works even when SSH keys aren't set up).
      const auth = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
      if (!fs.existsSync(dir)) await run("git", [...auth, "clone", `https://github.com/${m[1]}.git`, dir]);
      else await run("git", [...auth, "-C", dir, "pull", "--ff-only"]).catch(() => {});
      await run("git", [...auth, "-C", dir, "fetch", "--all"]).catch(() => {});
      let openedIn = "Cursor";
      try { await run("open", ["-a", "Cursor", dir]); } catch { openedIn = "Finder"; await run("open", [dir]).catch(() => {}); }
      return send(res, 200, { dir, openedIn });
    }
    const agent = req.method === "GET" && req.url.match(/^\/api\/agent\/([\w-]+)$/);
    if (agent) {
      try { return send(res, 200, await agentStatus(agent[1])); }
      catch (e) { return send(res, 502, { error: String(e.message || e) }); }
    }

    // Memory CRUD
    if (req.method === "GET" && req.url === "/api/memory") return send(res, 200, loadMemory());
    if (req.method === "POST" && req.url === "/api/memory") {
      const body = await readJson(req);
      const mem = loadMemory();
      if (typeof body.profile === "string") mem.profile = body.profile;
      if (Array.isArray(body.facts)) mem.facts = body.facts;
      if (Array.isArray(body.notes)) mem.notes = body.notes;
      if (Array.isArray(body.tasks)) mem.tasks = body.tasks;
      if (Array.isArray(body.reminders)) mem.reminders = body.reminders;
      if (body.clearHistory) mem.history = [];
      saveMemory(mem);
      return send(res, 200, mem);
    }

    // Intent: what does the user probably mean? -> intentions + suggestions + learned facts
    if (req.method === "POST" && req.url === "/api/intent") {
      const { text = "", app = "", afterBuild = false, project = "" } = await readJson(req);
      const context = `USER MEMORY\n${memoryContext()}\n\nCURRENT APP ON SCREEN:\n${app || "none yet"}`;
      const out = await grokJSON([
        { role: "system", content: afterBuild ? AFTER_BUILD_SYSTEM : INTENT_SYSTEM },
        { role: "user", content: `${context}\n\nTHE USER JUST SAID: "${text}"` },
      ]);
      out.learned = addFacts(out.remember, project);
      return send(res, 200, out);
    }

    if (req.method === "POST" && req.url === "/api/generate") {
      const { image, hint, assetUrl } = await readJson(req);
      const full = await streamGrok(res, [
        { role: "system", content: `${SYSTEM}\n\n---\n${memoryContext()}` },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: image, detail: "high" } },
            { type: "text", text: assetUrl
              ? `This is a PHOTO (e.g. a real product), not a sketch. Build exactly what the user asked for: ${hint || "a beautiful product page for it"}.\nThe photo is hosted at ${assetUrl}. Use it prominently and repeatedly with <img src="${assetUrl}"> (hero, cards, variations via CSS filters/backgrounds) since it's the real product. Pull colors and mood from it.`
              : `Build this app.${hint ? ` Extra direction: ${hint}` : ""}` },
          ],
        },
      ]);
      if (full) addHistory({ kind: "build", title: titleOf(full), instruction: hint || "" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/edit") {
      const { html, instruction } = await readJson(req);
      const full = await streamGrok(res, [
        { role: "system", content: `${EDIT_SYSTEM}\n\n---\n${memoryContext()}` },
        { role: "user", content: `Current app:\n\n${html}\n\nChange request: ${instruction}` },
      ]);
      if (full) addHistory({ kind: "edit", title: titleOf(full), instruction });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});


// ---------------- live vision agent (tool calling) ----------------
const SEE_TOOLS = [
  ["build_from_sketch", "Build a working prototype directly from the drawn UI/wireframe visible in the frame.", { label: { type: "string" } }, ["label"]],
  ["build_prototype", "Build a clickable prototype of an app/product idea described in words.", { label: { type: "string" }, instruction: { type: "string", description: "one-line description of the app to build" } }, ["label", "instruction"]],
  ["suggest_ideas", "Offer the user up to 3 product/app ideas inspired by what you see (objects, brands, scenes, notes).", { ideas: { type: "array", items: { type: "object", properties: { label: { type: "string", description: "max 6 words" }, instruction: { type: "string" } }, required: ["label", "instruction"] } } }, ["ideas"]],
  ["save_task", "Save an everyday to-do/errand.", { label: { type: "string" }, title: { type: "string" }, due: { type: ["string", "null"], description: "ISO date or null" } }, ["label", "title"]],
  ["save_note", "Save something worth remembering (a thought, info, quote, contact, meeting note).", { label: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, ["label", "title", "body"]],
  ["set_reminder", "Remind the user later (follow-ups, 'get back to me', deadlines).", { label: { type: "string" }, text: { type: "string" }, at: { type: "string", description: "ISO datetime with local offset; end of week = Friday 17:00" } }, ["label", "text", "at"]],
  ["update_project", "Send a change/feature request to one of the user's EXISTING projects (its coding agent).", { label: { type: "string" }, slug: { type: "string" }, instruction: { type: "string" } }, ["label", "slug", "instruction"]],
  ["start_job", "Run a background job on an existing project or idea: deep web research, docs, or pitch & launch plan.", { label: { type: "string" }, type: { type: "string", enum: ["research", "docs", "pitch"] }, project: { type: ["string", "null"] }, idea: { type: "string" } }, ["label", "type"]],
  ["ask_user", "Ask one short clarifying question when you genuinely can't tell what they want.", { question: { type: "string" } }, ["question"]],
  ["do_nothing", "Nothing actionable in view (blank, blurry, just a face/background).", {}, []],
].map(([name, description, properties, required]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: { seen: { type: "string", description: "2-8 word caption of what is in view" }, ...properties }, required: ["seen", ...required] } } }));
const SIDE_EFFECT = new Set(["save_task", "save_note", "set_reminder", "update_project", "start_job"]);

async function executeTool(tool, a) {
  const mem = loadMemory();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at = new Date().toISOString();
  if (tool === "save_task") { mem.tasks = [{ id, title: a.title, body: a.title, due: a.due || null, done: false, tags: ["camera"], at }, ...(mem.tasks || [])]; saveMemory(mem); return { ok: true, message: `✅ Task added: ${a.title}${a.due ? ` · due ${a.due}` : ""}` }; }
  if (tool === "save_note") { mem.notes = [{ id, title: a.title, body: a.body || a.title, tags: ["camera"], at }, ...(mem.notes || [])]; saveMemory(mem); return { ok: true, message: `📝 Note saved: ${a.title}` }; }
  if (tool === "set_reminder") { const r = addReminder({ text: a.text, at: !isNaN(Date.parse(a.at)) ? new Date(a.at).toISOString() : endOfWeek().toISOString() }); return { ok: true, message: `🔔 Reminder set: ${a.text}`, at: r.at }; }
  if (tool === "update_project") { const p = (mem.projects || []).find((x) => x.slug === a.slug); if (!p) throw new Error("unknown project " + a.slug); const u = await updateProject(p, a.instruction); return { ok: true, message: u.via === "Cursor" ? `🤖 Cursor agent started on ${p.title}` : `📌 Issue #${u.number} filed on ${p.title}`, url: u.url }; }
  if (tool === "start_job") { const j = startJob({ type: a.type, project: a.project || null, idea: a.idea || "" }); return { ok: true, message: `${a.type === "research" ? "🔬" : a.type === "docs" ? "📄" : "🎯"} ${a.type} job running. I'll notify you.`, id: j.id }; }
  throw new Error("not a server tool: " + tool);
}

async function seeAgent(image, detail, mode, instruction = "") {
  const mem = loadMemory(), now = new Date();
  const projects = (mem.projects || []).map((p) => `- ${p.slug}: ${p.title}: ${p.tagline}`).join("\n") || "(none)";
  const r = await fetch(`${XAI}/chat/completions`, {
    method: "POST", signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0.3, tools: SEE_TOOLS, tool_choice: "required",
      messages: [
        { role: "system", content: `You are the live eyes and hands of the user's personal "Idea → Product" agent. You see one camera frame.
Decide what would genuinely help the user right now and CALL THE TOOLS to do it. You may call several tools (e.g. save a task AND set a reminder, or suggest ideas AND start research). Use your judgment; there are no fixed rules.
Call 1-4 tools (for objects/products/scenes that is usually suggest_ideas; use do_nothing only if truly nothing is useful). Every call includes "seen" (a short caption) and a "label" (button text, max 6 words). Never invent facts about the user; use only USER MEMORY.
${instruction ? "The user TYPED an instruction about this frame. Follow it exactly. If they ask to make/create/design/build anything (a website, landing page, ad campaign, app, tool, game, page), call build_prototype with an instruction that applies their request to what you see (name the product). " : ""}update_project is ONLY for slugs in EXISTING PROJECTS (never chat/history titles); if that list is (none), never call it. ${mode === "watch" ? "The user is just pointing the camera around: your calls will be shown as suggestions for them to tap, so propose the most useful 1-4 actions." : "The user pressed the act button: your calls will be executed immediately, so choose decisively."}
Now (local): ${localISO(now)} (${now.toLocaleDateString("en-US", { weekday: "long" })}).
EXISTING PROJECTS:\n${projects}\n\nUSER MEMORY:\n${memoryContext()}` },
        { role: "user", content: [{ type: "image_url", image_url: { url: image, detail: detail === "high" ? "high" : "low" } }, { type: "text", text: instruction ? `Here's what my camera sees. Do exactly this with it: ${instruction}` : "Here's what my camera sees." }] },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`xAI ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const m = j.choices?.[0]?.message || {};
  const actions = (m.tool_calls || []).map((c) => { let args = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch {} return { tool: c.function.name, args }; });
  const slugs = new Set((mem.projects || []).map((p) => p.slug));
  for (let i = actions.length - 1; i >= 0; i--) if (actions[i].tool === "update_project" && !slugs.has(actions[i].args?.slug)) actions.splice(i, 1); // drop hallucinated projects
  const summary = (actions.find((x) => x.args?.seen)?.args?.seen || (m.content || "").trim().split("\n")[0]).slice(0, 80);
  if (mode === "act") {
    for (const a of actions) if (SIDE_EFFECT.has(a.tool)) { try { a.result = await executeTool(a.tool, a.args); } catch (e) { a.result = { ok: false, message: String(e.message || e) }; } }
  }
  return { summary, actions, mode };
}

// ---------------- background jobs: research, docs, pitch ----------------
async function grokResearch(prompt) {
  const r = await fetch(`${XAI}/responses`, {
    method: "POST", signal: AbortSignal.timeout(180000),
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: prompt }], tools: [{ type: "web_search" }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`xAI ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const msg = (j.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []);
  return msg.map((c) => c.text || "").join("\n").trim();
}
const JOBS = {
  research: { label: "Deep research", emoji: "🔬", file: "RESEARCH.md" },
  docs: { label: "Documentation", emoji: "📄", file: "docs/" },
  pitch: { label: "Pitch & launch plan", emoji: "🎯", file: "docs/PITCH.md" },
};
async function runJob(job) {
  const mem = loadMemory();
  const p = job.project ? (mem.projects || []).find((x) => x.slug === job.project) : null;
  let specText = job.idea || "";
  if (p) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${p.repo.replace("https://github.com/", "")}/main/SPEC.md`, { headers: { authorization: `token ${process.env.GITHUB_TOKEN || (await import("node:child_process")).execSync("gh auth token").toString().trim()}` } });
      if (r.ok) specText = await r.text();
    } catch {}
    specText ||= `${p.title}: ${p.tagline}\n${p.idea}`;
  }
  const subject = p ? `${p.title}` : (job.idea || "the idea").slice(0, 60);
  let files = [];
  if (job.type === "research") {
    const md = await grokResearch(`You are a sharp product researcher. Do deep research on the web for this product idea and write a decision-ready report in Markdown.

PRODUCT:
${specText}

ABOUT THE FOUNDER (tailor recommendations to them):
${memoryContext()}

Sections: # Research: <name>, ## TL;DR (3 bullets), ## Market & demand signals, ## Competitors (table: name, what they do, pricing, gap we can exploit; real products with links), ## Target users & jobs-to-be-done, ## Risks & unknowns, ## Differentiation: how to win, ## Recommended next 3 steps. Cite sources inline as links. Be concrete, ~700 words.`);
    files = [{ path: "RESEARCH.md", content: md }];
  } else if (job.type === "docs" || job.type === "pitch") {
    const out = await grokJSON([
      { role: "system", content: job.type === "docs"
        ? `You are a staff engineer + PM. Write project documentation from the spec. Return ONLY JSON { "files": [ { "path": "docs/PRD.md", "content": "..." }, { "path": "docs/ARCHITECTURE.md", "content": "..." }, { "path": "docs/USER_GUIDE.md", "content": "..." } ] }. PRD: goals, non-goals, user stories, requirements, success metrics. ARCHITECTURE: components, data model, key flows (include a mermaid diagram), tech choices and why. USER_GUIDE: getting started + how to use each feature. Concise, real, no filler. Respect the owner's preferences.`
        : `You are a startup advisor. Return ONLY JSON { "files": [ { "path": "docs/PITCH.md", "content": "..." } ] } with: one-liner, problem, solution, why now, target customer, business model, go-to-market launch plan (week-by-week for 4 weeks, channels), key metrics, 60-second demo script. Concise.` },
      { role: "user", content: `SPEC:\n${specText}\n\nOWNER MEMORY:\n${memoryContext()}` },
    ]);
    files = (out.files || []).filter((f) => f.path?.startsWith("docs/") && typeof f.content === "string" && !f.path.includes(".."));
  }
  if (!files.length) throw new Error("job produced no output");

  let url = null;
  if (p) {
    const full = p.repo.replace("https://github.com/", "");
    await commitFiles(full, "main", files, `${JOBS[job.type].label} (Idea → Product)`);
    url = files.length === 1 ? `${p.repo}/blob/main/${files[0].path}` : `${p.repo}/tree/main/docs`;
  }
  const m2 = loadMemory();
  m2.notes = [{ id: job.id, title: `${JOBS[job.type].emoji} ${JOBS[job.type].label}: ${subject}`, body: files.map((f) => `## ${f.path}\n\n${f.content}`).join("\n\n").slice(0, 20000), tags: [job.type], at: new Date().toISOString(), url }, ...(m2.notes || [])];
  const j = (m2.jobs || []).find((x) => x.id === job.id);
  if (j) Object.assign(j, { status: "done", url, files: files.map((f) => f.path), finished: new Date().toISOString() });
  fire(m2, "job", `${JOBS[job.type].emoji} ${JOBS[job.type].label} ready`, `${subject}${url ? " · committed to the repo" : " · saved to Notes"}`, { url });
  saveMemory(m2);
}
function startJob({ type, project = null, idea = "" }) {
  if (!JOBS[type]) throw new Error("unknown job");
  const mem = loadMemory();
  const job = { id: "job-" + Date.now().toString(36), type, project, idea, status: "running", started: new Date().toISOString() };
  mem.jobs = [job, ...(mem.jobs || [])].slice(0, 50);
  saveMemory(mem);
  runJob(job).catch((e) => {
    console.error("job failed", e);
    const m = loadMemory(); const j = (m.jobs || []).find((x) => x.id === job.id);
    if (j) Object.assign(j, { status: "error", error: String(e.message || e) });
    fire(m, "job", `${JOBS[type].emoji} ${JOBS[type].label} failed`, String(e.message || e).slice(0, 120));
    saveMemory(m);
  });
  return job;
}

// ---------------- reminders + weekly check-in ----------------
function localISO(d) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(off / 60)}:${pad(off % 60)}`;
}
function endOfWeek(from = new Date()) {
  const d = new Date(from); d.setHours(17, 0, 0, 0);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7)); // this Friday 5pm
  if (d <= from) d.setDate(d.getDate() + 7);
  return d;
}
function addReminder({ text, at, ref = null }) {
  const mem = loadMemory();
  const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, at, ref, done: false, created: new Date().toISOString() };
  mem.reminders = [...(mem.reminders || []), r].sort((a, b) => a.at.localeCompare(b.at));
  saveMemory(mem);
  return r;
}
async function notifyMac(title, body) {
  const { execFile } = await import("node:child_process");
  const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 240);
  execFile("osascript", ["-e", `display notification "${q(body)}" with title "${q(title)}" sound name "Glass"`], () => {});
}
function fire(mem, kind, title, body, extra = {}) {
  const f = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind, title, body, firedAt: new Date().toISOString(), ...extra };
  mem.fired = [...(mem.fired || []), f].slice(-50);
  notifyMac(title, body);
  return f;
}
async function projectStatusLines(projects) {
  const lines = [];
  for (const p of projects.slice(0, 8)) {
    let st = p.pr ? `PR ready: ${p.pr}` : "";
    if (p.agentId) { try { const a = await agentStatus(p.agentId); st = a.prUrl ? `Cursor finished, PR: ${a.prUrl}` : `Cursor agent ${String(a.status || "").toLowerCase()}`; } catch {} }
    lines.push(`- ${p.title} (${p.repo}): ${st || "repo ready"}`);
  }
  return lines.join("\n");
}
// Friday-5pm "here's where everything stands" check-in (also on demand).
async function weeklyDigest(force = false) {
  const now = new Date();
  const week = `${now.getFullYear()}-W${Math.ceil(((now - new Date(now.getFullYear(), 0, 1)) / 864e5 + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7)}`;
  let mem = loadMemory();
  if (!force && (mem.lastDigestWeek === week || now.getDay() !== 5 || now.getHours() < 17)) return null;
  const weekAgo = Date.now() - 7 * 864e5;
  const openTasks = (mem.tasks || []).filter((t) => !t.done);
  const notes = (mem.notes || []).filter((n) => Date.parse(n.at) > weekAgo);
  const context = `PROJECTS:\n${(await projectStatusLines(mem.projects || [])) || "(none)"}\n\nOPEN TASKS:\n${openTasks.map((t) => `- ${t.title}${t.due ? ` (due ${t.due})` : ""}`).join("\n") || "(none)"}\n\nNOTES THIS WEEK:\n${notes.map((n) => `- ${n.title}: ${n.body}`).join("\n") || "(none)"}`;
  const out = await grokJSON([
    { role: "system", content: `You are the user's product chief of staff. Write their end-of-week check-in. Return ONLY JSON: { "headline": "max 10 words", "summary": "3-6 short lines: what shipped, what agents finished, what needs their decision, top 3 tasks for next week. Plain text, no markdown headers." }\n\nUSER MEMORY:\n${memoryContext()}` },
    { role: "user", content: context },
  ]);
  mem = loadMemory();
  const note = { id: "digest-" + week, title: `Weekly check-in: ${out.headline || week}`, body: out.summary || context, tags: ["check-in"], at: now.toISOString() };
  mem.notes = [note, ...(mem.notes || []).filter((n) => n.id !== note.id)];
  mem.lastDigestWeek = week;
  const f = fire(mem, "digest", note.title, out.summary || "Your weekly check-in is ready.");
  saveMemory(mem);
  return { note, fired: f };
}
async function tick() {
  const mem = loadMemory();
  let changed = false;
  for (const r of mem.reminders || []) {
    if (!r.done && Date.parse(r.at) <= Date.now()) {
      let body = r.text;
      const p = r.ref && (mem.projects || []).find((x) => x.slug === r.ref);
      if (p) body += `\n${(await projectStatusLines([p])).replace(/^- /, "")}`;
      fire(mem, "reminder", "⏰ Getting back to you", body, { reminderId: r.id, ref: r.ref });
      r.done = true; changed = true;
    }
  }
  if (changed) saveMemory(mem);
  await weeklyDigest().catch((e) => console.error("digest", e.message));
}
setInterval(() => tick().catch((e) => console.error("tick", e.message)), 30000);

// Never let one bad request take the demo down.
process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e));
server.requestTimeout = 0; server.headersTimeout = 0; // long streams are fine

server.listen(PORT, () => {
  console.log(`Napkin → App on http://localhost:${PORT}  (model: ${MODEL}, key: ${KEY ? "yes" : "MISSING"})`);
});

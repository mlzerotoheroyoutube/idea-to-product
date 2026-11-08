// Idea → Product pipeline: spec (Grok) → GitHub repo → Cursor background agent (or Grok-built PR fallback).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const GH = "https://api.github.com";
const CURSOR = "https://api.cursor.com/v0";
// After Cursor fails once (e.g. no GitHub access), skip it for 30 min so demos have no dead air.
let cursorDownUntil = 0;
export const cursorStatus = () => ({ configured: Boolean(process.env.CURSOR_API_KEY), skipping: Date.now() < cursorDownUntil });

// ---------- GitHub ----------
let ghToken = null;
async function token() {
  if (ghToken) return ghToken;
  ghToken = process.env.GITHUB_TOKEN || (await run("gh", ["auth", "token"])).stdout.trim();
  return ghToken;
}
async function gh(method, url, body) {
  const r = await fetch(url.startsWith("http") ? url : GH + url, {
    method,
    headers: { authorization: `Bearer ${await token()}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "idea-to-product" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`GitHub ${r.status}: ${j.message || ""} ${JSON.stringify(j.errors || "")}`); e.status = r.status; throw e; }
  return j;
}
async function createRepo(slug, description, isPrivate) {
  for (let i = 0; i < 4; i++) {
    const name = i ? `${slug}-${Math.random().toString(36).slice(2, 6)}` : slug;
    try { return await gh("POST", "/user/repos", { name, description: description.slice(0, 340), private: isPrivate, auto_init: true }); }
    catch (e) { if (e.status !== 422) throw e; }
  }
  throw new Error("Could not find a free repo name");
}
// Commit many files in one commit via the git data API.
export async function commitFiles(full, branch, files, message, { createFrom } = {}) {
  let baseSha;
  for (let i = 0; i < 10; i++) { // fresh auto_init repos can take a moment
    try { baseSha = (await gh("GET", `/repos/${full}/git/ref/heads/${createFrom || branch}`)).object.sha; break; }
    catch (e) { if (i === 9) throw e; await new Promise((r) => setTimeout(r, 800)); }
  }
  const baseTree = (await gh("GET", `/repos/${full}/git/commits/${baseSha}`)).tree.sha;
  const tree = await gh("POST", `/repos/${full}/git/trees`, {
    base_tree: baseTree,
    tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
  });
  const commit = await gh("POST", `/repos/${full}/git/commits`, { message, tree: tree.sha, parents: [baseSha] });
  if (createFrom) await gh("POST", `/repos/${full}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  else await gh("PATCH", `/repos/${full}/git/refs/heads/${branch}`, { sha: commit.sha });
  return commit;
}

// ---------- Cursor ----------
async function cursor(method, path, body) {
  const key = process.env.CURSOR_API_KEY;
  const attempt = (auth) => fetch(CURSOR + path, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let r = await attempt(`Bearer ${key}`);
  if (r.status === 401) r = await attempt(`Basic ${Buffer.from(`${key}:`).toString("base64")}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Cursor ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
export async function agentStatus(id) {
  const a = await cursor("GET", `/agents/${encodeURIComponent(id)}`);
  return { status: a.status, prUrl: a.target?.prUrl, url: a.target?.url, branch: a.target?.branchName, summary: a.summary };
}

// ---------- prompts ----------
const SPEC_SYSTEM = `You are a sharp product lead. Turn the user's idea (text, voice transcript and/or a sketch image, plus a clickable prototype that was already built) into a crisp product spec that an AI coding agent can build from.
Use what you know about the user to make it fit them, but never invent personal facts.
Return ONLY JSON:
{
 "slug": "short-kebab-case-repo-name (2-4 words, no dates)",
 "title": "Product name",
 "tagline": "one line, max 12 words",
 "problem": "2 sentences",
 "users": "who it's for, 1 sentence",
 "features": ["v1 feature, concrete", "... 4-6 items"],
 "stack": "recommended stack for v1, 1 line (prefer simple: static web app or Next.js)",
 "milestones": ["M1 ...", "M2 ...", "M3 ..."],
 "acceptance": ["testable acceptance criterion", "... 3-5 items"]
}`;

const BUILD_SYSTEM = `You are a senior engineer. Build v1 of the product described in SPEC.md as a small, clean, runnable codebase.
Base the UI on the provided prototype, but split it into real files, add the v1 features from the spec, persist data in localStorage, and keep it dependency-free (plain HTML/CSS/JS, opens by double-clicking index.html).
Return ONLY JSON: { "files": [ { "path": "index.html", "content": "..." }, { "path": "src/app.js", "content": "..." }, { "path": "src/styles.css", "content": "..." } ], "pr_title": "...", "pr_body": "markdown summary of what was built, mapped to spec features" }
Max 5 files, keep total under ~400 lines. No README (it exists).`;

export function specMarkdown(s) {
  const list = (a) => (a || []).map((x) => `- ${x}`).join("\n");
  return `# ${s.title}\n\n> ${s.tagline}\n\n## Problem\n${s.problem}\n\n## Users\n${s.users}\n\n## v1 features\n${list(s.features)}\n\n## Stack\n${s.stack}\n\n## Milestones\n${list(s.milestones)}\n\n## Acceptance criteria\n${list(s.acceptance)}\n`;
}

// Memory layer → Cursor rules, so preferences travel into every project and Cursor obeys them at scale.
export function cursorRules(mem, spec, slug, project) {
  const facts = mem.facts || [];
  const bullets = (fs) => fs.map((f) => `- ${f.text}`).join("\n");
  const files = [];
  const global = facts.filter((f) => !f.scope || f.scope === "global");
  files.push({
    path: ".cursor/rules/owner-preferences.mdc",
    content: `---\ndescription: Who the owner is and how they like to build. Carried over from their Idea → Product memory, applies to all their projects.\nalwaysApply: true\n---\n# Owner preferences\n${mem.profile?.trim() ? `\n${mem.profile.trim()}\n` : ""}\n${bullets(global) || "- (none yet)"}\n`,
  });
  const proj = facts.filter((f) => f.scope === `project:${slug}` || (project && f.scope === `project:${project}`));
  files.push({
    path: ".cursor/rules/project-context.mdc",
    content: `---\ndescription: Product context for ${spec.title}\nalwaysApply: true\n---\n# ${spec.title}: ${spec.tagline}\n\nSource of truth for scope: SPEC.md. The UI direction is in prototype/index.html.\n\n## Problem\n${spec.problem}\n\n## Users\n${spec.users}\n${proj.length ? `\n## Project-specific notes from the owner\n${bullets(proj)}\n` : ""}`,
  });
  const byGlob = {};
  for (const f of facts) if (f.scope?.startsWith("files:")) (byGlob[f.scope.slice(6)] ||= []).push(f);
  for (const [glob, fs] of Object.entries(byGlob)) {
    const name = glob.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "files";
    files.push({ path: `.cursor/rules/files-${name}.mdc`, content: `---\ndescription: Owner preferences for ${glob}\nglobs: ${glob}\nalwaysApply: false\n---\n${bullets(fs)}\n` });
  }
  return files;
}

// ---------- pipeline ----------
// emit(step, status, data) streams progress to the browser.
export async function ship({ idea, image, html, appSummary, isPrivate = true, project = "" }, { grokJSON, memoryContext, loadMemory, emit }) {
  // 1. Spec
  emit("spec", "running");
  const content = [{ type: "text", text: `USER MEMORY\n${memoryContext()}\n\nIDEA (as the user described it): ${idea || "(see sketch)"}\n\nPROTOTYPE ON SCREEN:\n${appSummary || "n/a"}` }];
  if (image) content.unshift({ type: "image_url", image_url: { url: image, detail: "high" } });
  const spec = await grokJSON([{ role: "system", content: SPEC_SYSTEM }, { role: "user", content }]);
  spec.slug = String(spec.slug || spec.title || "idea").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "idea";
  const SPEC = specMarkdown(spec);
  emit("spec", "done", { title: spec.title, tagline: spec.tagline, features: spec.features });

  // 2. Repo + spec + prototype
  emit("repo", "running");
  const repo = await createRepo(spec.slug, `${spec.title}: ${spec.tagline}`, isPrivate);
  const readme = `# ${spec.title}\n\n${spec.tagline}\n\nBorn from an idea in ~1 minute with **Idea → Product** (Grok + ${process.env.CURSOR_API_KEY ? "Cursor" : "Grok"}).\n\n- 📄 [SPEC.md](SPEC.md): the product spec\n- 🧪 [prototype/index.html](prototype/index.html): the clickable prototype\n${idea ? `\n## The original idea\n> ${idea.replace(/\n/g, "\n> ")}\n` : ""}`;
  const rules = cursorRules(loadMemory(), spec, repo.name, project);
  await commitFiles(repo.full_name, repo.default_branch || "main", [
    { path: "README.md", content: readme },
    { path: "SPEC.md", content: SPEC },
    { path: "prototype/index.html", content: html || "<!doctype html><title>prototype</title>" },
    ...rules,
  ], "Idea → spec + prototype + owner preferences (.cursor/rules)");
  emit("repo", "done", { url: repo.html_url, name: repo.full_name, private: repo.private, rules: rules.map((r) => r.path), cursorUrl: `cursor://vscode.git/clone?url=${encodeURIComponent(repo.clone_url)}` });

  // 3. Builder: Cursor background agent if configured, else Grok writes v1 and opens the PR.
  if (process.env.CURSOR_API_KEY && Date.now() >= cursorDownUntil) {
    emit("build", "running", { by: "Cursor" });
    try {
      let agent, lastErr;
      for (let i = 0; i < 3 && !agent; i++) { // new repos can take a few seconds to be visible
        try {
          agent = await cursor("POST", "/agents", {
            prompt: { text: `Build v1 of this product. Read SPEC.md (the spec), prototype/index.html (a clickable prototype of the UI) and .cursor/rules (the owner's preferences: follow them).\nImplement every v1 feature and acceptance criterion in SPEC.md using the recommended stack, with a clean structure, a working dev/run command in the README, and basic tests where sensible. Open a pull request when done.\n\n${SPEC}` },
            source: { repository: repo.html_url, ref: repo.default_branch || "main" },
            target: { autoCreatePr: true },
          });
        } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 3000)); }
      }
      if (!agent) throw lastErr;
      emit("build", "agent", { by: "Cursor", id: agent.id, url: agent.target?.url, branch: agent.target?.branchName, status: agent.status });
      return { spec, repo: repo.html_url, repoName: repo.full_name, agentId: agent.id, agentUrl: agent.target?.url };
    } catch (e) {
      console.error("Cursor launch failed, falling back to Grok:", e.message);
      cursorDownUntil = Date.now() + 30 * 60 * 1000;
      emit("build", "fallback", { by: "Grok", reason: String(e.message || e).slice(0, 200) });
    }
  }

  emit("build", "running", { by: "Grok" });
  const out = await grokJSON([
    { role: "system", content: BUILD_SYSTEM },
    { role: "user", content: `SPEC.md:\n${SPEC}\n\nPROTOTYPE (prototype/index.html):\n${(html || "").slice(0, 14000)}` },
  ]);
  const files = (out.files || []).filter((f) => f.path && typeof f.content === "string" && !f.path.startsWith("/") && !f.path.includes("..")).slice(0, 6);
  if (!files.length) throw new Error("Grok returned no files");
  const branch = "grok/v1";
  await commitFiles(repo.full_name, branch, files, out.pr_title || "Build v1", { createFrom: repo.default_branch || "main" });
  emit("build", "done", { by: "Grok", files: files.map((f) => f.path) });

  emit("pr", "running");
  const pr = await gh("POST", `/repos/${repo.full_name}/pulls`, {
    title: out.pr_title || `Build v1 of ${spec.title}`,
    head: branch, base: repo.default_branch || "main",
    body: `${out.pr_body || ""}\n\n---\nBuilt from [SPEC.md](../blob/${repo.default_branch || "main"}/SPEC.md) by Grok via Idea → Product.`,
  });
  emit("pr", "done", { url: pr.html_url, number: pr.number });
  return { spec, repo: repo.html_url, repoName: repo.full_name, pr: pr.html_url };
}

// Follow-up work on an existing project: try a Cursor agent on the repo, else file a GitHub issue to pick up later.
export async function updateProject(p, instruction) {
  const full = p.repo.replace("https://github.com/", "");
  if (process.env.CURSOR_API_KEY && Date.now() >= cursorDownUntil) {
    try {
      const agent = await cursor("POST", "/agents", {
        prompt: { text: `${instruction}\n\nContext: read SPEC.md and .cursor/rules first. Keep changes focused and open a pull request.` },
        source: { repository: p.repo, ref: "main" },
        target: { autoCreatePr: true },
      });
      return { via: "Cursor", id: agent.id, url: agent.target?.url };
    } catch (e) { console.error("Cursor update failed, filing issue:", e.message); cursorDownUntil = Date.now() + 30 * 60 * 1000; }
  }
  const issue = await gh("POST", `/repos/${full}/issues`, { title: instruction.slice(0, 80), body: `${instruction}\n\n_Captured with Idea → Product. Pick this up in Cursor: read SPEC.md and .cursor/rules first._` });
  return { via: "GitHub issue", url: issue.html_url, number: issue.number };
}

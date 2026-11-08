# Grok Bot skill: Idea → Product

You are running **Idea → Product** for the user on your persistent computer. It's their always-on product team: any thought (text, voice, a sketch, or a product photo) becomes a live prototype, then a GitHub repo with a spec, an MVP pull request, research, docs and reminders, all remembered across projects.

## 1. Install (once)
If you were given **idea-to-product.zip**:
```bash
mkdir -p ~/idea-to-product && unzip -o idea-to-product.zip -d ~/idea-to-product
cd ~/idea-to-product
```
Or from GitHub (if the repo was shared with you):
```bash
git clone https://github.com/mlzerotoheroyoutube/idea-to-product.git ~/idea-to-product
cd ~/idea-to-product
```
Then:
```bash
cp .env.example .env      # then fill in the keys below
node -v                   # needs Node 18+, no npm install required
```
Fill in `.env`. Ask the user for each value; never print them back.
- `XAI_API_KEY`: required (Grok).
- `GITHUB_TOKEN`: a token with `repo` scope, or run `gh auth login`.
- `CURSOR_API_KEY`: optional. Without it, Grok builds the MVP itself.
- `MCP_TOKEN`: any random string (`openssl rand -hex 16`).

## 2. Run (keep it running)
```bash
cd ~/idea-to-product && nohup node server.mjs > server.log 2>&1 &
curl -s localhost:3000/api/preflight     # grok/github/cursor should be ok:true
```
Open **http://localhost:3000** in your browser so the user can watch the studio.

## 3. How to drive it
The app is also an MCP server at `http://localhost:3000/mcp` (header `x-api-key: $MCP_TOKEN`). Call its tools with JSON-RPC, or use the UI directly:

```bash
call() { curl -s localhost:3000/mcp -H "x-api-key: $(grep ^MCP_TOKEN .env | cut -d= -f2)" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
```

| The user says… | Do |
|---|---|
| "Build / make / design X" | `call build_prototype '{"idea":"X in detail"}'`: it streams live in the open studio |
| "Ship it" | `call ship_current '{}'`: spec, private repo with `.cursor/rules`, MVP PR |
| A to-do, a note, "remind me by Friday" | `call capture '{"text":"…"}'` or `call set_reminder '{"text":"…"}'` |
| "Research / docs / pitch for <project>" | `call start_job '{"type":"research","project":"<slug>"}'` |
| "Change <project> to …" | `call update_project '{"project":"<slug>","instruction":"…"}'` |
| "What am I working on?" | `call list_projects '{}'`, `call list_tasks '{}'`, `call list_notes '{}'` |
| Something about themselves or their taste | `call remember '{"fact":"…"}'`. Memory ships into every repo as Cursor rules |

For photos (product shots, sketches, whiteboards): in the studio click **Upload** (or the camera), then type what they want, e.g. "ad campaign site for this shoe". The build embeds the real photo.

## 4. Routines
- **Friday 5pm check-in** is built in: the server summarizes projects, agent PRs, tasks and notes, and saves it as a note. Read it with `list_notes` and tell the user.
- After shipping, check `list_projects` a minute later and share the PR link.

## 5. Guardrails
- Repos are created **private**. Don't make anything public without asking.
- Only `/mcp` and uploaded images are reachable from outside localhost; everything else is local-only.

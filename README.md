# Idea → Product

**Your always-on product team.** Have a thought at any moment and say it, type it, or hold up a sketch. Grok works out what you mean using your memory and builds a clickable prototype in seconds. Then it opens a GitHub repo with a spec, and an agent builds the MVP in the background. Check back whenever you're free, and open it in Cursor to take it further.

## Why it's different
- **It works from a thought, not a prompt.** Capture is one command bar. In **Auto** mode Grok decides whether you gave it an idea, a note, a task, or a change to an existing project.
- **It works behind the scenes.** Research, docs, pitch and MVP builds run as background jobs. You get a macOS notification when each one finishes, plus a **Friday 5pm check-in** on everything.
- **Memory travels with your work.** Preferences are scoped as *global*, *per project* or *per file pattern*, and they ship into every repo as `.cursor/rules/*.mdc`, so Cursor follows your taste at scale.
- **It's a real hand-off.** Every idea becomes a private repo containing `SPEC.md`, the prototype, your rules, `RESEARCH.md` and `docs/`, plus a PR. One click opens it in Cursor.

## Use it from Grok Bot
Grok Bot can run Idea → Product on its own computer and drive it through its tools. See **[GROKBOT.md](GROKBOT.md)** (the skill). In short:
- clone, fill in `.env`, `node server.mjs`, open `localhost:3000`;
- Grok Bot calls the MCP tools (`build_prototype`, `ship_current`, `capture`, `start_job`, `set_reminder`, `remember`, `list_*`) and the studio builds live.

## Run
```bash
cp .env.example .env    # XAI_API_KEY (required), CURSOR_API_KEY (optional)
node server.mjs         # Node 18+, no npm install
```
Open http://localhost:3000 in Chrome. GitHub uses your `gh` login. The camera stays off until you click **Live** or **Snap**.

**Builder:** with `CURSOR_API_KEY` set, a Cursor background agent builds the MVP and opens the PR. If Cursor can't access the repo, Grok builds v1 and opens the PR itself, so the demo never breaks.
> To let Cursor agents build in your repos: Cursor dashboard → Integrations → GitHub → install the Cursor app on your account with access to **All repositories**.

## Features
| | |
|---|---|
| ✦ Capture | Auto / Idea / Note / Task / Project · type, voice (`V`), sketch via camera (`Space`) or image upload |
| 🧠 Intent + memory | 2–3 ranked guesses at what you mean, 3 suggestions, auto-learned facts with scopes |
| 🧪 Prototype | Working single-file app streams in live |
| 🚀 Ship | Spec → private repo → `.cursor/rules` from memory → agent builds MVP → PR |
| 🔬 Deep research | Grok with web search: market, competitors (with links), users, risks → `RESEARCH.md` |
| 📄 Docs · 🎯 Pitch | `docs/PRD.md`, `ARCHITECTURE.md` (mermaid), `USER_GUIDE.md`, `PITCH.md` + 4-week launch plan |
| 🔔 Reminders | "Get back to me by end of week", per-project status in the notification, weekly Friday check-in |
| 📥 Inbox | Projects (repo, PR, agent status, jobs, export), Tasks (due dates), Notes, Reminders |
| ⌨️ Open in Cursor | Clones to `~/Code/Ideas/<name>` and opens Cursor (also a `cursor://` link and a .zip) |

Keys: `↵` capture · `V` speak · `Space` snap · `1/2/3` pick · `S` ship · `I` inbox · `N` studio · `M` memory · `Esc` close

## 90-second demo
1. **Hook:** "Every product starts as a thought you lose by dinner. This one doesn't lose it."
2. **Say an idea** (press `V`): "an app for my running club to log weekly miles with a leaderboard". Grok shows what it thinks you mean, informed by your memory. Press `1` and the prototype streams in.
3. **Ship it** (`S`): the inspector ticks through spec → private repo with your `.cursor/rules` → agent building → **PR**, in about a minute.
4. **Behind the scenes:** click **Deep research**. "I'll go do my day." Show the notification when `RESEARCH.md` lands, with real competitors and links.
5. **Everyday:** type "send the receipts to finance Thursday, and remind me about the judges by end of week". It becomes a task with a due date plus a Friday 5pm reminder.
6. **Scale it:** Inbox → **Export to Cursor** opens the repo in Cursor, which already knows your preferences.

## Before the demo
- Fill in 🧠 **Memory** with your real profile, so the "it knows me" moment lands.
- Do one dry run on venue wifi. Backup sketches are in `samples/` (drag one in).

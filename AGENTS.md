# Agent Instructions

<!-- myc:agents-start v=12 -->
## Project Management with Mycelium

This project uses [Mycelium](https://github.com/tcsenpai/mycelium) (`myc`) for task and epic management.

### Quick Reference

```bash
# Initialize mycelium in this project (creates .mycelium/ directory).
# Commands resolve the nearest .mycelium/ by walking UP from the cwd, so run
# them from anywhere in the project. Running `myc init` inside a subdir of an
# existing project warns and asks (default yes) before creating a SEPARATE
# nested project there; `myc init --force` creates it without asking.
myc init

# Create an epic (a large body of work)
myc epic create --title "Feature X" --description "Build feature X"

# Create tasks within an epic
myc task create --title "Implement Y" --description "Build the implementation for Y" --epic 1 --priority high --due 2025-12-31

# Task priorities: low, medium, high, critical
# Task status: open, in_progress, closed
# Mark a task as in progress (there is no `task start`; use update):
myc task update 1 --status in_progress

# List tasks. `myc list` (top-level) shows a TREE with dependencies and epic
# grouping: use it to see the overall state. `myc task list` is a flat list.
myc list
myc task list
myc task list --epic 1
myc task list --overdue
myc task list --blocked
myc task list --all          # include closed tasks
myc task list --tree         # parent > child hierarchy
myc task list --parent 5     # flat list of the direct children of task 5
myc task list --parent 0     # only top-level tasks (no parent)
myc task list --parent 5 --tag sp   # children of 5 filtered by tag (combinable)

# Find a task id from a title/description fragment (searches both, case-insensitive).
# Quiet mode is grep-friendly: "<id>\t<title>" per line. JSON gives full objects.
myc task search "custom_field"
myc -q task search "subquery"        # id + title, tab-separated
myc --format json task search "SP"   # full task objects

# Subtasks (parent/child hierarchy: distinct from epics and dependencies).
# Group a family of tasks under a "hat" task without inventing an epic.
myc task create -t "child task" --parent 1
myc task update 2 --parent 1   # re-parent existing task (use 0 to detach)

# Manage dependencies (task 1 blocks task 2)
myc task link blocks --task 1 2
myc deps show 2

# Non-blocking references between tasks (relates / duplicate). Symmetric,
# never block or close anything: just mark "these are related / the same".
myc task link relates 1 2
myc task link duplicate 1 2
myc task refs 1               # list a task's references
myc task ref-unlink 1 2 relates

# Close tasks (blocked tasks cannot be closed without --force).
# A parent with open subtasks prompts; --cascade closes the whole subtree.
myc task close 1
myc task close 1 --cascade

# Assign tasks
myc assignee create --name "Alice" --github "alice"
myc task assign 1 1

# Link to external resources
myc task link github-issue --task 1 "owner/repo#123"
myc task link github-pr --task 1 "owner/repo#456"
myc task link url --task 1 "https://example.com"

# Project overview
myc summary

# Export data
myc export json
myc export csv
```

### Data Model

- **Epic**: A large body of work with a title and optional description (e.g., a feature or milestone)
- **Task**: A unit of work with a title and optional description, optionally linked to an epic
- **Subtask**: A task with a `parent` task (hierarchy). Distinct from epics (one-level grouping) and dependencies (blocking). Closing a parent never auto-closes children.
- **Dependency**: Task A blocks Task B (B cannot close until A is closed)
- **Reference**: A non-blocking, symmetric link between two tasks, `relates` (same family) or `duplicate` (same thing). Marks only; never blocks or closes.
- **Assignee**: Person assigned to a task (can have GitHub username)
- **External Ref**: Link to GitHub issues/PRs or URLs

### ID Prefixes (v5)

Each entity has its **own** integer sequence, so a bare number is ambiguous
across categories. Mycelium now **displays** IDs with a one-letter category
prefix so they can't be confused:

| Category | Prefix | Example |
|---|---|---|
| Epic | `E` | `E3` |
| Task | `T` | `T3` |
| Follow-up | `F` | `F3` |
| Assignee | `A` | `A3` |
| External ref | `R` | `R3` |

**Input is backward compatible.** Every command still accepts a bare integer
(`myc task show 3`) *and* the prefixed form (`myc task show T3`,
case-insensitive). Passing the **wrong** category prefix is a hard error with a
hint, e.g. `myc task show E3` tells you `E3` is an epic and suggests
`myc epic show E3`. This catches copy/paste mix-ups.

`--format json` output is unchanged: the `id` field stays a raw integer, so
existing scripts and the Linear sync keep working.

### Git Tracking

The `.mycelium/` directory contains the SQLite database and should be committed to git:

```bash
git add .mycelium/
git commit -m "Add mycelium project tracking"
```

### Follow-up Stop hook (Claude Code)

`myc init` installs a project-local Claude Code Stop hook into `.claude/`
(script + `settings.json` wiring) that enforces the end-of-task follow-up
check automatically. Commit `.claude/` so the whole team gets it.

```bash
myc init --no-hooks          # skip the hook install
myc init --force             # create a nested project in a subdir without asking
myc hooks install            # (re)install into the project's .claude/
myc hooks install --global   # install into ~/.claude instead
myc hooks uninstall          # remove (add --global for ~/.claude)
myc hooks status             # show where it's installed
```

The hook self-dedups, so a global and a local copy can coexist without
firing the check twice.

### Updating

```bash
myc update   # cargo install --force, then resync AGENTS.md + hook to the new version
```

`myc update` updates the binary via cargo, then re-runs `prime-agents --force`
and `hooks install` so this project's AGENTS.md and hook match the new version.
If cargo isn't available it skips the binary step and just resyncs the
artifacts (update the binary by hand, then rerun).

### Follow-ups (`myc followup`, alias `myc fu`)

Lightweight scratch table for non-blocking "oh-by-the-way" items
captured mid-work, bugs, questions, ideas, things the user should look
at later. **Separate from tasks** (no epic/priority/deps/assignee). Most
follow-ups are resolved by the user, not the agent.

```bash
myc followup add "body text"                # capture (body required)
myc followup add "body text" --title "tag"  # optional short title
myc fu add "short form alias works too"

myc followup list                           # all (default)
myc followup list -o                        # only active (open + in_progress)
myc followup list -c                        # only closed (done + wontfix)
myc followup list --status done             # exact status

myc followup show <id>                      # full detail
myc followup next                           # lowest-ID active (agent loop)
myc followup count                          # JSON: {open, in_progress, done, wontfix}

myc followup start <id>                     # → in_progress
myc followup done <id> [--reason "..."]     # → done
myc followup wontfix <id> [--reason "..."]  # → wontfix
myc followup reopen <id>                    # → open

myc followup edit <id> --body "new body" [--title -|"new title"]
myc followup append <id> "more context"     # timestamped, preserves existing
myc followup rm <id> [--force]
myc followup promote <id> [--epic N] [--priority high]  # convert to task
myc followup snooze [--turns N]             # silence the Stop hook for N stops (default 5)
myc followup snooze --turns 0               # clear an active snooze
```

**Agent rule, end-of-task follow-up check** (MANDATORY)

At the end of every mycelium-tracked unit of work (closing a task,
finishing a user-requested change that touched myc state), the agent
MUST:

1. Run `myc followup list --format json` (or `myc followup count
   --format json`).
2. If `open > 0`, surface those to the user before wrapping:
   > "Before we wrap, N open follow-up(s): [titles/bodies]. Want me to
   > handle any now, or leave for later?"
   Count only `open`, not `active`: `in_progress` items are already
   being worked and don't need an end-of-task decision.
3. **Never silently process them.** Always ask.

`myc task close` itself also prints a one-line reminder (only for open
follow-ups older than ~60s; fresh or in_progress ones stay silent), but
the agent should still proactively check.

The Stop hook re-runs this check on **every** stop while `open > 0`. Once
you've surfaced the follow-ups to the user (step 2) and they've chosen to
leave them for later, run `myc followup snooze` to silence the hook for the
next few stops instead of being re-prompted each turn. Snooze is
project-scoped and consumes one stop at a time.

Use `myc followup add` during work to capture anything you notice but
shouldn't act on right now.

### For AI Agents

When working on this project:

1. At the START of a task, reconstruct state instead of relying on memory:
   `myc list` (tree with dependencies) and `myc followup list -o` (open items).
2. Check blocked tasks: `myc task list --blocked`
3. Create tasks for new work: `myc task create --title "..." --description "..." --epic N`
4. Mark a task in progress while you work on it: `myc task update N --status in_progress`
5. Capture incidental observations as follow-ups: `myc followup add "..."`
6. At end of task: `myc followup list` and surface open ones to the user
7. Mark tasks complete when done: `myc task close N`
8. Use `--format json` for machine-readable output: `myc task list --format json`

## Mental Frameworks for Mycelium Usage

### 1. INVEST: Task Quality Gate

Before creating or updating any task, validate it against these criteria.
A task that fails more than one is not ready to be written.

| Criterion | Rule |
|---|---|
| **Independent** | Can be completed without unblocking other tasks first |
| **Negotiable** | The *what* is fixed; the *how* remains open |
| **Valuable** | Produces a verifiable, concrete outcome |
| **Estimable** | If you cannot size it, it is too vague or too large |
| **Small** | If it spans more than one work cycle, split it |
| **Testable** | Has an explicit, binary done condition |

> If a task fails **Estimable** or **Testable**, convert it to an Epic and decompose.

---

### 2. DAG: Dependency Graph Thinking

Before scheduling or prioritizing, model the implicit dependency graph.

**Rules:**
- No task moves to `in_progress` if it has an unresolved upstream blocker
- Priority is a function of both urgency **and fan-out** (how many tasks does completing this one unlock?)
- Always work the **critical path** first, not the task that feels most urgent

**Prioritization heuristic:**
```
score = urgency + (blocked_tasks_count × 1.5)
```

When creating a task, explicitly ask: *"What does this block, and what blocks this?"*
Set dependency links in Mycelium before touching status.

---

### 3. Principle of Minimal Surprise (PMS)

Mycelium's state must remain predictable and auditable at all times.

**Rules:**
- **Prefer idempotent operations**, update before you create; never duplicate
- **Check before write**, search for an equivalent item before creating a new one
- **Always annotate mutations**, every status change, priority shift, or reassignment must carry an explicit `reason` field
- **No orphan tasks**, every task must be linked to an Epic; every Epic to a strategic goal
- Deletions are a last resort; prefer `cancelled` status with a reason

> The state of Mycelium after any operation must be explainable to another agent with zero context.
<!-- myc:agents-end -->

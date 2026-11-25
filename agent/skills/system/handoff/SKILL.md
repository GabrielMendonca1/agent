---
name: handoff
description: "End the task with a short handoff for the next session."
argument-hint: "Focus of the next session"
---

End the current task by writing a handoff of at most 40 lines to
`.agent/handoff.md` in the cwd (create `.agent/` if needed) with the `write` tool.
Overwrite the previous handoff; do not write to a temporary directory.
Write only the body, without frontmatter: the Agent stamps session, time, branch
and HEAD itself. The next session on this branch receives the handoff with its
first message.

Include only what is needed to continue:
- Goal and current state, taking the arguments as the focus of the next session.
- Decisions made and their reasons, briefly.
- Relevant commits on the branch: check `git log --oneline` and record hashes and titles.
- Open items, blockers, and checks that failed or were not run.
- Paths touched; reference existing plans, notes and diffs instead of copying them.
- One concrete next step.

Do not include secrets or invent commits, results or verification. Outside a git
repository, state that commits do not apply. Do not commit automatically.
End the handoff with a reminder: if you created or changed a note, update `.agent/notes.md`.
Briefly confirm the path written.

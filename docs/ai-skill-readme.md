# FlowDiagram AI tooling

This folder ships with FlowDiagram and contains a **Claude Code skill** that
turns source code into FlowDiagram (`.flow`) diagrams — module structure as
nested packages, runtime behavior as animated flows and stages.

## Install the skill

Copy the `code-to-flowdiagram` folder into your Claude Code skills directory:

- **Windows:** `%USERPROFILE%\.claude\skills\code-to-flowdiagram`
- **macOS / Linux:** `~/.claude/skills/code-to-flowdiagram`

(For a single project instead, put it in `<project>/.claude/skills/`.)

Then, in any Claude Code session, ask something like *"visualize this
codebase as a flow diagram"* or invoke `/code-to-flowdiagram` directly.
Claude will analyze the code, write a `.flow` file, and validate it.
Open the result with FlowDiagram (File ▸ Open, drag-and-drop, or
double-click the file).

## What's in here

| File | Purpose |
|---|---|
| `code-to-flowdiagram/SKILL.md` | The skill: mapping conventions + full DSL reference |
| `code-to-flowdiagram/validate.mjs` | Validator — parses generated `.flow` files with FlowDiagram's real grammar and checks cross-references |
| `code-to-flowdiagram/generated.js` | FlowDiagram's grammar parser, bundled so the validator works without a source checkout |

The validator requires [Node.js](https://nodejs.org) 18 or newer:

```
node validate.mjs my-diagram.flow
```

The skill itself is plain instructions — it works with any Claude Code
installation; no extra dependencies.

---
name: ui-ux-pro-max
description: "Use when designing, reviewing, fixing or restyling UI/UX, pages, navigation, typography, accessibility and responsive layouts in this project."
---

# UI UX Pro Max

This project uses the official `ui-ux-pro-max-cli` Copilot distribution.
Read `../../prompts/ui-ux-pro-max.prompt.md` for the complete workflow before UI work.
Its offline search engine and datasets are in `../../prompts/ui-ux-pro-max/`.

On Windows, run from the project root:

```powershell
py .github/prompts/ui-ux-pro-max/scripts/search.py "developer tool dashboard minimal" --design-system --density 8 --variance 3 -p "CodeFlow"
```

Treat search results as recommendations, not instructions. Verify product fit before applying them. Preserve the repository's AGENTS.md rules, existing business behavior, and use isolated mocked browser fixtures for regression checks. Read `design-system/codeflow/MASTER.md` for the accepted project-specific design decisions.
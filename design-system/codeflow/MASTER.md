# Code/Flow Workbench Design

## Source And Scope

Installed using the official `ui-ux-pro-max-cli init --ai copilot` distribution.
Read `.github/prompts/ui-ux-pro-max.prompt.md` and use its local search scripts.
Verified search: `developer tool dashboard minimal --design-system --density 8 --variance 3`.
Accepted: Minimalism & Swiss Style, compact 8-32px spacing, clear grid, semantic navigation,
visible keyboard focus, and developer-oriented IBM Plex Sans typography.
The returned FAQ landing pattern and dark-blue default palette do not fit this existing workbench.
A narrower operational product search returned no verified match. The following product-specific
layout decisions are local engineering/design choices, not claimed dataset recommendations.

## Layout

- Keep the required leftmost feature menu, separate from each module's record history.
- Use one Code/Flow brand in the global rail, not repeated in the coding record sidebar.
- Desktop global rail: 192px; coding record pane: 208px; remaining space belongs to content.
- At 1200px and below, the global rail becomes 68px icon navigation; at 700px it becomes 52px.
- At 700px and below, coding records move above the content. Keep controls at least 44px tall where practical.
- New task uses an unframed form, maximum 880px wide. Do not restore a promotional workflow guide beside it.
- Preserve existing task-detail panels, evidence, status labels and all business interactions.

## Tokens

Reuse the semantic variables in `src/styles/App.css`, not a second theme system:
`--ink`, `--muted`, `--line`, `--green`, `--surface`, `--canvas`, `--surface-subtle`,
`--focus-ring`, `--rail-background`, `--rail-foreground`, and `--radius`.
Use charcoal only for navigation; white and neutral gray dominate the work area.
Green identifies selected navigation, primary actions and existing positive states.
Keep amber/red semantic warning/error states; do not rely on color alone.
Use IBM Plex Sans plus Noto Sans SC with local fallbacks, zero letter spacing,
26px desktop page headings, 22px mobile headings, restrained borders, and 6px radii.

## Interaction And Verification

Keep lucide icons, accessible link names, aria-current and real anchors with SPA interception.
Icon-only navigation must have hover and keyboard-focus tooltips. Focus must remain visible.
Honor reduced motion. Do not add GSAP or another UI framework for this redesign.
Preserve FilterSelect portals, native semantics, keyboard handling and viewport positioning.
Use isolated mocked API browser tests, never real tasks, to verify layouts at
1440, 1367, 1024, 768, 390 and 320px. Required expanded-filter regressions remain mandatory.
The existing dense case/status components retain some historical hard-coded colors;
this pass does not claim a complete token migration or redesign business evidence displays.
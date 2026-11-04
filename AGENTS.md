# Project Agent Rules

## Frontend Styles And Regression Checks

- Preserve the existing Code/Flow visual language and use lucide icons. Keep changes scoped to the affected controls and layouts.
- Test dropdowns both closed and expanded. Native select popups use OS/browser styling; CSS on select does not style the open menu consistently. For styled filters, reuse FilterSelect rather than introducing another native popup or a one-off menu.
- Dropdown overlays must not be clipped by ancestor overflow or cover their own trigger. Constrain width and scrollable height to the viewport, choose upward placement when needed, and keep them within the mobile screen. Do not fix clipping by broadly removing panel overflow rules or increasing z-index alone.
- Preserve accessible names, combobox/listbox/option semantics, selected state, keyboard navigation, Escape dismissal, outside-click dismissal, and focus restoration. Verify real pointer and keyboard interactions, not just DOM presence.
- Give filter bars explicit responsive grid tracks and controls min-width: 0. Search fields must yield space to category/status selectors; long labels and result counts must wrap or move to another row rather than overlap or clip. Keep icon and action dimensions stable.
- Apply focus-visible outlines to the actual control, not generic label:focus-within containers. Avoid duplicated focus frames enclosing both a label and its input.
- Check long Chinese labels, the longest selected option, many cases, and multi-line requirement headings. Old unclassified cases must remain accurately labeled; do not change task data to improve presentation.
- Run the isolated browser regression in server/tests/ui/test-policy-browser.test.ts at 1440px, 1367px, 390px and 320px. Capture expanded-menu screenshots and assert menu bounds, filter-container bounds, row overlap, keyboard behavior and horizontal overflow. Closed-control screenshots alone are insufficient.
- Use mocked API responses and isolated Vite/Chrome fixtures. Never mutate real tasks or restart the production API just to validate a frontend style change.

## Validation Commands

- Focused UI regression: node --import tsx --test server/tests/ui/test-policy-browser.test.ts server/tests/ui/self-test-results.test.ts
- Frontend/server build: npm run build

## Why These Rules Exist

The case-management filter bar previously passed closed-state viewport checks but still displayed a browser-native blue dropdown and unstable field widths. Prevent recurrence by validating the expanded overlay and each control's container bounds, not only the document scroll width. These rules are recorded in the standard AGENTS.md file so coding agents can discover them automatically.
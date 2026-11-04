# Frontend SPA Routing

The frontend uses React Router with a single HTML entry point. Routes are configured in `src/app/AppRouter.tsx`. Feature ownership and import conventions are documented in [frontend-organization.md](frontend-organization.md):

| Path | Page |
| --- | --- |
| `/` | Coding workspace; existing task and automation query parameters are supported |
| `/planning` | Planning workspace; optional `planning` record ID |
| `/execution` | Execution workspace; optional `execution` record ID or `package` ID |
| Other paths | Not-found page |

Existing `/?view=planning` and `/?view=execution` links remain supported, including record/package query parameters. New primary navigation uses path-based routes.

The authenticated router shell owns a persistent leftmost `FeatureMenu`: coding, planning, execution and automation. Automation retains `/?automation=overview` and its existing detail URLs. The active item follows the route and legacy query parameters. Desktop shows icons and labels; narrower screens show icons with hover/focus tooltips. Workspace-specific history remains beside the main content rather than becoming part of the global menu.

`AuthProvider` remains mounted above route content. Internal navigation does not reload the document or repeat authentication checks. A full reload confirms the server session once. OAuth and logout retain the server's HttpOnly cookie mechanism; API restarts still invalidate in-memory sessions.

Coding and testing workspaces use dynamic imports with a loading fallback. The login screen does not load either workspace, and opening one workspace does not eagerly load the other. Shared styling remains at the entry point to avoid layout flashes. Planning and execution share one testing module because they share forms, case editing and execution logic.

## Deployment

Vite development and preview servers support SPA history fallback. A production static server must serve `dist/index.html` for non-file frontend routes, including direct refreshes of `/planning` and `/execution`. Keep `/api/` mapped to the backend and do not rewrite API errors into HTML.

Example Nginx frontend location (configure the API proxy separately):

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

Hashed assets can use long-lived immutable caching. Serve `index.html` without long-lived caching so a deployment does not leave clients pointing at removed chunks.

## Regression Checks

```text
node --import tsx --test server/tests/ui/auth-navigation.test.ts
npm run build
```

The isolated browser test covers lazy module requests, document-free internal navigation, shared authentication, history back, direct route refresh, legacy links, not-found navigation, logout and session expiry. Feature-menu checks cover four entries, active state, keyboard activation, mobile tooltips and rail/content bounds at 1440, 1367, 390 and 320px. It uses mocked API responses and does not change real tasks.
# CRM shell demo

A click-around preview of the CRM shell for people who have not run it yet. It is a static site: the pages, tabs,
workflows and the apps each industry uses come from every industry's `crm-shell/template.json` and the `workflow.json` files each
template names, and the records are made up in the browser. Nothing is fetched, saved or sent; a refresh puts it back.

```
node demo/build.mjs          # writes demo/dist (index.html, app.js, styles.css, data.js)
node demo/server.mjs         # serves demo/dist on PORT (default 8080)
```

- `server.mjs` has no dependencies. It answers GET and HEAD only, serves only the files it read from `dist/` at start,
  sets a strict Content-Security-Policy (no outside scripts, styles, fonts or connections) and answers `/healthz`.
- `DEMO_FRAME_ANCESTORS` lists the origins allowed to show the demo in a frame, separated by spaces or commas
  (`https://hub.example.com`). Unset, nobody can frame it. Only plain `https` origins are kept (no wildcards), plus `http://localhost`
  and `http://127.0.0.1` for a local check.
- Deploy: `demo/Dockerfile` (build from the repo root). On Railway, point the service at `demo/railway.json`
  (Settings, Config-as-code). The image holds no keys and needs no database.
- Links inside the demo are hash routes (`#/<industry>/d/<department>/<page>/<tab>`), so a host page can open any
  view directly, for example `#/real-estate/approvals`.

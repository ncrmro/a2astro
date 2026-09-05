# AGENTS.md

- Astro 7 SSR app (`output: 'server'`, node standalone adapter). Start the dev server in the background: `astro dev --background`; manage with `astro dev stop|status|logs`.
- `npm run mock` starts a mock resident agent on :8788 so every page has data; `a2astro.config.mock.yaml` selects them when no git-ignored `a2astro.config.yaml` exists.
- All agent access goes through `src/lib/a2a-client.ts`; bearer tokens never reach the browser (SSE is proxied by `/api/agents/:id/tasks/:taskId/events`).
- Workflow files follow the outfitter `workflow.schema.json`; keep `src/lib/workflows.ts` in step with `ai-outfitter/outfitter/code/cli/src/resolver/WorkflowDefinition.ts`.
- a2astro ships no workflows. They are read from the catalog the agents resolve (`ai-outfitter/community-profiles`, or an org catalog that pins it) through `src/lib/catalog-sources.ts`; `fixtures/catalog` exists only so the mock and the tests run offline.
- Metadata contracts with agents live in `docs/conventions.md`; change them there first.
- `npm run check` (astro check + vitest) must pass before a PR; CI also runs `npm run build`.
- Docs: https://docs.astro.build

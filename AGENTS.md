# Galaxy Clipper

Independent pnpm Electron/React project. No dependency on the downloader or AutoClip at runtime.
Reuse the existing src/components/ui primitives and processing/clipping services.
Gates: pnpm check (typecheck, lint, build). Verify real workflows with a throwaway Electron probe, delete it afterward, and record results in docs/test-links.md and docs/requirements.md. Prototype stage: do not add or modify formal test specifications.
Keep source media unchanged. AI candidates are the only source of draft scenes; no manual source marking, bottom editing region, publishing or local text models. Both local and remote ASR are supported; do not test remote ASR in this task.
Credentials stay in Electron safeStorage; renderer receives no arbitrary filesystem/network IPC. Never log keys.

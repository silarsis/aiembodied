# aiembodied

Embodied ChatGPT assistant prototype exploring an Electron-based kiosk application.

## Getting Started

This repository uses [pnpm](https://pnpm.io) workspaces with dedicated packages for the Electron main process (`app/main`) and the renderer UI (`app/renderer`).

```bash
pnpm install
pnpm exec playwright install
```

## Available Scripts

- `pnpm lint` - Run ESLint across all packages.
- `pnpm typecheck` - Execute TypeScript type checking in each workspace.
- `pnpm test` - Run Vitest suites and Playwright smoke tests.

Renderer-specific commands can be executed from the package directory:

```bash
cd app/renderer
pnpm dev
```

This starts the Vite development server for the kiosk UI shell.

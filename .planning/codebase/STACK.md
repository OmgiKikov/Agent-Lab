---
last_mapped_commit: 015fee98766cc2082001fdfce3a329a31329d4cf
last_mapped_at: 2026-09-16
---
# Technology Stack

**Analysis Date:** 2026-09-16

## Languages

**Primary:**

- TypeScript 5.9.3 - Full codebase (src/, extensions/, skills/)
- JavaScript - Development utilities, Node.js ecosystem

**Secondary:**

- Python - Example target agents (`examples/aigw-observed.py`, `examples/stateful-agent.py`, `examples/echo-agent.py`)
- Shell - CI/CD pipeline examples (`examples/regression-ci.yml`)

## Runtime

**Environment:**

- Node.js >= 22.19.0
- Target ES2023 JavaScript output

**Package Manager:**

- npm with package-lock.json
- Lockfile: Present in repository

## Frameworks

**Core:**

- @earendil-works/pi-coding-agent 0.85.1 - Pi native coding-agent runtime, primary framework
- @earendil-works/pi-tui 0.85.1 - Terminal UI components for Pi

**Schema & Validation:**

- zod 4.5.4 - Runtime TypeScript schema validation and parsing
- typebox 1.3.7 - JSON schema generation and validation

**Build/Dev:**

- tsc (TypeScript Compiler) - Compilation to dist/
- tsx 4.20.0 - Development runtime for TypeScript execution
- node -e inline build script - Custom clean-build process

## Key Dependencies

**Critical:**

- @earendil-works/pi-coding-agent - Pi ecosystem integration, extension API, coding-agent runtime
- @earendil-works/pi-tui - Text UI rendering for terminal, terminal sequence handling
- zod - Schema validation for all data contracts (experiments, scenarios, trials, configurations)
- typebox - JSON schema generation for structured responses

**Infrastructure:**

- @types/node 22.19.0 - Node.js type definitions
- Standard library: node:child_process, node:fs/promises, node:path, node:crypto, node:util, node:readline

## Configuration

**Environment:**

- AGENT_LAB_SESSION - Internal flag set when running Pi chat mode
- Custom HTTP headers via environment variables (configurable per target, names defined in connection configuration)
- No .env file required; all configuration via JSON or command-line

**Build:**

- tsconfig.json - Strict TypeScript compilation (ES2023, NodeNext modules, strict mode, no unchecked index access)
- TypeBox types in JSON schema for judge response format validation

## File Organization

**Source:**

- `src/` - Core TypeScript implementation
- `dist/` - Compiled JavaScript (generated on build)
- `extensions/` - Pi extension (`agent-lab.ts`) providing CLI and UI integration
- `skills/` - Pi skills for agent building (`agent-builder/SKILL.md`)
- `examples/` - Sample agents and configurations (Python, Node.js, JSON)
- `test/` - Test files (run via tsx --test)

## Platform Requirements

**Development:**

- Node.js 22.19.0+
- npm (modern version supporting package-lock.json)
- TypeScript compiler

**Production:**

- Node.js 22.19.0+
- Command-line execution via node dist/cli.js
- No database server required (file-based storage)
- Target agent must accept JSON-line protocol or run as HTTP server

**Deployment:**

- Binary entry point: `dist/cli.js` (shebang line: `#!/usr/bin/env node`)
- Published as npm package to registry
- Available as `agent-lab` command when installed globally

## Build Process

```bash
npm run build        # Clean dist/ then run tsc
npm run typecheck    # Type check with strict settings
npm run test         # Run test suite with tsx
npm run demo         # Execute demo via tsx
npm run pi           # Run Pi extension with skill
npm run start        # Full build + CLI chat entry
prepack              # Runs build before npm publish
```

## External Runtime Dependencies

- Child process spawning for agent targets (command mode)
- HTTP client for agent targets (module provided by @earendil-works/pi-coding-agent runtime)
- File system for experiment storage and logs
- Standard crypto for hashing and UUID generation

---

*Stack analysis: 2026-09-16*

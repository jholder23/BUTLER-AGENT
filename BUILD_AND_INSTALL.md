# Butler – Build & Install (stable desktop)

Session-level UI and Electron changes are summarized in **[THREAD_CHANGES.md](./THREAD_CHANGES.md)**. The packaged app includes everything under `ui/electron/` (including `preload.cjs`) via electron-builder’s `files` list.

This is the **durable desktop app** (Electron + bundled Knowledge API). It does **not** use Vite hot-reload. For day-to-day coding, keep using `npm run dev` / `npm run dev:restart`.

## One-command desktop build

From the repo root:

```bash
npm run desktop
```

Same as `npm run release` / `npm run dist`. Or:

```bash
cd ui
npm run installer
```

(`installer` / `build:app` only builds under `ui/dist-app-new`; `npm run desktop` also copies a portable drop to `dist-desktop/`.)

### What the build does

1. Prepares embedded Python (`ui/python-embed`) and Knowledge deps if needed  
2. Builds the React UI with Vite (**production** `vite build` — no watch)  
3. Packages with electron-builder (static `dist/**` + Electron main; **no** Vite server)  
4. Writes portable app + NSIS installer  

## Artifacts

| Path | What |
|------|------|
| `ui/dist-app-new/win-unpacked/Butler.exe` | Portable unpacked app (double-click) |
| `ui/dist-app-new/Butler Setup 0.1.1.exe` | NSIS installer (version from `ui/package.json`) |
| `dist-desktop/App/Butler.exe` | Release copy of the portable app (from `npm run desktop`) |
| `dist-desktop/installer/` | Copy of the NSIS setup exe |

Override the release folder with `BUTLER_RELEASE_ROOT` (absolute path). Default is **`<repo>/dist-desktop`** (avoids colliding with `D:\BUTLER` on Windows).

## Launch (no rebuild)

- Double-click **`dist-desktop/App/Butler.exe`** or **`Butler-Start.cmd`** next to it  
- Or run the NSIS installer, then Start Menu → **Butler**  
- Desktop shortcut **Butler.lnk** is created when the build finishes on this machine  

Do **not** use `npm run dev` for this — that starts Vite and rebuilds on file changes.

## Local Ollama / chat (`BUTLOR_AI_URL`)

Packaged Electron loads `.env` from `resources/.env` (copied from the repo `.env` at build time).

Before building (or edit `dist-desktop/App/resources/.env` after):

```env
BUTLOR_AI_URL=http://127.0.0.1:11434/v1
PEEPEEDEE_AI_URL=http://127.0.0.1:11434/v1
LOCAL_MODEL=dolphin-llama3:8b
```

Keep **Ollama** running (`ollama serve` / tray app) and pull the model once: `ollama pull dolphin-llama3:8b`.

If `BUTLOR_AI_URL` points at port **5000**, Butler also starts the bundled `knowledge/ai_server.py`. For Ollama (`:11434`), that stub is skipped.

## First run notes

- Packaged desktop: Knowledge API on **8775**, UI API on **4011**, ComfyUI on **8198** by default (`App\resources\.env`: `KNOWLEDGE_API_PORT`, `BUTLER_UI_API_PORT`, `COMFYUI_URL`) so they do not clash with `npm run dev`  
- Dev stack (`npm run dev` / `dev:restart`): Knowledge **8765**, UI API **4001**, Vite **5173**, Comfy **8188** (unchanged)  
- **ComfyUI / SD**: shared repo `sd\` (or `SD_PROJECT_PATH`). Desktop auto-starts a second Comfy process from the same install on **8198** with temp under `%TEMP%\butler-comfyui-desktop` (`--normalvram --fp16-vae --disable-cuda-malloc --disable-pinned-memory`; avoid `--lowvram --disable-smart-memory` on Windows — it can AV at VAEDecode). Packaged Electron does **not** ship Comfy under `resources\sd`; it resolves `SD_PROJECT_PATH` from `.env`, walks up from the exe to find `sd\ComfyUI\main.py`, or uses `D:\BUTLER\sd`. Release writes `SD_PROJECT_PATH` into `App\resources\.env`. Dev: `scripts\start-comfyui-temp.bat` (8188). Manual desktop: `scripts\start-comfyui-desktop.bat`  
- Job search profile: `Documents/Butlor/profile.json` (or `D:\butlor` on Windows)  
- Do not commit `.env` (secrets). The installer copies your local `.env` into the package for this machine only  

## Dev vs desktop

| | Dev (`npm run dev:restart`) | Desktop (`Butler.exe`) |
|--|-----------------------------|-------------------------|
| UI | Vite on **5173** (HMR) | Built files served on **4011** (fallback +10 if busy) |
| UI API | **4001** | **4011** (`BUTLER_UI_API_PORT`) |
| Knowledge | **8765** | **8775** (`KNOWLEDGE_API_PORT`) |
| ComfyUI | **8188** (`start-comfyui-temp.bat`) | **8198** (auto-start / `start-comfyui-desktop.bat`) |
| Rebuild on save | Yes | No |
| Knowledge process | `scripts/run-knowledge-dev.mjs` | Spawned from `resources/python-embed` |
| Typical use | Coding | Daily use / shareable install |

### Run both at once

1. Start `npm run dev` (or `dev:restart`) — binds 8765 / 4001 / 5173. Start Comfy on **8188** if you need images (`scripts\start-comfyui-temp.bat`).  
2. Start `dist-desktop\App\Butler.exe` — binds 8775 / 4011 and starts Comfy on **8198**.  
Order can be reversed. If a desktop port is taken, Electron tries the next (+10). Avoid `npm run free:dev-ports` while desktop Knowledge on 8775 must stay up (that script only frees the dev ports).

## Blockers fixed in this packaging pass

- Release default folder is `dist-desktop/` (avoids `D:\Butler` colliding with `D:\BUTLER` on Windows).
- electron-builder Windows signing disabled for local builds (`signAndEditExecutable: false` + `CSC_IDENTITY_AUTO_DISCOVERY=false`) so winCodeSign symlink errors do not abort the build.
- Knowledge DB / tests / `__pycache__` excluded from the package.
- Bundled `ai_server.py` is skipped when `BUTLOR_AI_URL` is not on port 5000 (Ollama/LM Studio).

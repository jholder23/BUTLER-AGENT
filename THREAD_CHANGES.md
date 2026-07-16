# Changes from this development thread

This document records UI, Electron, and chat updates made in the session that covered the **floating Butler**, **3D avatar tweaks**, and **chat attribution layout**.

Date context: March 2025 (session handoff).

---

## 1. Floating Butler (Electron desktop)

**Goal:** Voice-mode Butler as a **movable, always-on-top window** instead of a second full-screen overlay inside the main app. Main window uses IPC to open/hide/sync the float; closing the float docks it (header state).

### New files

| File | Purpose |
|------|---------|
| `ui/electron/preload.cjs` | `contextBridge`: `butlerElectron` (main window) and `butlerFloat` (float window) for open/hide/close, state sync, dock callback. |
| `ui/src/ButlerFloatWindow.tsx` | Minimal React shell: transparent page, drag region, close (dock), `ButlerAvatar3D` with `layout="float"`. |
| `ui/src/butler-electron.d.ts` | TypeScript declarations for `window.butlerElectron` / `window.butlerFloat`. |

### Modified files

| File | Changes |
|------|---------|
| `ui/electron/main.cjs` | `ipcMain`, `screen`; `mainWindow` / `butlerFloatWindow`; `createButlerFloatWindow()` (frameless, transparent, always-on-top); load `#float-butler`; IPC: sync state, hide-request (dock notify), open/hide/close; **preload** on main window; close float when main window closes. |
| `ui/src/main.tsx` | If `location.hash` is `#float-butler`, render `ButlerFloatWindow` instead of `App`. |
| `ui/src/App.tsx` | `isElectronButler()`; effects: subscribe to docked IPC, open/hide/close float from `voiceMode` + `voiceFaceMinimized`, `syncButlerFloat` for speaking; header **Dock Butler** / **Show Butler** when Electron or minimized; full-screen `voice-face-overlay` only when **not** Electron. |
| `ui/src/styles.css` | `html.butler-float-root` transparent background; `.butler-float-shell`, `.butler-float-stage`, `.butler-float-close`; overlay stage made borderless/transparent for web. |

### 3D avatar (`ui/src/ButlerAvatar3D.tsx`)

- **`layout`:** added `'float'` (union with `'header' | 'stage'`).
- **Removed** gold **torus** + dark **ring** around the textured face (`IconButlerFace`).
- **Mouth under mustache:** fallback sculpt and textured face reordered positions; mouth uses matte `meshStandardMaterial` (no heavy clearcoat).
- **`float` layout:** smaller disc, no `ContactShadows`, camera/FOV tuned; stage shadows slightly softened when not floating.

---

## 2. Chat: Butler icon + source line

**Goal:** Assistant messages show **Butler’s icon** in the avatar column instead of provider text (e.g. OpenAI, Stable Diffusion). The **source** appears as **small muted text** under the reply (below text/images/video).

### Modified files

| File | Changes |
|------|---------|
| `ui/src/App.tsx` | Assistant `avatar`: `<img src="./icon.png" … />` (user still **You**); after message body, `assistant && source` → `<div class="chat-message-source">`. |
| `ui/src/styles.css` | `.chat-row:not(.chat-row-user) .avatar` padding/background for icon; `.avatar-butler-icon`; `.chat-message-source` (small type, border-top, muted opacity); dark theme tweak. |

---

## 3. Installer / packaging

- **electron-builder** already includes `electron/**`, so **`preload.cjs`** is bundled with the app; no `installer.nsh` change required for these features.
- **Version bump:** `ui/package.json` and root `package.json` were set to **0.1.1** so the NSIS artifact name (`Butler Setup 0.1.1.exe`) reflects this release.
- Build command unchanged: from `ui`, `npm run installer` (or repo root `npm run build:installer`).

---

## 4. How to rebuild the Windows installer

```bash
cd ui
npm run installer
```

Output: `ui/dist-app-new/` (installer `.exe` and/or unpacked app per your electron-builder target).

---

## 5. Quick file checklist

```
ui/electron/preload.cjs          (new)
ui/electron/main.cjs             (modified)
ui/src/ButlerFloatWindow.tsx     (new)
ui/src/butler-electron.d.ts      (new)
ui/src/main.tsx                  (modified)
ui/src/App.tsx                   (modified)
ui/src/ButlerAvatar3D.tsx        (modified)
ui/src/styles.css                (modified)
package.json                     (version)
ui/package.json                  (version)
BUILD_AND_INSTALL.md             (pointer + version note)
THREAD_CHANGES.md                (this file)
```

If anything is missing in your tree, compare against this list and git history.

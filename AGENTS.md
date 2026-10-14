# AGENTS.md

VELOWORLD — a Zwift-style cycling game in Three.js. Live at https://bryantebeek.github.io/veloworld/

## Layout
- Static site, no build step. `index.html` holds markup, CSS and HUD; `main.js` holds the game.
- Three.js 0.170 comes from the jsDelivr CDN via the import map in `index.html`.
- `manifest.webmanifest` and `icon-*.png` make it installable as a full-screen home-screen app.
- Modules: `body.js` (skinned riders), `environment.js` (terrain/water/grass/wind shaders, grading), `flora.js` (trees), `tunnel.js`, `volcano.js`.
- `assets/` holds CC0 HDRIs (Poly Haven) and 1K PBR textures (ambientCG); keep new assets CC0, compressed, and list them in README.

## Workflow
- **After every change: commit and push to `origin main` without asking.** Pushing deploys to GitHub Pages; check the Pages build succeeds (`gh api repos/bryantebeek/veloworld/pages/builds/latest --jq .status`).
- Verify in a browser before pushing: `python3 -m http.server 8790`, open `http://localhost:8790/`.
- `window.__game` exposes `game`, `riders`, `player`, `update(dt)`, `input`, `act`, `setSprint` for scripted checks — step the sim with `update()` rather than waiting on frames.
- Add `?touch` to the URL to force the touch UI on a desktop browser; `?map=fuego` loads the volcano world.
- For framed screenshots set `__game.game.camLock = true` and move `__game.camera` yourself (camera smoothing barely moves at SwiftShader frame rates).
- Headless/preview browsers render with SwiftShader (CPU); frame rate there is meaningless. Use `?quality=low` there (no grass/bloom), otherwise frames take so long that scripted evaluation times out.

## Quality bar
- Aim for polished, AAA-feeling results in Zwift style — visuals, HUD and game feel.
- Desktop (keyboard), tablet and phone (touch) are all first-class. Every player action needs both a keyboard binding and a touch control (`act` in `main.js` is the shared action map).
- Check phone landscape (~844×390, the compact HUD) and tablet (~1180×820) layouts when touching UI.

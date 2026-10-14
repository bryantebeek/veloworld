# VELOWORLD

A Zwift-style virtual cycling game in Three.js with two worlds — **Isla Verde** (rolling hills and lakes) and **Fuego** (an active volcano at sunset: the lap starts in a lava cavern inside the mountain and tunnels through it, with eruptions, lava rivers and black-sand beaches) — each with a KOM and sprint, 40 AI riders with drafting and attacks, power-based physics, power-ups, race mode, and optional Bluetooth smart trainer / heart-rate support (Chrome).

**Play:** https://bryantebeek.github.io/veloworld/

Controls: ↑/↓ power, ←/→ steer, Space power-up, 1–6 camera, R Ride On, P pause. Touch devices get on-screen controls.

Living worlds: wind-blown grass and trees, shoreline foam, birds, eruptions with lava bombs and volcanic lightning. Add `?quality=low` on weak devices.

No build step — static files. Run locally with `python3 -m http.server`.

## Assets

All third-party assets are CC0 (public domain):
- HDRI skies from [Poly Haven](https://polyhaven.com): `kloofendal_48d_partly_cloudy_puresky`, `qwantani_sunset_puresky`
- PBR textures from [ambientCG](https://ambientcg.com): Grass004, Ground037, Ground054, Rock051, Rock058, Snow015, Asphalt033, Bark012, Bark014, LeafSet009, Lava001

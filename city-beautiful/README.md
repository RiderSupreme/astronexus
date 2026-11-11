# City Beautiful

A first-person survival shooter set in Chandigarh's Capitol Complex in 2087,
sixty monsoons after the city was evacuated. The concrete is still standing.
The banyans have the plazas, and something called the Bloom has the people.

It runs in a browser tab with no build step and no downloaded art: every
texture, tree, building, sound and creature is generated when the page loads.

## Playing

Serve this folder with any static file server and open it:

```sh
cd city-beautiful
python3 -m http.server 8080      # then visit http://localhost:8080
```

It needs a network connection the first time, for three.js (from a CDN) and
the typefaces (Google Fonts). A WebGL 2 browser is required; a laptop with a
discrete or recent integrated GPU is the intended machine. Phones work on the
lowest preset with touch controls.

### The night's work

You arrive an hour before sunset on the autumn equinox. The infected stand
motionless all day with their faces to the Sun, and walk when it sets.

1. Find the three relief batteries: High Court, Tower of Shadows, Assembly.
2. Carry them to the Open Hand and light the beacon.
3. Stay alive until sunrise.

Every battery you take costs daylight. Lighting the beacon wakes everything.

### Controls

| | Keyboard and mouse | Touch |
|---|---|---|
| Move | `W A S D` | left thumb (push right up to run) |
| Look | mouse | right thumb |
| Fire / aim | left / right button | `FIRE` / `AIM` |
| Run, crouch, jump | `Shift`, `C`, `Space` | stick, –, `JUMP` |
| Reload | `R` | `LOAD` |
| Weapons | `1` `2` `3`, wheel, `Q` | `SWAP` |
| Rifle butt | `V` | – |
| Grenade | `G` | `NADE` |
| Torch | `F` | `LAMP` |
| Use (batteries, beacon) | hold `E` | `USE` |
| Pause | `P` or `Esc` | `II` |

Settings (quality, sensitivity, field of view, volume, invert look) are on the
title and pause screens and are remembered. Quality can also be forced with
`?q=low|medium|high|ultra`.

## What is real in it

- **The place.** The Assembly with its hyperboloid tower and pivoting enamel
  door, the High Court's parasol roof and three painted piers, the Tower of
  Shadows, the Geometric Hill, the Martyrs' Memorial, the Open Hand in its
  sunken court, the Secretariat slab and the Shivalik ridge behind. Proportions
  follow Le Corbusier's buildings; distances between them are compressed so
  the complex can be crossed on foot in a couple of minutes. The door's mural
  is an original composition in the manner of the real one, not a copy.
- **The sky.** `js/astro.js` computes the Sun, the Moon and about three
  hundred named stars for latitude 30.73° N, longitude 76.78° E on
  23 September 2087: Julian date, sidereal time, precession from J2000,
  refraction and lunar parallax. Sunset is at 18:17 due west; a thin waning
  crescent rises about 04:15; the Sun comes up at 06:13 behind the High Court.
  The gnomon on the Geometric Hill points at the celestial pole. The sky's
  colour is a single-scattering atmosphere integrated for the Sun's actual
  altitude, and that same table lights the fog and the ambient light.
- **The growth.** Banyan, peepal, neem, kans grass, bougainvillea and lotus
  are what actually takes over neglected ground on the plains below the
  Shivaliks.

## How it is put together

Plain ES modules, loaded directly by the browser.

| File | What it does |
|---|---|
| `index.html` | Markup and CSS for the HUD, menus and touch controls |
| `js/main.js` | Boot, loading, game states, the frame loop |
| `js/lib/three.js` | Loads three.js r160 from a CDN, with two fallbacks |
| `js/gfx.js` | Renderer, HDR target, bloom, sun shafts, grading, quality presets |
| `js/astro.js` | Positional astronomy |
| `js/sky.js` | Atmosphere, stars, Milky Way, Moon, clouds, sun and moon light |
| `js/shared.js` | Uniforms and GLSL shared by every material (fog, noise) |
| `js/textures.js` | Textures baked on the GPU at load: concrete, paving, soil, rust, bark |
| `js/materials.js` | Weathered concrete, metal, glass, water: stains, moss, cracks, puddles |
| `js/geom.js` | Geometry builder with baked ambient occlusion |
| `js/physics.js` | Collision solids: ray casts, capsule sweeps, floors |
| `js/world.js` | Terrain, ground, and the assembly of the level |
| `js/capitol.js` | The buildings, as recipes |
| `js/props.js` | Vehicles, checkpoint, camp, signs in Hindi, Punjabi and English |
| `js/foliage.js` | Leaf and grass sprites painted on a canvas |
| `js/vegetation.js` | Procedural trees, grass, creepers, wind |
| `js/nav.js` | Flow-field navigation for the infected |
| `js/player.js` | First-person movement |
| `js/zombies.js` | The infected: skinned rig, procedural animation, behaviour |
| `js/weapons.js` | Pistol, shotgun, rifle, grenades, torch, view model |
| `js/fx.js` | Particles, decals, tracers, shell casings |
| `js/mission.js` | Objectives, pickups, the beacon, the clock, the director |
| `js/hud.js` | Heads-up display and menus |
| `js/audio.js` | Synthesised sound and music (Web Audio) |
| `js/input.js` | Keyboard, mouse, pointer lock, touch |

Development switches: `?dev` exposes `window.__game` helpers, `?noloop` stops
the frame loop so a test can step the simulation itself, `?play` skips the
title.

## Credits

Built with [three.js](https://threejs.org) (MIT). Typefaces: Big Shoulders
Stencil, Barlow Condensed, IBM Plex Mono, Teko and Noto Sans Gurmukhi (SIL Open
Font Licence), served by Google Fonts. Everything else is generated by the code
in this folder.

This is a work of fiction. It is not affiliated with the Chandigarh
Administration, Chandigarh Police, the Fondation Le Corbusier or anyone else.

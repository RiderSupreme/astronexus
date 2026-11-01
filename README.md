# NMS AstroNexus '26

Website for **AstroNexus '26** — the UAE's first student-led space event, run by the
Al Amal Space Club and the Physics Department at GEMS New Millennium School.

**5 November 2026 · 8:00 AM – 1:30 PM**

## The four challenges

| Sub-event | Year group | Focus |
|---|---|---|
| LostInOrbit | Grade 6 | Orbital crisis & satellite rescue |
| TerraFab | Grades 7–8 | Light-routing optics & interference |
| LaunchX | Grades 9–10 | Rocketry design |
| HelioScale | Grades 11–12 | Solar data analysis |

## How it's built

Five static HTML files. **No build step, no dependencies, no CDN** — every image
is inlined as a base64 data URI and all JavaScript is hand-written vanilla. Open
`index.html` in a browser and it works.

That constraint is deliberate: the landing page is also published as a
self-contained artifact, where external scripts are blocked.

The landing page carries a scroll-driven sequence — the wordmark dissolves, the
rocket crosses to Mars while the camera pushes in, and it lands on an
interactive globe you can spin. The globe is rendered by per-pixel inverse
orthographic projection in Canvas 2D against precomputed lookup tables, so it
needs no WebGL and runs on school hardware. Feature markers (seas, basins,
volcanoes, landing sites) sit at real coordinates and rotate with the planet.

Everything respects `prefers-reduced-motion`.

## Local preview

Any static server will do:

```bash
python -m http.server 5500
```

Then open <http://localhost:5500>.

## Files

- `index.html` — landing page and hero sequence
- `lostinorbit.html`, `terrafab.html`, `launchx.html`, `helioscale.html` — sub-event pages
- `layers/` — logo decomposed into animatable layers, with `layers.json` holding their
  positions in the artwork's 1500×1500 frame
- `wordmark.webp`, `mars.webp`, `rocket.webp`, `rocket-shadow.webp` — hero layers
- `mars-texture.webp` — NASA/USGS Viking global mosaic (public domain), colour-graded
- `og-card.png` — social sharing card
- `set-ramp.py` — swaps the bokeh field's colour ramp across all pages

## Credits

Mars surface texture: NASA / USGS Viking global colour mosaic (public domain).

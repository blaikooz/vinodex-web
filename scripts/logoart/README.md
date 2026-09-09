# Source logo art

The originals the shipped marks are derived from. Not served: `web/public/`
holds the derived files the app actually loads.

- `horizon-godot-logo-1024.png` — the studio mark as supplied (2026-09-09),
  1024x1024 on a white field. `web/public/horizon-godot-logo.png` is this
  cropped square to the disc and masked to a circle with a transparent
  outside, then resized to 512, so the mark never shows a white box behind
  it on a dark tab bar.

To regenerate the shipped file, crop to the dark disc's bounding box, apply a
circular alpha mask at that radius, and resize to 512 with LANCZOS.

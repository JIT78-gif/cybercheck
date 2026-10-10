# cybercheck: Design System (Master)

Source: ui-ux-pro-max data (`products.csv` rows "Cybersecurity Platform" + "Developer Tool / IDE", `ui-reasoning.csv`, `typography.csv` "Developer Mono", `landing.csv` "Trust & Authority" + "Real-Time / Operations"), adapted to the user's references (LangSmith landing, Tavily dashboard).
Page-specific overrides live in `design-system/pages/<page>.md` and win over this file.

## Product reading
- Type: developer tool + security platform. Audience: developers, founders, small teams.
- Pattern: **Trust & Authority**: clarity, evidence, calm confidence. Not "hacker" theatre.
- Copy: **never use the em dash (—)** anywhere in UI text or docs (user preference). Use a comma, period, colon, or "and" instead.
- Anti-patterns (from data): neon matrix-green cyberpunk, AI purple/pink gradients, playful styling, colour-only status, fake social proof (logos, testimonials, stats, compliance badges we don't hold).

## Typography
- Sans (headings + body): **IBM Plex Sans** 400/500/600/700.
- Mono (eyebrows, labels, code, IDs, numbers in data): **JetBrains Mono** 400/500.
- Scale (px): 12 · 14 · 16 · 18 · 20 · 24 · 30 · 36 · 48 · 60. Body 16, line-height 1.6. Headings tight (1.1–1.2), weight 500–600.
- Eyebrows: mono, 12–13px, uppercase, letter-spacing 0.08em, accent colour.

## Colour tokens (semantic only, never raw hex in components)
| Token | Marketing (dark) | App (light) |
|---|---|---|
| `bg` | `#070B14` | `#FAFAF7` |
| `surface` | `#0D1526` | `#FFFFFF` |
| `surface-2` | `#121D33` | `#F3F2EE` |
| `border` | `#1E2B45` | `#E6E4DE` |
| `fg` | `#E6EDF7` | `#0F172A` |
| `fg-muted` | `#9AA8BD` | `#4B5563` |
| `accent` | `#7CC4FA` | `#1D4ED8` |
| `primary` (button bg) | `#E8F3FF` | `#0B1B33` |
| `primary-fg` | `#06101F` | `#FFFFFF` |
| `success` | `#4ADE80` | `#15803D` |
| `warning` | `#FBBF24` | `#B45309` |
| `danger` | `#F87171` | `#B91C1C` |
| `ring` | `#7CC4FA` | `#1D4ED8` |

All text pairs ≥ 4.5:1 (muted on bg: dark ≈ 7.9:1, light ≈ 7.4:1). Status always paired with an icon or label.

## Shape, depth, motion
- Radius: 6 (controls) · 10 (cards) · 16 (feature panels). Borders over shadows on dark; soft shadow `0 1px 2px rgb(0 0 0 / .05)` on light.
- Dark panels: 1px border + subtle top gradient glow of accent at ≤ 12% opacity.
- Motion 150–250 ms ease-out; fade/translate only; everything disabled under `prefers-reduced-motion`.

## Layout
- Container max-width 1200px; gutters 16 / 24 / 32 px (mobile / tablet / desktop).
- Breakpoints 375 / 768 / 1024 / 1440. Section vertical rhythm 96px desktop, 64px mobile.
- Icons: lucide-react only, 1.75 stroke, sizes 16 / 20 / 24.

## Interaction & accessibility
- Visible focus ring (2px `ring`, 2px offset) on every interactive element; skip link to main.
- Touch targets ≥ 44px; cursor-pointer on clickables; buttons show loading state and disable during async work.
- One primary CTA per view; secondary actions use outline style.
- Forms: visible labels, helper text, errors below field with cause + fix, `aria-live` for errors.

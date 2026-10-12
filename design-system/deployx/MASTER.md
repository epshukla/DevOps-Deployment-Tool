# DeployX Design System — MASTER

Source of truth for UI decisions. Page files in `pages/` may override.
Derived with the **UI/UX Pro Max** skill (v2.15.0), verified against the product:

| Query | Verified match |
|---|---|
| `devops monitoring dashboard` (product) | **Status Page / Incident Management** — Data-Dense Dashboard + Real-Time Monitoring + Timeline; palette: status green, incident red, maintenance amber, neutral dark |
| `data-dense dashboard dark` (style) | **Data-Dense Dashboard** — 12-col grid, 8px gaps, 12px card padding, 36px rows, sticky headers, 12–14px type |
| `developer tool CI/CD devops dashboard dark` (design system) | Style **Dark Mode (OLED)**; type **JetBrains Mono + IBM Plex Sans**; palette "code dark + run green". (Its suggested *FAQ landing* pattern was rejected as off-product.) |

## Principles
1. **Colour means status.** Neutral UI; colour is reserved for state (go / fail / running / hold). Never convey status by colour alone — every status has an icon and a word (UX: *Color Only*, severity High).
2. **Tables over cards.** Lists of runs, deployments, runners, events are tables/rows with sticky headers, not card grids. Cards only for genuinely separate objects (projects).
3. **Density with air.** 8px grid. Rows 36px. Panel padding 12–16px. Page gutter 24px (16px mobile).
4. **Quiet chrome.** No decorative icons beside headings, no glow, no gradients on surfaces, no ALL-CAPS-everywhere. One primary action per view.
5. **Mobile works.** Sidebar becomes a drawer < 1024px; wide tables scroll horizontally inside their panel.

## Tokens (dark only)
| Role | Value | Token |
|---|---|---|
| Canvas | `#0B1120` | `background`, `surface` |
| Panel | `#0F172A` | `surface-container-low` |
| Raised / hover | `#131C2E` / `#1B2336` | `surface-container` / `-high` |
| Muted fill | `#272F42` | `surface-container-highest` |
| Hairline | `#1E293B` | `outline-variant` |
| Strong border | `#475569` | `outline` |
| Text / muted | `#F1F5F9` / `#94A3B8` | `on-surface` / `on-surface-variant` |
| Primary (neutral CTA, active nav) | `#E2E8F0` on `#0F172A` | `primary` / `on-primary` |
| Run accent | `#22C55E` on `#052E16` | `accent` / `on-accent` |
| Success / go | `#22C55E` | `tertiary` |
| Failed / incident | `#F87171` | `error` |
| Running | `#60A5FA` | `info` |
| Hold / awaiting / degraded | `#F59E0B` | `warning` |
| Focus ring | `#F1F5F9`, 2px, offset 2 | — |

Contrast: all text tokens ≥ 4.5:1 on panel.

## Type
- Headings, numbers, IDs, SHAs, durations: **JetBrains Mono** (500–600), tabular.
- Body / UI: **IBM Plex Sans** 14px / 1.5; captions 12px min.
- Page title 20px, section title 14px semibold, table header 12px muted (sentence case).

## Motion
Subtle (dial 3): 150–200ms colour/opacity transitions; one 200ms fade on page entry; `prefers-reduced-motion` disables all.

## Components
- **StatusBadge**: icon + label + tone; sizes sm/md. Used for runs, tasks, deployments, health, runners.
- **Panel**: `rounded-lg bg-surface-container-low border border-outline-variant`, header row 44px with title + actions.
- **DataTable rows**: 36px, hover `surface-container`, whole row clickable via cell links, sticky header.
- **KPI strip**: one panel split into cells (label, mono value, delta) — not separate floating cards.
- Buttons: primary (neutral light), accent (run/trigger only), secondary (outline), ghost; min height 32px desktop / 44px touch.

## Pre-delivery checklist (from skill)
- [ ] No emoji icons; decorative icons `aria-hidden`
- [ ] `cursor-pointer` + hover 150–300ms on clickables
- [ ] Visible focus for keyboard nav
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive at 375 / 768 / 1024 / 1440
- [ ] Status never by colour alone

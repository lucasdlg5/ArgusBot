---
name: argus-ui-ux
description: >-
  Use this skill whenever designing, building, or reviewing UI components,
  layouts, user flows, modals, or copy in the ArgusBot web dashboard so every
  screen follows user-centered UX/UI principles without technical jargon.
---

# ArgusBot UI & UX Design Guidelines

Apply these principles across all pages (`/` dashboard, `/notas`, `/produtos`, `/mercados`, `/receitas`) and interactive components.

## Core UX & UI Premises

1. **UX First, UI Second (Structure Before Decoration)**
   - **UX (Experience):** Prioritize clear information architecture, minimal clicks to complete a task, and frictionless user flows (e.g., inline edit modals that update state without page reloads, direct actions without unnecessary confirmation steps).
   - **UI (Interface):** Maintain visual consistency using shared dark slate/emerald design tokens, clear visual hierarchy, predictable spacing grids, and responsive layouts for desktop and mobile.

2. **Simple, Human-Centered Copy (Zero Technical Jargon)**
   - Write labels, subtitles, and feedback in plain Brazilian Portuguese from the **user's perspective**.
   - **Never** expose internal database schemas, SQL view names, variable names, or engineering acronyms (`argus.v_*`, `is_essential = false`, `CEIL`, `MIN_SAVINGS_HURDLE`, `anti-SSRF`, `JSON-LD/Microdata`) in user-facing UI text.

3. **Layout & Visual Hierarchy**
   - Use **F-pattern / Z-pattern** scanning: clear top navigation bar with live site version (`APP_VERSION_LABEL`), concise page hero, scannable KPI summary cards, and focused action areas.
   - Keep **Card Grids** uniform and scannable with progressive disclosure (expandable rows/cards for details rather than overwhelming the initial view).
   - Provide immediate visual feedback on every user action (loading states, live calculation previews inside modals, and non-blocking success/error banners).

4. **Interaction Design & Accessibility**
   - Keep primary actions unmistakable and reachable where the user is looking (e.g., **Editar** button inside expanded ingredient details opening an overlay modal).
   - Ensure modals trap click propagation cleanly, support closing via backdrop/cancel button, and update React state immediately on save.

## Reference Sources

- Figma — *Difference Between UI and UX*: https://www.figma.com/resource-library/difference-between-ui-and-ux/
- Hostinger — *Website Layout Ideas & Visual Hierarchy*: https://www.hostinger.com/tutorials/website-layout-ideas/
- WeJam — *Dominando UX e UI: Um Guia Completo com Exemplos*: https://wejam.digital/dominando-ux-e-ui-um-guia-completo-com-exemplos/
- Vídeo de Referência UI/UX: https://www.youtube.com/watch?v=vpETwq8FO7U&themeRefresh=1

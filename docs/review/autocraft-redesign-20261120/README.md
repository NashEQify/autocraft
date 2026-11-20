# Redesign review screenshots

Original captures of our AutoCraft dashboard with its synthetic mock fixtures, made for this PR by @skylartaylor on 2026-11-20. These are review/documentation images, not runtime assets or test fixtures. No live account data, backend traffic or submitted answers are involved. Captures are unretouched browser viewports with loaded fonts and a light theme.

- **Before:** main `bf7402e6f20d07a8d6e06e52048981c7c9e8317f`; source manifest `14fa0b028dcf7df522dfe25bf6792e58e411af71fba0b80092d32e21c4535cf8`.
- **After:** the redesign on that same base; validated code manifest `1e10d140909f4396f0c1ff42fd4cf1173b65fd995ec5f13f81b0ca28fa223f69` (before this image/documentation-only addition).

| Pair | Route and viewport | What it shows |
| --- | --- | --- |
| `needs-desktop-before.png` / `needs-desktop-after.png` | `/needs?kind=merge&all=1&decision=designcraft%231484%3Amerge`, 1440×900 | Same merge queue. The redesign can show designcraft#1484 beside the queue; main opens the full item when a row is activated. Review and answer still opens that full answer form. |
| `items-phone-before.png` / `items-phone-after.png` | `/items?phase=Review`, 390×844 | Same seven-item Review-phase view, before and after consolidation. |

The content and counters are synthetic; these are UI comparisons, not production data or count/age benchmarks. Existing mock endpoints and recommendation text are not guaranteed to agree. Each capture was checked with its accessibility tree. This does not establish complete screen-reader support or visual parity.

The captures are original work under `MIT OR Apache-2.0`; the existing, unmodified ArtCraft mark remains subject to `LICENSE-brand.txt` and is used only to identify this project's tool. See the root `ATTRIBUTION.md`.

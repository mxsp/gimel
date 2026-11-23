# Design foundation for the Gimel portal

The UI work in this folder follows the Vercel design guidelines saved in this
project as [vercel-design.md](./vercel-design.md) (source:
<https://vercel.com/design.md>).

Everything the guidelines reference is copied into the project so the internal
portal stays self-contained and works without a connection to the internet:

| Path | What |
| --- | --- |
| `vercel-design.md` | The guidelines, downloaded verbatim. |
| `public/assets/vercel-brand.css` | Byte-identical VBG foundation: public tokens, type roles, report primitives. Its `.vbg-*` classes are never restyled. |
| `public/assets/geist-fonts.css` | Local `@font-face` rules for Geist and Geist Mono. |
| `public/assets/fonts/*.woff2` | The Geist and Geist Mono font files. |
| `public/assets/vercel-wordmark.svg`, `vercel-logo.svg`, `vercel-logotype-{black,white}.{svg,png}` | Official brand assets, kept for reference. Gimel is not a Vercel-authored surface, so none of them is rendered in the UI. |

`index.html` links `geist-fonts.css` and `vercel-brand.css` once, with
`%BASE_URL%` so Vite resolves them correctly under the `/app/` base.

`src/vercel-polish.css` is the first UI pass. It is imported only from
`src/main.tsx`, the `/app` portal entry, so `src/studio/` (Twin Studio) and
`agentlab/` are untouched. It builds on the existing `--g-*` tokens: Geist
typography, tabular numerals and sentence-case labels instead of tracked
all-caps eyebrows. It does not add a parallel color system, surfaces or effects.

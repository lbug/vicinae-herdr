// Generates assets/agent-<kind>.svg monogram badges for herdr agents without a logo.
// Monochrome on purpose: Vicinae tints them to the theme's text color, like the logos.
// Run: node scripts/generate-monograms.mjs
import { writeFileSync } from "node:fs";

const MONOGRAMS = {
  pi: "π",
  codex: "cx",
  amp: "amp",
  kiro: "ki",
  droid: "dr",
  grok: "gk",
  devin: "dv",
  letta: "le",
  kilo: "kl",
  qodercli: "qo",
  mastracode: "ma",
  hermes: "he",
  agy: "ag",
  omp: "omp",
  maki: "mk",
  muse: "mu",
};

const FONT_SIZE = { 1: 15, 2: 11, 3: 8.5 };

for (const [kind, label] of Object.entries(MONOGRAMS)) {
  const size = FONT_SIZE[[...label].length];
  const svg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="1" width="22" height="22" rx="5" fill="none" stroke="#000" stroke-width="2"/>
  <text x="12" y="12" dy="0.35em" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${size}" fill="#000">${label}</text>
</svg>
`;
  writeFileSync(new URL(`../assets/agent-${kind}.svg`, import.meta.url), svg);
}

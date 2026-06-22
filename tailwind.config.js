/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Design tokens — the 6-8 hex colors that were hardcoded 100+ times
        // across the components (see plans/frontend-refactor-and-ux.md §1.D).
        // These are the CURRENT palette; no visual change, just centralized so
        // a future theme variant or light mode only needs to touch one place.
        //
        // Naming convention mirrors the existing ad-hoc usage:
        //   surface  = page background           (was #0d1117)
        //   panel    = card/panel background      (was #161b22)
        //   raised   = hover/active surface       (was #1e293b)
        //   edge     = borders / hairlines        (was #1f2937 / slate-800-ish)
        surface: '#0d1117',
        panel: '#161b22',
        raised: '#1e293b',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

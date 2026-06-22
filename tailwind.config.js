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

        // Intermediate scale steps that the codebase already references but
        // are NOT in Tailwind's default palette (slate-850, gray-450/455/650,
        // slate-350). Previously the CDN silently dropped these classes, so
        // the elements relying on them got no color at all (e.g. borders
        // inherited currentColor). Adding them with the midpoint value
        // between their neighbors restores the intended look.
        //   slate-850 = midpoint(slate-800, slate-900)
        //   gray-450  = midpoint(gray-400, gray-500)
        //   gray-455  = alias of gray-450 (was a typo in the code, kept for back-compat)
        //   gray-650  = midpoint(gray-600, gray-700)
        //   slate-350 = midpoint(slate-300, slate-400)
        slate: {
          350: '#b0bccc',
          850: '#162032',
        },
        gray: {
          450: '#848a98',
          455: '#848a98',
          650: '#414b5a',
        },
      },
      zIndex: {
        // z-25 and z-35 used in the profile chart badges; not in the default scale.
        25: '25',
        35: '35',
      },
      spacing: {
        // py-0.2 used in small badges; ~0.8px. Not in the default scale.
        '0.2': '0.125rem',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

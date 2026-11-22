import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Jackfruit (Kathal) rind & olive-moss dark neutral surfaces
const JACKFRUIT_NEUTRAL = {
  50:  '#f6f9f4',
  100: '#eaf2e6',
  200: '#d2e2cc',
  300: '#b1c9a8',
  400: '#8ba881',
  500: '#64805b',
  600: '#455c3e',
  700: '#2d3f28',
  800: '#1d2b1a',
  900: '#101a10',
  950: '#080c08',
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{js,ts,jsx,tsx}'),
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', '"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        slate: JACKFRUIT_NEUTRAL,
        gray: JACKFRUIT_NEUTRAL,
        // Jackfruit leaf & outer rind green (primary interactive accent)
        kathal: {
          50:  '#f2fbf2',
          100: '#dff6df',
          200: '#bfebc0',
          300: '#8bda8f',
          400: '#52c45b',
          500: '#28a138',
          600: '#1d7a2b',
          700: '#186124',
          800: '#154d20',
          900: '#113f1b',
          950: '#07220d',
        },
        // Healthy canopy green
        green: {
          50:  '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
          950: '#052e16',
        },
        // Ripe jackfruit pod (bulb) golden-yellow
        yellow: {
          50:  '#fefce8',
          100: '#fef9c3',
          200: '#fef08a',
          300: '#fde047',
          400: '#facc15',
          500: '#eab308',
          600: '#ca8a04',
          700: '#a16207',
          800: '#854d0e',
          900: '#713f12',
          950: '#422006',
        },
        amber: {
          50:  '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#facc15',
          500: '#eab308',
          600: '#ca8a04',
          700: '#a16207',
          800: '#854d0e',
          900: '#713f12',
          950: '#451a03',
        },
        // Woodland crimson red
        red: {
          50:  '#fef2f2',
          100: '#fee2e2',
          200: '#fecaca',
          300: '#fca5a5',
          400: '#f87171',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
          800: '#991b1b',
          900: '#7f1d1d',
          950: '#450a0a',
        },
      },
    },
  },
  plugins: [],
}

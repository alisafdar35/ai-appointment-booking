import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

/** Maps a CSS variable holding "R G B" channels to a colour that still supports `/alpha`. */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

/**
 * The palette lives in CSS variables (see src/app/globals.css), so light and
 * dark mode are a variable swap rather than a `dark:` variant on every element.
 * Components therefore only ever name semantic roles (surface, muted, accent…),
 * never raw colours.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: token('background'),
        foreground: token('foreground'),
        surface: token('surface'),
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          foreground: token('accent-foreground'),
          subtle: token('accent-subtle'),
          text: token('accent-text'),
          border: token('accent-border'),
        },
        success: {
          DEFAULT: token('success'),
          subtle: token('success-subtle'),
          text: token('success-text'),
          border: token('success-border'),
        },
        warning: {
          DEFAULT: token('warning'),
          subtle: token('warning-subtle'),
          text: token('warning-text'),
          border: token('warning-border'),
        },
        danger: {
          DEFAULT: token('danger'),
          hover: token('danger-hover'),
          foreground: token('danger-foreground'),
          subtle: token('danger-subtle'),
          text: token('danger-text'),
          border: token('danger-border'),
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgb(var(--shadow) / 0.05), 0 1px 3px rgb(var(--shadow) / 0.05)',
        popover: '0 10px 30px -8px rgb(var(--shadow) / 0.25), 0 2px 6px rgb(var(--shadow) / 0.08)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'rise-in': 'rise-in 150ms ease-out',
      },
      transitionDuration: { DEFAULT: '150ms' },
    },
  },
  plugins: [
    // Touch targets only grow on touch devices, so dense desktop layouts stay compact.
    plugin(({ addVariant }) => addVariant('coarse', '@media (pointer: coarse)')),
  ],
};

export default config;

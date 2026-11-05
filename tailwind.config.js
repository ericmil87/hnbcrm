// Color tokens are RGB channels defined in src/index.css; <alpha-value> enables `/NN`.
const c = (name) => `rgb(var(--rgb-${name}) / <alpha-value>)`;
const scale = (name, steps) => Object.fromEntries(steps.map((s) => [s, c(`${name}-${s}`)]));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: scale("brand", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        ai: scale("ai", [300, 400, 500, 600, 700]),
        surface: {
          base:    c("surface-base"),
          raised:  c("surface-raised"),
          overlay: c("surface-overlay"),
          sunken:  c("surface-sunken"),
        },
        border: {
          DEFAULT: c("border-default"),
          subtle:  c("border-subtle"),
          strong:  c("border-strong"),
        },
        text: {
          primary:   c("text-primary"),
          secondary: c("text-secondary"),
          muted:     c("text-muted"),
        },
        semantic: {
          success: c("semantic-success"),
          error:   c("semantic-error"),
          warning: c("semantic-warning"),
          info:    c("semantic-info"),
        },
        chat: { bg: c("chat-bg"), header: c("chat-header"), send: c("chat-send") },
        composer: { DEFAULT: c("composer"), field: c("composer-field") },
        bubble: {
          in:            c("bubble-in"),
          "in-link":     c("bubble-in-link"),
          out:           c("bubble-out"),
          "out-fg":      c("bubble-out-fg"),
          "out-label":   c("bubble-out-label"),
          "out-link":    c("bubble-out-link"),
          ai:            c("bubble-ai"),
          "ai-label":    c("bubble-ai-label"),
          note:          c("bubble-note"),
          "note-label":  c("bubble-note-label"),
          "note-border": c("bubble-note-border"),
          system:        c("bubble-system"),
          "system-fg":   c("bubble-system-fg"),
        },
        tick: { read: c("tick-read") },
        badge: { unread: c("badge-unread"), "unread-fg": c("badge-unread-fg") },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        btn:   '9999px',
        card:  '12px',
        field: '8px',
      },
      boxShadow: {
        card:         'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        elevated:     'var(--shadow-elevated)',
        glow:         'var(--shadow-glow)',
        bubble:       'var(--shadow-bubble)',
      },
      screens: {
        xs: '375px',
        coarse: { raw: '(pointer: coarse)' },
      },
      fontSize: {
        caption: ['12px', { lineHeight: '16px' }],
        micro: ['11px', { lineHeight: '14px' }],
      },
      animation: {
        'fade-in':       'fadeIn 200ms ease-out',
        'fade-in-up':    'fadeInUp 200ms ease-out',
        'slide-in-right': 'slideInRight 300ms ease-out',
        'slide-in-up':   'slideInUp 300ms ease-out',
        'shimmer':       'shimmer 1.5s ease-in-out infinite',
        'pulse-brand':   'pulseBrand 2s ease-in-out infinite',
        'scale-in':      'scaleIn 300ms ease-out',
        'progress-fill': 'progressFill 600ms ease-out forwards',
        'checkmark':     'checkmarkDraw 400ms ease-out forwards',
        'slide-in-left': 'slideInLeft 200ms ease-out',
        'bounce-in':     'bounceIn 500ms ease-out',
        'shake':         'shake 400ms ease-out',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        fadeInUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          from: { transform: 'translateX(100%)' },
          to:   { transform: 'translateX(0)' },
        },
        slideInUp: {
          from: { transform: 'translateY(100%)' },
          to:   { transform: 'translateY(0)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        pulseBrand: {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.6' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.8)' },
          to:   { opacity: '1', transform: 'scale(1)' },
        },
        progressFill: {
          from: { width: '0%' },
          to:   { width: 'var(--progress-width)' },
        },
        checkmarkDraw: {
          from: { 'stroke-dashoffset': '24' },
          to:   { 'stroke-dashoffset': '0' },
        },
        slideInLeft: {
          from: { opacity: '0', transform: 'translateX(-12px)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
        bounceIn: {
          '0%':   { opacity: '0', transform: 'scale(0.3)' },
          '50%':  { transform: 'scale(1.05)' },
          '70%':  { transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%':      { transform: 'translateX(-4px)' },
          '40%':      { transform: 'translateX(4px)' },
          '60%':      { transform: 'translateX(-2px)' },
          '80%':      { transform: 'translateX(2px)' },
        },
      },
    },
  },
  plugins: [],
}

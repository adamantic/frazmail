/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        surface: 'var(--surface)',
        'surface-hover': 'var(--surface-hover)',
        'border-theme': 'var(--border)',
        'border-hover': 'var(--border-hover)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        accent: 'var(--accent)',
        'accent-dim': 'var(--accent-dim)',
        'accent-glow': 'var(--accent-glow)',
        'input-bg': 'var(--input-bg)',
        'input-border': 'var(--input-border)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
      },
      borderRadius: {
        card: '14px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.12), 0 0 0 1px var(--border)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.15), 0 0 0 1px var(--border-hover)',
        glow: '0 0 20px var(--accent-glow)',
        'focus-ring': '0 0 0 2px var(--accent-glow), 0 0 0 4px var(--accent)',
      },
    },
  },
  plugins: [],
}

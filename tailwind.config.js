/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#2563eb',
        'primary-hover': '#1d4ed8',
        secondary: '#6b7280',
        'secondary-hover': '#374151',
      },
      borderRadius: {
        container: '0.5rem',
      },
      gap: {
        'form-field': '1rem',
      },
    },
  },
  plugins: [],
}

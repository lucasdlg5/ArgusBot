import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    extend: {
      colors: {
        argus: {
          bg: '#090d16',
          card: '#0f172a',
          border: '#1e293b',
          emerald: '#10b981',
          amber: '#f59e0b',
          rose: '#f43f5e'
        }
      }
    }
  },
  plugins: []
};

export default config;

import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "rgb(0, 126, 128)",
          50: "#e6f2f2",
          100: "#cce5e6",
          200: "#99cbcd",
          300: "#66b1b3",
          400: "#339798",
          500: "rgb(0, 126, 128)",
          600: "#006566",
          700: "#004c4d",
          800: "#003233",
          900: "#00191a",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;

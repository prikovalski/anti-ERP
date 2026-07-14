import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#161616",
        paper: "#f7f5ef",
        line: "#d8d3c7",
        signal: "#0f766e",
        coral: "#bf4b3f",
        steel: "#335c67"
      },
      boxShadow: {
        panel: "0 20px 60px rgba(22, 22, 22, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;

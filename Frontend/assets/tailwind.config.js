/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // keep your old blue if you still use it anywhere
        // baseBlue: {
        //   500: "#0052FF",
        //   600: "#0040d1",
        //   700: "#002c8f",
        // },

        // new grim gold palette to match the fighting psychos art
        grimGold: {
          400: "#f5b749", // bright highlight
          500: "#e28c2c", // primary CTA color
          900: "#2b1707", // super dark brown
        },
      },

      boxShadow: {
        "glow-base": "0 0 25px rgba(0, 82, 255, 0.35)",
        "glow-gold": "0 0 35px rgba(245, 183, 73, 0.35)",
      },

      // optional: Tailwind utility background for the overlay
      backgroundImage: {
        "vk-overlay":
          "radial-gradient(circle at 15% 0%, rgba(245,183,73,0.55), transparent 55%)," +
          "radial-gradient(circle at 80% 10%, rgba(155,92,29,0.4), transparent 60%)," +
          "radial-gradient(circle at 50% 100%, rgba(15,23,42,0.98), transparent 70%)",
      },
    },
  },
  plugins: [],
};

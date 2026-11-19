/** The only brand file: a fork that ships its own build changes these values and the icons. */
export const brand = {
  productName: "Capybara",
  appId: "com.capybarahq.desktop",
  scheme: "capybara",
  icons: "build/icons",
  updateFeed: { provider: "github", owner: "capybara-hq", repo: "clients" },
} as const;

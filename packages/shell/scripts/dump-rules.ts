// Prints signInBlockRules for a few bases as JSON, the input of compile-rules.swift.
import { signInBlockRules } from "../src/sign-in-guard.ts";

const bases = [
  "https://capybara.example.com",
  "https://capybara.example.com/cap",
  "https://capybara.example.com:8443/team/x",
  "https://x.example.com/团队",
  "https://x.example.com/my app",
  "https://x.example.com/my-app_1.0~b",
];
console.log(JSON.stringify(Object.fromEntries(bases.map((b) => [b, signInBlockRules(b)]))));

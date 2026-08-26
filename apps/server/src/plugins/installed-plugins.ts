// GENERATED FILE — do not edit by hand.
// Rewrite with: npm run plugins:generate
//
// The optional-plugin import map. Every entry is a direct dependency of
// apps/server whose package.json declares `"gl3": { "plugin": true }`.
// `PLUGIN_IDS` selects which of these actually load. The framework plugins
// are never listed here (every profile loads them via bundledPlugins); the
// gameplay plugins are listed AND auto-loaded by the full profile.

import type { PluginManifest } from "@gl3/plugin-sdk";
import plugin_gl3_hello_plugin from "@gl3/hello-plugin";
import plugin_gl3_plugin_blackjack from "@gl3/plugin-blackjack";
import plugin_gl3_plugin_bounties from "@gl3/plugin-bounties";
import plugin_gl3_plugin_bullets from "@gl3/plugin-bullets";
import plugin_gl3_plugin_casino from "@gl3/plugin-casino";
import plugin_gl3_plugin_combat from "@gl3/plugin-combat";
import plugin_gl3_plugin_crimes from "@gl3/plugin-crimes";
import plugin_gl3_plugin_detectives from "@gl3/plugin-detectives";
import plugin_gl3_plugin_gangs from "@gl3/plugin-gangs";
import plugin_gl3_plugin_gym from "@gl3/plugin-gym";
import plugin_gl3_plugin_houses from "@gl3/plugin-houses";
import plugin_gl3_plugin_mccodes_attributes from "@gl3/plugin-mccodes-attributes";
import plugin_gl3_plugin_oc from "@gl3/plugin-oc";
import plugin_gl3_plugin_properties from "@gl3/plugin-properties";
import plugin_gl3_plugin_theft from "@gl3/plugin-theft";
import plugin_gl3_plugin_travel from "@gl3/plugin-travel";

export const INSTALLED_PLUGINS: readonly (readonly [string, PluginManifest])[] = [
  ["@gl3/hello-plugin", plugin_gl3_hello_plugin],
  ["@gl3/plugin-blackjack", plugin_gl3_plugin_blackjack],
  ["@gl3/plugin-bounties", plugin_gl3_plugin_bounties],
  ["@gl3/plugin-bullets", plugin_gl3_plugin_bullets],
  ["@gl3/plugin-casino", plugin_gl3_plugin_casino],
  ["@gl3/plugin-combat", plugin_gl3_plugin_combat],
  ["@gl3/plugin-crimes", plugin_gl3_plugin_crimes],
  ["@gl3/plugin-detectives", plugin_gl3_plugin_detectives],
  ["@gl3/plugin-gangs", plugin_gl3_plugin_gangs],
  ["@gl3/plugin-gym", plugin_gl3_plugin_gym],
  ["@gl3/plugin-houses", plugin_gl3_plugin_houses],
  ["@gl3/plugin-mccodes-attributes", plugin_gl3_plugin_mccodes_attributes],
  ["@gl3/plugin-oc", plugin_gl3_plugin_oc],
  ["@gl3/plugin-properties", plugin_gl3_plugin_properties],
  ["@gl3/plugin-theft", plugin_gl3_plugin_theft],
  ["@gl3/plugin-travel", plugin_gl3_plugin_travel],
];

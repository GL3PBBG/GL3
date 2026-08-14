// GENERATED FILE — do not edit by hand.
// Rewrite with: npm run plugins:generate
//
// The optional-plugin import map. Every entry is a direct dependency of
// apps/server whose package.json declares `"gl3": { "plugin": true }`.
// `PLUGIN_IDS` selects which of these actually load; ported core modules are
// never listed here (they load unconditionally via CORE_PLUGINS).

import type { PluginManifest } from "@gl3/plugin-sdk";
import plugin_gl3_hello_plugin from "@gl3/hello-plugin";

export const INSTALLED_PLUGINS: readonly (readonly [string, PluginManifest])[] = [
  ["@gl3/hello-plugin", plugin_gl3_hello_plugin],
];

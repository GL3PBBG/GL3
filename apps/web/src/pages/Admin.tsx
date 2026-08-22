import { useState } from "react";
import { useAdminSections } from "../api/queries.js";
import { ErrorText, Loading, Panel } from "../components/ui.js";
import { PAGE_OVERRIDES } from "../plugins/overrides.js";
import { PageRenderer } from "../plugins/PageRenderer.js";
import { renderNode } from "../plugins/render.js";
import styles from "./pages.module.css";

/**
 * Renders the admin sections the server exposes for the caller's grants, one
 * tab per section (same pattern as Leaderboards). Only the active section
 * mounts, so a page's tables and selects fetch when its tab opens, not all at
 * once. Each page within a section is rendered through the same `renderNode`
 * + `PageRenderer` path that `PluginPage` uses — unless the page id has an
 * entry in PAGE_OVERRIDES, in which case that bespoke component renders
 * instead (PluginPage's own check, applied here so core admin pages can use
 * it too; the economy dashboard is the first).
 */
export function Admin(): JSX.Element {
  const sections = useAdminSections();
  // The section's pluginId, not an index: a grant change between refetches
  // reorders the list without silently switching the admin to another tab.
  const [active, setActive] = useState<string | null>(null);

  if (sections.isLoading) return <Loading />;
  if (sections.isError) return <ErrorText error={sections.error} />;

  const data = sections.data;
  if (data === undefined || data.sections.length === 0) {
    return <Panel title="Admin"><p>No admin sections available.</p></Panel>;
  }

  const current =
    data.sections.find((section) => section.pluginId === active) ?? data.sections[0];
  if (current === undefined) return <Panel title="Admin"><p>No admin sections available.</p></Panel>;

  return (
    <div className={styles.stack}>
      <div className={styles.tabs}>
        {data.sections.map((section) => (
          <button
            key={section.pluginId}
            type="button"
            aria-pressed={section.pluginId === current.pluginId}
            className={section.pluginId === current.pluginId ? styles.tabActive : styles.tabIdle}
            onClick={() => { setActive(section.pluginId); }}
          >
            {section.pluginId}
          </button>
        ))}
      </div>
      <div className={styles.stack}>
        {current.pages.map((page) => {
          const Override = PAGE_OVERRIDES.get(page.id);
          if (Override !== undefined) return <Override key={`${current.pluginId}:${page.id}`} />;
          const instructions = renderNode(page.view, {});
          return (
            <PageRenderer
              key={`${current.pluginId}:${page.id}`}
              instructions={instructions}
            />
          );
        })}
      </div>
    </div>
  );
}

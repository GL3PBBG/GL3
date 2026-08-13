import { useAdminSections } from "../api/queries.js";
import { ErrorText, Loading, Panel } from "../components/ui.js";
import { PageRenderer } from "../plugins/PageRenderer.js";
import { renderNode } from "../plugins/render.js";
import styles from "./pages.module.css";

/**
 * Renders all admin sections the server exposes for the caller's grants.
 * Each section is a panel; each page within a section is rendered through
 * the same `renderNode` + `PageRenderer` path that `PluginPage` uses.
 */
export function Admin(): JSX.Element {
  const sections = useAdminSections();

  if (sections.isLoading) return <Loading />;
  if (sections.isError) return <ErrorText error={sections.error} />;

  const data = sections.data;
  if (data === undefined || data.sections.length === 0) {
    return <Panel title="Admin"><p>No admin sections available.</p></Panel>;
  }

  return (
    <div className={styles.stack}>
      {data.sections.map((section) => (
        <Panel key={section.pluginId} title={section.pluginId}>
          <div className={styles.stack}>
            {section.pages.map((page) => {
              const instructions = renderNode(page.view, {});
              return (
                <PageRenderer
                  key={`${section.pluginId}:${page.id}`}
                  instructions={instructions}
                />
              );
            })}
          </div>
        </Panel>
      ))}
    </div>
  );
}

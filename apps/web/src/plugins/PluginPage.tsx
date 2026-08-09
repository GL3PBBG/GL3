import { useParams } from "react-router-dom";
import { usePlugins } from "../api/queries.js";
import { ErrorText, Loading, Panel } from "../components/ui.js";
import { PageRenderer } from "./PageRenderer.js";
import { PAGE_OVERRIDES } from "./overrides.js";
import { renderNode } from "./render.js";

/**
 * The route element for any plugin page. Looks up the page by id in the
 * /api/plugins payload, prefers a hand-written override, else renders the view
 * schema generically.
 *
 * Returns `null` only in the unreachable case where the query failed with no
 * error attached — `ErrorText` renders nothing for a null error, and the same
 * signature is what `ErrorText` and `Avatar` already carry.
 */
export function PluginPage(): JSX.Element | null {
  const { pageId } = useParams();
  const plugins = usePlugins();

  if (plugins.isLoading) return <Loading />;
  if (plugins.isError) return <ErrorText error={plugins.error} />;

  const page = plugins.data?.pages.find((p) => p.id === pageId);
  if (page === undefined) {
    return <Panel title="Not found"><p>This plugin page does not exist.</p></Panel>;
  }

  const Override = PAGE_OVERRIDES.get(page.id);
  if (Override !== undefined) return <Override />;

  // `renderNode` never throws — an unrecognised node returns `[]` — so an empty
  // list, not a caught exception, is what "this view rendered to nothing" looks
  // like.
  const instructions = renderNode(page.view, {});
  if (instructions.length === 0) {
    return <Panel title={page.id}><p>This plugin has no UI installed.</p></Panel>;
  }

  // Keyed by page id: without it, React reuses the PageRenderer instance
  // across a /plugins/a -> /plugins/b navigation, so formValues and the
  // error banner from page A survive onto page B.
  return <PageRenderer key={page.id} instructions={instructions} />;
}

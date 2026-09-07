import { Link } from "react-router-dom";
import type { LegalDoc } from "@gl3/shared";
import { tokenStore, useLegalDoc, useMe } from "@gl3/client";
import { Markdown } from "../components/Markdown.js";
import { BrandMark } from "../components/BrandMark.js";
import { ErrorText, Loading, Panel } from "../components/ui.js";
import styles from "./Login.module.css";

/** Public: rendered outside Shell so the register page can link here before any session exists. */
export function Legal({ doc }: { doc: LegalDoc }): JSX.Element {
  const legal = useLegalDoc(doc);
  // App.tsx already observes the same ["me"] query. A logged-out visitor's
  // token store is empty, so `me` there sits errored (401, retry: false); a
  // second observer mounting on an errored query refetches on mount, which
  // re-renders App, which re-subscribes and refetches — an unbounded loop.
  // Only fetch here when a session might actually exist.
  const me = useMe({ enabled: tokenStore.get() !== null });
  const isAdmin = me.data?.grants.some((g) => g === "*" || g === "legal") === true;
  if (legal.isLoading) return <Loading what="the document" />;
  if (!legal.data) return <Panel title="Legal"><ErrorText error={legal.error} /></Panel>;
  return (
    <div className={styles.landing}>
      <BrandMark variant="login" className={styles.brand} />
      <Panel title={legal.data.title}>
        {isAdmin && legal.data.missing.length > 0 ? (
          <p role="alert">Unset legal details: {legal.data.missing.join(", ")} — fill them in under Admin › Terms &amp; privacy.</p>
        ) : null}
        <Markdown text={legal.data.markdown} />
      </Panel>
      <p className={styles.legalLinks}>
        <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link> · <Link to="/">Back to the game</Link>
      </p>
    </div>
  );
}

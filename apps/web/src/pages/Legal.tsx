import { Link } from "react-router-dom";
import type { LegalDoc } from "@gl3/shared";
import { useLegalDoc, useMe } from "@gl3/client";
import { Markdown } from "../components/Markdown.js";
import { BrandMark } from "../components/BrandMark.js";
import { ErrorText, Loading, Panel } from "../components/ui.js";
import styles from "./Login.module.css";

/** Public: rendered outside Shell so the register page can link here before any session exists. */
export function Legal({ doc }: { doc: LegalDoc }): JSX.Element {
  const legal = useLegalDoc(doc);
  const me = useMe();
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

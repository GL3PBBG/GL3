import { Link } from "react-router-dom";
import { Panel } from "../components/ui.js";

export function NotFound(): JSX.Element {
  return (
    <Panel title="Nothing here">
      <p style={{ margin: 0 }}>
        That page doesn't exist. <Link to="/">Back to the dashboard</Link>.
      </p>
    </Panel>
  );
}

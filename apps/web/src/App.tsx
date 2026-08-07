import { useMe } from "./api/queries.js";
import { Crimes } from "./pages/Crimes.js";
import { Login } from "./pages/Login.js";
import { useGameEvents } from "./ws/useGameEvents.js";

export function App(): JSX.Element {
  const me = useMe();
  // Keyed on playerId (not just "are we logged in") so the effect tears down
  // and reconnects — fetching a fresh ticket — the moment login/logout
  // changes who we are, rather than only ever connecting once at mount.
  useGameEvents(me.data?.playerId);
  return me.isSuccess ? <Crimes /> : <Login />;
}

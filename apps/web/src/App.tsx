import { BrowserRouter, Route, Routes } from "react-router-dom";
import { useMe } from "./api/queries.js";
import { Shell } from "./components/Shell.js";
import { Loading } from "./components/ui.js";
import { Bank } from "./pages/Bank.js";
import { Bullets } from "./pages/Bullets.js";
import { Crimes } from "./pages/Crimes.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Jail } from "./pages/Jail.js";
import { Leaderboards } from "./pages/Leaderboards.js";
import { Login } from "./pages/Login.js";
import { NotFound } from "./pages/NotFound.js";
import { Ranks } from "./pages/Ranks.js";
import { Travel } from "./pages/Travel.js";
import { useGameEvents } from "./ws/useGameEvents.js";

export function App(): JSX.Element {
  const me = useMe();
  // Keyed on playerId (not just "are we logged in") so the effect tears down
  // and reconnects — fetching a fresh ticket — the moment login/logout
  // changes who we are, rather than only ever connecting once at mount.
  // It lives above the router so navigation never drops the socket.
  useGameEvents(me.data?.playerId);

  if (me.isLoading) return <Loading />;
  if (!me.isSuccess) return <Login />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Dashboard />} />
          <Route path="crimes" element={<Crimes />} />
          <Route path="jail" element={<Jail />} />
          <Route path="bank" element={<Bank />} />
          <Route path="travel" element={<Travel />} />
          <Route path="bullets" element={<Bullets />} />
          <Route path="ranks" element={<Ranks />} />
          <Route path="leaderboards" element={<Leaderboards />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

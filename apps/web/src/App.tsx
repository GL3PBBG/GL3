import { BrowserRouter, Route, Routes } from "react-router-dom";
import { useMe } from "./api/queries.js";
import { Shell } from "./components/Shell.js";
import { Loading } from "./components/ui.js";
import { Bank } from "./pages/Bank.js";
import { Bullets } from "./pages/Bullets.js";
import { Crimes } from "./pages/Crimes.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Gang } from "./pages/Gang.js";
import { Inventory } from "./pages/Inventory.js";
import { Jail } from "./pages/Jail.js";
import { Leaderboards } from "./pages/Leaderboards.js";
import { Login } from "./pages/Login.js";
import { Mail } from "./pages/Mail.js";
import { MailThread } from "./pages/MailThread.js";
import { News } from "./pages/News.js";
import { NotFound } from "./pages/NotFound.js";
import { Notifications } from "./pages/Notifications.js";
import { PlayerProfile } from "./pages/PlayerProfile.js";
import { Profile } from "./pages/Profile.js";
import { Ranks } from "./pages/Ranks.js";
import { Travel } from "./pages/Travel.js";
import { PluginPage } from "./plugins/PluginPage.js";
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
          <Route path="inventory" element={<Inventory />} />
          <Route path="ranks" element={<Ranks />} />
          <Route path="leaderboards" element={<Leaderboards />} />
          <Route path="gang" element={<Gang />} />
          <Route path="mail" element={<Mail />} />
          <Route path="mail/:threadId" element={<MailThread />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="news" element={<News />} />
          <Route path="profile" element={<Profile />} />
          <Route path="players/:playerId" element={<PlayerProfile />} />
          {/*
            Every plugin page lives under one namespaced route rather than at the
            `path` it declares. The loader validates a plugin's basePath against
            the server's own prefixes, but nothing validates a page's *frontend*
            path against these core routes — so a top-level registration could
            let a plugin shadow /bank. The declared `path` stays advisory in v1;
            top-level registration waits on a collision check.
          */}
          <Route path="plugins/:pageId" element={<PluginPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

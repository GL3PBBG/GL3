import { BrowserRouter, Route, Routes } from "react-router-dom";
import { useMe } from "./api/queries.js";
import { Shell } from "./components/Shell.js";
import { Loading } from "./components/ui.js";
import { Admin } from "./pages/Admin.js";
import { Bank } from "./pages/Bank.js";
import { Bounties } from "./pages/Bounties.js";
import { Detectives } from "./pages/Detectives.js";
import { Forgot } from "./pages/Forgot.js";
import { Forum } from "./pages/Forum.js";
import { ForumTopic } from "./pages/ForumTopic.js";
import { Bullets } from "./pages/Bullets.js";
import { Casino } from "./pages/Casino.js";
import { Combat } from "./pages/Combat.js";
import { Crimes } from "./pages/Crimes.js";
import { Shop } from "./pages/Shop.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Gang } from "./pages/Gang.js";
import { Hospital } from "./pages/Hospital.js";
import { Inventory } from "./pages/Inventory.js";
import { Jail } from "./pages/Jail.js";
import { Leaderboards } from "./pages/Leaderboards.js";
import { Login } from "./pages/Login.js";
import { Mail } from "./pages/Mail.js";
import { MailThread } from "./pages/MailThread.js";
import { News } from "./pages/News.js";
import { NotFound } from "./pages/NotFound.js";
import { Notifications } from "./pages/Notifications.js";
import { Players } from "./pages/Players.js";
import { OrganizedCrime } from "./pages/OrganizedCrime.js";
import { PlayerProfile } from "./pages/PlayerProfile.js";
import { Profile } from "./pages/Profile.js";
import { Ranks } from "./pages/Ranks.js";
import { Reset } from "./pages/Reset.js";
import { Rounds } from "./pages/Rounds.js";
import { Stats } from "./pages/Stats.js";
import { Travel } from "./pages/Travel.js";
import { Verify } from "./pages/Verify.js";
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

  return (
    <BrowserRouter>
      <Routes>
        {/*
          Hoisted above the me.isSuccess branch, not inside either side of it:
          a password-reset link is followed from an email client, and the
          browser it opens in may well still hold a perfectly valid session
          from before the player forgot their password — GET /api/auth/me
          succeeds for ANY valid session regardless of verification state, so
          "logged in" is not "mid-reset-flow". These two must be reachable no
          matter which branch below is live, or a logged-in visitor's /reset
          link falls through Shell's own catch-all to NotFound.
        */}
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset" element={<Reset />} />
        {me.isSuccess ? (
          <>
            {/*
              A sibling of the Shell group, not nested in it: `GET /api/auth/me`
              is gate-exempt, so an unverified player is still `me.isSuccess`
              here and lands in this branch — this is the one page they can
              reach without the gameplay layout (nav, HUD, event feed) around
              it. Every other authed route 403s `email_unverified`, which the
              api client (api/client.ts) catches and bounces here with a full
              reload.
            */}
            <Route path="/verify" element={<Verify />} />
            <Route element={<Shell />}>
              <Route index element={<Dashboard />} />
              <Route path="crimes" element={<Crimes />} />
              <Route path="jail" element={<Jail />} />
              <Route path="hospital" element={<Hospital />} />
              <Route path="bank" element={<Bank />} />
              <Route path="travel" element={<Travel />} />
              <Route path="bullets" element={<Bullets />} />
              <Route path="shop" element={<Shop />} />
              <Route path="inventory" element={<Inventory />} />
              <Route path="combat" element={<Combat />} />
              <Route path="bounties" element={<Bounties />} />
              <Route path="detectives" element={<Detectives />} />
              <Route path="casino" element={<Casino />} />
              <Route path="oc" element={<OrganizedCrime />} />
              <Route path="ranks" element={<Ranks />} />
              <Route path="leaderboards" element={<Leaderboards />} />
              <Route path="rounds" element={<Rounds />} />
              <Route path="stats" element={<Stats />} />
              <Route path="gang" element={<Gang />} />
              <Route path="mail" element={<Mail />} />
              <Route path="mail/:threadId" element={<MailThread />} />
              <Route path="forum" element={<Forum />} />
              <Route path="forum/:forumId" element={<Forum />} />
              <Route path="forum/topics/:topicId" element={<ForumTopic />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="news" element={<News />} />
              <Route path="players" element={<Players />} />
              {/* The page's old address. Kept as an alias so links already in
                  mail, forum posts and bookmarks keep resolving. */}
              <Route path="online" element={<Players />} />
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
              <Route path="admin" element={<Admin />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </>
        ) : (
          <>
            {/*
              No token (or an expired/invalid one — /me answered 401). Login is
              both the explicit path and the catch-all, so any other URL a
              logged-out visitor lands on still shows something useful rather
              than a blank router miss. /forgot and /reset are declared above,
              not here — this branch no longer needs them.
            */}
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<Login />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}

import { useParams } from "react-router-dom";
import { useProfile } from "@gl3/client";
import { ProfileCard } from "../components/ProfileCard.js";
import { ErrorText, Loading, Panel } from "../components/ui.js";

/**
 * Another player's profile. `GET /api/players/:playerId/profile` is public —
 * no auth header needed — but this route lives inside the Shell like every
 * other page, so it is only reachable once logged in anyway.
 */
export function PlayerProfile(): JSX.Element {
  const { playerId } = useParams();
  // A missing param cannot happen from the router's own matching, but the
  // types say `string | undefined` and a URL is external input either way.
  if (playerId === undefined) return <Panel title="Profile">No player named.</Panel>;
  return <PlayerProfileFor playerId={playerId} />;
}

function PlayerProfileFor({ playerId }: { playerId: string }): JSX.Element {
  const profile = useProfile(playerId);

  if (profile.isLoading) return <Loading what="the profile" />;
  if (!profile.data) {
    return <Panel title="Profile"><ErrorText error={profile.error} /></Panel>;
  }
  return <ProfileCard profile={profile.data} />;
}

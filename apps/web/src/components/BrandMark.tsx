import { useSyncExternalStore } from "react";
import { getBranding, subscribeBranding } from "../lib/applyTheme.js";
import styles from "./BrandMark.module.css";

/**
 * The game's identity mark — every "GL3" that used to be hardcoded. Always an
 * <h1> for the page's heading structure; a bound logo replaces the visible
 * text and the game name survives as the image's alt. The two variants read
 * their own slot only, because a full-size login graphic squeezed into the
 * header (or the reverse) serves neither spot.
 */
export function useBranding(): ReturnType<typeof getBranding> {
  return useSyncExternalStore(subscribeBranding, getBranding);
}

export function BrandMark({ variant, className }: {
  variant: "login" | "header";
  className?: string | undefined;
}): JSX.Element {
  const branding = useBranding();
  const logo = variant === "login" ? branding.logoLogin : branding.logoHeader;

  if (logo === null) {
    return <h1 className={className}>{branding.gameName}</h1>;
  }
  return (
    <h1 className={className}>
      <img
        className={variant === "login" ? styles.logoLogin : styles.logoHeader}
        src={logo}
        alt={branding.gameName}
      />
    </h1>
  );
}

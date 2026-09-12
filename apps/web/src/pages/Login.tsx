import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth, useMe } from "@gl3/client";
import { ErrorText } from "../components/ui.js";
import { BrandMark } from "../components/BrandMark.js";
import styles from "./Login.module.css";

export function Login(): JSX.Element {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const auth = useAuth(mode);
  // Observe the current session directly: router navigation can render this
  // page before App receives the query notification for logout/deletion.
  const me = useMe({ enabled: false });
  // Set by Reset.tsx's navigate("/login", { state }) after a successful
  // password change — a one-shot note, not persisted anywhere.
  const location = useLocation();
  const passwordChanged = (location.state as { passwordChanged?: boolean } | null)?.passwordChanged === true;
  // Set by Profile.tsx's DangerZone after a successful account deletion.
  const accountDeleted = (location.state as { accountDeleted?: boolean } | null)?.accountDeleted === true;

  if (me.isSuccess) return <Navigate to="/" replace />;

  return (
    <div className={styles.landing}>
      {/* The landing hero: this page is the game's front door, so the brand
          stands above the form at full size rather than inside it. The other
          auth pages (Verify/Forgot/Reset) keep the compact in-form mark. */}
      <BrandMark variant="login" className={styles.landingBrand} />
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        auth.mutate(mode === "register" ? { username, password, email, acceptTerms } : { username, password });
      }}
    >
      {passwordChanged ? <p role="status">Password changed — log in below.</p> : null}
      {accountDeleted ? <p role="status">Your account has been deleted.</p> : null}
      {/* aria-label, not a visible <label>: the placeholder is the visual
          design, but a placeholder alone names the field for nobody once it
          has content. */}
      {/* Register mode mirrors RegisterRequestSchema so the browser names
          the rule before a round trip; login mode stays unconstrained so a
          legacy V2 username outside the pattern can still sign in. */}
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Username"
        aria-label="Username"
        autoComplete="username"
        required
        {...(mode === "register"
          ? { minLength: 3, maxLength: 30, pattern: "[A-Za-z0-9_\\-]+", title: "3–30 characters: letters, digits, _ and - only" }
          : {})}
      />
      {mode === "register" ? (
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          placeholder="Email"
          aria-label="Email"
          autoComplete="email"
          required
        />
      ) : null}
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="Password"
        aria-label="Password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        required
        {...(mode === "register" ? { minLength: 8, maxLength: 200, title: "At least 8 characters" } : {})}
      />
      {mode === "register" ? (
        <label className={styles.terms}>
          <input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} />
          <span>I accept the <Link to="/terms">Terms of Service</Link> and <Link to="/privacy">Privacy Policy</Link></span>
        </label>
      ) : null}
      <button type="submit" disabled={auth.isPending || (mode === "register" && !acceptTerms)}>{mode === "login" ? "Log in" : "Register"}</button>
      <button type="button" className={styles.toggle} onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "Need an account?" : "Have an account?"}
      </button>
      {mode === "login" ? <Link to="/forgot">Forgot password?</Link> : null}
      {/* describeError turns "401 invalid_credentials" into a sentence. */}
      <ErrorText error={auth.error} />
    </form>
      <p className={styles.legalLinks}><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link></p>
    </div>
  );
}

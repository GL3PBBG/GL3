import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../api/queries.js";
import { ErrorText } from "../components/ui.js";
import { BrandMark } from "../components/BrandMark.js";
import styles from "./Login.module.css";

export function Login(): JSX.Element {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const auth = useAuth(mode);
  // Set by Reset.tsx's navigate("/login", { state }) after a successful
  // password change — a one-shot note, not persisted anywhere.
  const location = useLocation();
  const passwordChanged = (location.state as { passwordChanged?: boolean } | null)?.passwordChanged === true;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        auth.mutate(mode === "register" ? { username, password, email } : { username, password });
      }}
    >
      <BrandMark variant="login" className={styles.brand} />
      {passwordChanged ? <p role="status">Password changed — log in below.</p> : null}
      {/* aria-label, not a visible <label>: the placeholder is the visual
          design, but a placeholder alone names the field for nobody once it
          has content. */}
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" aria-label="Username" autoComplete="username" />
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
      />
      <button type="submit" disabled={auth.isPending}>{mode === "login" ? "Log in" : "Register"}</button>
      <button type="button" className={styles.toggle} onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "Need an account?" : "Have an account?"}
      </button>
      {mode === "login" ? <Link to="/forgot">Forgot password?</Link> : null}
      {/* describeError turns "401 invalid_credentials" into a sentence. */}
      <ErrorText error={auth.error} />
    </form>
  );
}

import { useState } from "react";
import { useAuth } from "../api/queries.js";
import { ErrorText } from "../components/ui.js";
import styles from "./Login.module.css";

export function Login(): JSX.Element {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const auth = useAuth(mode);

  return (
    <form
      className={styles.form}
      onSubmit={(event) => { event.preventDefault(); auth.mutate({ username, password }); }}
    >
      <h1 className={styles.brand}>GL3</h1>
      {/* aria-label, not a visible <label>: the placeholder is the visual
          design, but a placeholder alone names the field for nobody once it
          has content. */}
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" aria-label="Username" autoComplete="username" />
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
      {/* describeError turns "401 invalid_credentials" into a sentence. */}
      <ErrorText error={auth.error} />
    </form>
  );
}

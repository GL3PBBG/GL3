import { useState } from "react";
import { useAuth } from "../api/queries.js";

export function Login(): JSX.Element {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const auth = useAuth(mode);

  return (
    <form
      onSubmit={(event) => { event.preventDefault(); auth.mutate({ username, password }); }}
    >
      <h1>GL3</h1>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="username" />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" autoComplete="current-password" />
      <button type="submit" disabled={auth.isPending}>{mode === "login" ? "Log in" : "Register"}</button>
      <button type="button" onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "Need an account?" : "Have an account?"}
      </button>
      {auth.isError ? <p role="alert">{auth.error.message}</p> : null}
    </form>
  );
}

export type DeleteStep = "idle" | "armed" | "fire";

/** First press arms (button turns red, copy changes), second press fires. Editing the password field resets to idle (the caller does that). */
export function nextDeleteStep(step: DeleteStep): DeleteStep {
  return step === "idle" ? "armed" : "fire";
}

export function canDelete(password: string, step: DeleteStep): boolean {
  return password.length > 0 && step !== "fire";
}

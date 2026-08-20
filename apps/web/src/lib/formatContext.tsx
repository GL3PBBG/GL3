import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_MONEY_FORMAT, type MoneyFormat } from "@gl3/shared";
import { usePlugins } from "../api/queries.js";

/**
 * The active `MoneyFormat`, sourced from `GET /api/plugins`' `moneyFormat`
 * field (see `core.moneyFormat`, docs/STATUS.md). Defaults to
 * `DEFAULT_MONEY_FORMAT` so anything rendering before the plugins query
 * resolves — or a test that never mounts `FormatProvider` at all — still gets
 * today's `$`/comma behaviour rather than an undefined context crash.
 */
const FormatContext = createContext<MoneyFormat>(DEFAULT_MONEY_FORMAT);

/** Mounted once, around the authenticated shell — see components/Shell.tsx. */
export function FormatProvider({ children }: { children: ReactNode }): JSX.Element {
  const plugins = usePlugins();
  const format = plugins.data?.moneyFormat ?? DEFAULT_MONEY_FORMAT;
  return <FormatContext.Provider value={format}>{children}</FormatContext.Provider>;
}

export function useMoneyFormat(): MoneyFormat {
  return useContext(FormatContext);
}

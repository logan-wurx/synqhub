// Whether the website is using SYNQ Helper right now, for components shared with the desktop app. In the
// desktop build `__ONBOARD_WEB__` is false and this is always false (the helper link is web-only).
import { useSyncExternalStore } from "react";
import { helperReady, onHelperChange } from "./helper.ts";

const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;
const never = () => () => {};
const no = () => false;

export function useHelperReady(): boolean {
  return useSyncExternalStore(WEB ? onHelperChange : never, WEB ? helperReady : no);
}

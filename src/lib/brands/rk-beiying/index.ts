// Royal Kludge "BeiYing" (SinoWealth 0x258A) boards over the legacy RK software channel: public API.
// Protocol: protocol.ts (codec), guard.ts (allowlist), devices.ts (models and ids), session.ts (the write-only session
// and its shadow), kb-driver.ts (the generic Keyboard panel driver). Sources and licences in each file's header.

export * from "./protocol.ts";
export { BLOCKED, RK_BEIYING_GUARD, classifyData, guardFor, type GuardContext } from "./guard.ts";
export { RK_CHANNEL, RK_IDS, RK_KEY_SLOTS, RK_MODELS, RK_VID, STANDARD_MODES, defaultCodes, layoutOf, modeName, modesOf, offeredModes, rkModel, type RkMode, type RkModel } from "./devices.ts";
export { RkSession, SWAP_RED_GREEN, browserShadowStore, memoryShadowStore, type RkPlan, type RkSessionOptions, type RkShadow, type ShadowStore } from "./session.ts";

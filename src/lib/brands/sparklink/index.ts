// The SparkLink ("PlayJoy") keyboard family (Royal Kludge C / M75 HE / X87, AULA HE boards, Kochi Hummingbird 68): public API.
// Protocol: protocol.ts (codec), guard.ts (allowlist), devices.ts (models and ids), session.ts (connect / read / write
// with re-read), kb-driver.ts (the generic Keyboard panel driver). Sources and licences in each file's header.

export * from "./protocol.ts";
export { BLOCKED, SPARKLINK_GUARD, classifyFrame, guardFor, type GuardContext } from "./guard.ts";
export { KOCHI_HB68, SPARKLINK_CHANNEL, SPARKLINK_IDS, SPARKLINK_MODELS, SPARKLINK_VIDS, isKochi, sparklinkModel, type SparkLinkBrand, type SparkLinkModel } from "./devices.ts";
export { NoAnswerError, RefusedError, SparkLinkSession, TIMING, tierAllowsWrites, type AnalogPatch, type GlobalRead, type KeyRead, type SparkKey, type SparkLinkPlan, type SparkLinkSessionOptions, type SparkLinkState } from "./session.ts";

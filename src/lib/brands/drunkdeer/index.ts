// DrunkDeer (G65 / A75 family / G60 / G75 / X60) protocol layer: public API.
// devices.ts  USB ids, type codes -> models, dialects, units, lighting tables, bridge allowances
// protocol.ts frame builder, encoders, decoders (pure)
// guard.ts    default-deny allowlist (static for the bridge, narrowed per session)
// session.ts  connect / read / plan-based writes over a GuardedChannel
export * from "./devices.ts";
export * from "./protocol.ts";
export { BLOCKED, DRUNKDEER_GUARD, classifyFrame, guardFor, type GuardContext } from "./guard.ts";
export { DrunkDeerSession, TIMING, type DrunkDeerPlan, type DrunkDeerSessionOptions, type DrunkDeerState, type KeyPointOptions, type LightingState } from "./session.ts";

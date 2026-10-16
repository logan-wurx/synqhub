// MonsGeek / Akko (RongYuan RY5088 + YiChip YC3121) magnetic keyboards: public API.
// Protocol: protocol.ts (codec), guard.ts (allowlist + bridge allowances), devices.ts (models),
// session.ts (connect / read / write with read-back). Sources and licences in each file's header.

export * from "./protocol.ts";
export { MONSGEEK_BRIDGE, MONSGEEK_GUARD, classifyFrame, createGuard, type GuardScope } from "./guard.ts";
export {
  DEFAULT_TRAVEL,
  L378,
  L478,
  L487,
  LYC,
  MONSGEEK_CHANNEL,
  MONSGEEK_DEVICES,
  MONSGEEK_MODELS,
  MONSGEEK_RECEIVERS,
  MONSGEEK_USB,
  VID,
  capsFor,
  keyPositions,
  modelByDevId,
  travelLimits,
  type MonsGeekModel,
  type TravelLimits,
} from "./devices.ts";
export {
  MonsGeekSession,
  OFFICIAL_PACING,
  WriteRefusedError,
  type KeyModeSpec,
  type KeySettings,
  type MonsGeekSessionOptions,
  type MonsGeekState,
  type Pacing,
  type TableValue,
} from "./session.ts";

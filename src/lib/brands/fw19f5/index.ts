// The 0x19F5 firmware family (MCHOSE gen 1, DrunkDeer gen 2, NuPhy V3 / HE, Royal Kludge Gcome): public API.
// Protocol: protocol.ts (codec), guard.ts (allowlist), devices.ts (models and ids), session.ts (connect /
// read / write with re-read), kb-driver.ts (the generic Keyboard panel driver). Sources and licences in
// each file's header.

export * from "./protocol.ts";
export { BLOCKED, FW_GUARDS, classifyFrame, fwGuard, guardFamilyOf, guardFor, type GuardContext, type GuardFamily } from "./guard.ts";
export {
  FAMILY_LABEL,
  FW_CHANNEL,
  FW_IDS,
  FW_MODELS,
  FW_UPGRADERS,
  FW_UPGRADER_ROWS,
  FW_VIDS,
  MC_EFFECT_NAMES,
  fwIdsOf,
  fwModel,
  isAfRange,
  isFwUpgrader,
  layoutOf,
  type FwFamily,
  type FwModel,
  type FwUpgrader,
  type Travel,
} from "./devices.ts";
export { Fw19f5Session, NoAnswerError, TIMING, tierAllowsWrites, unitsOf, type AnalogRead, type Fw19f5Plan, type Fw19f5SessionOptions, type Fw19f5State } from "./session.ts";

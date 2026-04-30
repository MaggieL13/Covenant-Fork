// Duplicate re-exports are a bug: every public DB symbol must have exactly one home.
export { initDb } from './init.js';
export { getDb } from './state.js';
export {
  createThread,
  getThread,
  getTodayThread,
  listThreads,
  getMostRecentActiveThread,
  updateThreadSession,
  clearAllThreadSessions,
  updateThreadActivity,
  archiveThread,
  deleteThread,
  pinThread,
  unpinThread,
  renameThread,
} from './threads.js';
export {
  getNextSequence,
  createMessage,
  getMessage,
  getMessages,
  getLastConversationalMessage,
  getMessageContext,
  editMessage,
  softDeleteMessage,
  markMessageDelivered,
  markMessagesRead,
  searchMessages,
} from './messages.js';
export type { AuditEventRow } from './audit.js';
export { insertAuditEvent, listRecentAuditEntries } from './audit.js';
export type { PendingPairingRecord } from './discord-pairings.js';
export {
  approvePairing,
  cleanExpiredPairings,
  createPairing,
  deletePairingsForUser,
  expirePairingByCode,
  findActivePendingPairingForUser,
  getPendingPairingByCode,
  isDiscordUserApproved,
  listApprovedPairings,
  listPendingPairings,
} from './discord-pairings.js';
export { addReaction, removeReaction } from './reactions.js';
export {
  saveEmbedding,
  getAllEmbeddings,
  getUnembeddedMessages,
  getEmbeddingCount,
} from './embeddings.js';
export { saveDigestEmbedding, getAllDigestEmbeddings } from './digests.js';
export {
  createSessionRecord,
  endSessionRecord,
  updateSessionMemory,
  createWebSession,
  getWebSession,
  deleteExpiredSessions,
  deleteWebSession,
} from './sessions.js';
export {
  getConfig,
  setConfig,
  getConfigBool,
  getConfigNumber,
  getConfigsByPrefix,
  deleteConfig,
  getAllConfig,
} from './config.js';
export type { PushSubscription } from './push.js';
export {
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
  touchPushSubscription,
} from './push.js';
export {
  createCanvas,
  getCanvas,
  listCanvases,
  getAllCanvasTags,
  updateCanvasContent,
  updateCanvasTitle,
  updateCanvasTags,
  deleteCanvas,
} from './canvases.js';
export type { Timer } from './timers.js';
export {
  createTimer,
  listPendingTimers,
  getDueTimers,
  markTimerFired,
  cancelTimer,
} from './timers.js';
export type { TriggerCondition, Trigger } from './triggers.js';
export {
  createTrigger,
  getActiveTriggers,
  markTriggerWaiting,
  markTriggerFired,
  markWatcherFired,
  cancelTrigger,
  listTriggers,
} from './triggers.js';
export {
  createStickerPack,
  getStickerPack,
  listStickerPacks,
  updateStickerPack,
  deleteStickerPack,
  createSticker,
  getSticker,
  getStickerByRef,
  listStickers,
  updateSticker,
  deleteSticker,
  getAllStickersWithPacks,
} from './stickers.js';

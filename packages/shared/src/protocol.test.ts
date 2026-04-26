import { describe, it, expect } from 'vitest';
import { isClientMessage } from './protocol.js';

describe('isClientMessage type guard', () => {
  it('accepts every ClientMessage variant by type tag', () => {
    // The keep-them-honest list — if a new type is added to ClientMessage,
    // it MUST appear here and in protocol.ts:validTypes. Otherwise an
    // explicit decoder/router that hardens against malformed payloads
    // would silently reject the new type.
    const allTypes = [
      'message', 'edit_message', 'delete_message', 'typing', 'read',
      'switch_thread', 'create_thread', 'voice_start', 'voice_audio',
      'voice_stop', 'voice_interrupt', 'voice_mode', 'sync', 'ping', 'request_status',
      'canvas_create', 'canvas_update', 'canvas_update_title', 'canvas_update_tags', 'canvas_delete', 'canvas_list',
      'add_reaction', 'remove_reaction', 'pin_thread', 'unpin_thread', 'visibility',
      'stop_generation', 'mcp_reconnect', 'mcp_toggle', 'rewind_files', 'command',
    ];
    for (const type of allTypes) {
      expect(isClientMessage({ type })).toBe(true);
    }
  });

  // Regression: canvas_update_tags has been part of the ClientMessage
  // union and the backend handler since the canvas tag work landed,
  // but was missing from validTypes — meaning the guard would reject
  // it if any decoder started using the guard for protocol hardening.
  it('REGRESSION: accepts canvas_update_tags', () => {
    expect(isClientMessage({ type: 'canvas_update_tags' })).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage(undefined)).toBe(false);
    expect(isClientMessage('a string')).toBe(false);
    expect(isClientMessage(42)).toBe(false);
    expect(isClientMessage([])).toBe(false);
    expect(isClientMessage({})).toBe(false);
    expect(isClientMessage({ type: 42 })).toBe(false);
    expect(isClientMessage({ type: 'not_a_real_type' })).toBe(false);
  });
});

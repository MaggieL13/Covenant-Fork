import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry, type CovenantTool } from './registry.js';

function makeTool(name: string, override: Partial<CovenantTool> = {}): CovenantTool {
  return {
    name,
    description: override.description ?? `${name} description`,
    parameters: override.parameters ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: override.execute ?? (async () => `${name} output`),
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('starts empty', () => {
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('registers a tool and exposes it via get/list/size', () => {
    const tool = makeTool('read_file');
    registry.register(tool);
    expect(registry.size()).toBe(1);
    expect(registry.get('read_file')).toBe(tool);
    expect(registry.list()).toEqual([tool]);
  });

  it('preserves insertion order in list()', () => {
    const a = makeTool('a');
    const b = makeTool('b');
    const c = makeTool('c');
    registry.register(b);
    registry.register(a);
    registry.register(c);
    expect(registry.list().map((t) => t.name)).toEqual(['b', 'a', 'c']);
  });

  it('throws on duplicate name (silent override would mask bootstrap-order bugs)', () => {
    registry.register(makeTool('read_file'));
    expect(() => registry.register(makeTool('read_file'))).toThrow(
      /already registered/,
    );
    expect(registry.size()).toBe(1);
  });

  // E3b/1 review catch (Codex): the comment documented OpenAI's
  // `[a-zA-Z0-9_-]{1,64}` rule but register() didn't actually enforce
  // it. A bad name would register fine locally then 400 at provider
  // call time with no obvious culprit. Enforce at registration so the
  // throw points at the offending tool.
  describe('name validation', () => {
    it('rejects empty names', () => {
      expect(() => registry.register(makeTool(''))).toThrow(
        /non-empty string/,
      );
    });

    it('rejects names over 64 chars', () => {
      const longName = 'a'.repeat(65);
      expect(() => registry.register(makeTool(longName))).toThrow(
        /exceeds 64 characters/,
      );
    });

    it('accepts names exactly at the 64-char boundary', () => {
      const boundary = 'a'.repeat(64);
      expect(() => registry.register(makeTool(boundary))).not.toThrow();
    });

    it('rejects names with spaces', () => {
      expect(() => registry.register(makeTool('read file'))).toThrow(
        /must match/,
      );
    });

    it('rejects names with dots (no `tool.name` for namespacing)', () => {
      expect(() => registry.register(makeTool('tool.name'))).toThrow(
        /must match/,
      );
    });

    it('rejects names with non-ASCII characters (emoji)', () => {
      expect(() => registry.register(makeTool('🔥'))).toThrow(/must match/);
    });

    it('accepts underscore and hyphen (both in OpenAI pattern)', () => {
      expect(() => registry.register(makeTool('read_file'))).not.toThrow();
      expect(() => registry.register(makeTool('read-file'))).not.toThrow();
    });

    it('accepts alphanumerics across cases', () => {
      expect(() => registry.register(makeTool('Read123File'))).not.toThrow();
    });
  });

  it('get() returns undefined for unknown names (no throw — loop driver expects this)', () => {
    expect(registry.get('not_a_tool')).toBeUndefined();
  });

  it('unregister() removes and reports removal', () => {
    registry.register(makeTool('temp'));
    expect(registry.unregister('temp')).toBe(true);
    expect(registry.size()).toBe(0);
    expect(registry.get('temp')).toBeUndefined();
  });

  it('unregister() returns false for unknown names', () => {
    expect(registry.unregister('never_was_here')).toBe(false);
  });

  it('execute is invoked with the registered args and context', async () => {
    const calls: Array<{ args: unknown; cwd: string }> = [];
    const tool = makeTool('inspect', {
      execute: async (args, ctx) => {
        calls.push({ args, cwd: ctx.scopeRoot });
        return 'ok';
      },
    });
    registry.register(tool);
    const got = registry.get('inspect');
    expect(got).toBeDefined();
    const result = await got!.execute({ x: 1 }, { scopeRoot: '/tmp/scope' });
    expect(result).toBe('ok');
    expect(calls).toEqual([{ args: { x: 1 }, cwd: '/tmp/scope' }]);
  });
});

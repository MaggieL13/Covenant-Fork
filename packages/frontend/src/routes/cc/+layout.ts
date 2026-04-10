import { redirect } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ fetch }) => {
  try {
    const res = await fetch('/api/identity', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data.command_center_enabled === false) {
        throw redirect(302, '/chat');
      }
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) throw e; // re-throw redirect
  }
  return {};
};

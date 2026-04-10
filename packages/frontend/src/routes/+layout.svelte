<script lang="ts">
  import '../app.css';
  import { checkAuth, isAuthenticated, isChecking, isAuthRequired, stopAuthPolling } from '$lib/stores/auth.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import Toast from '$lib/components/Toast.svelte';

  let { children } = $props();
  let currentPath = $derived($page.url.pathname);
  let isLoginPage = $derived(currentPath === '/login');
  let isSetupPage = $derived(currentPath.startsWith('/setup'));

  // Show children only when:
  // - Auth check is done AND (authenticated OR on the login/setup page OR auth not required)
  let showChildren = $derived(
    !isChecking() && (isAuthenticated() || isLoginPage || isSetupPage || !isAuthRequired())
  );

  onMount(async () => {
    // Check if first-run setup is needed (before auth, since there's no password yet)
    try {
      const setupRes = await fetch('/api/setup/status');
      if (setupRes.ok) {
        const setupData = await setupRes.json();
        if (setupData.needsSetup && !window.location.pathname.startsWith('/setup')) {
          // Still need to run checkAuth so showChildren can resolve
          await checkAuth();
          goto('/setup');
          return;
        }
      }
    } catch {
      // Server not reachable — continue with normal auth flow
    }

    await checkAuth();

    // If not authenticated and not on login or setup page, redirect to login
    if (!isAuthenticated() && isAuthRequired() && !isLoginPage && !isSetupPage) {
      goto('/login');
    }
  });

  onDestroy(() => {
    stopAuthPolling();
  });
</script>

{#if showChildren}
  {@render children()}
{:else}
  <div class="loading-screen">
    <div class="spinner"></div>
  </div>
{/if}

<Toast />

<style>
  .loading-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    background: var(--bg-primary);
  }

  .spinner {
    width: 2rem;
    height: 2rem;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

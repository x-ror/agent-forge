import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { AppStateProvider } from './state/app-state';

describe('App shell', () => {
  it('falls back to the login page when unauthenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ title: 'Unauthorized', status: 401 }), { status: 401 })),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AppStateProvider>
          <MemoryRouter>
            <App />
          </MemoryRouter>
        </AppStateProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('AgentForge')).toBeDefined());
    expect(screen.getByLabelText('login form')).toBeDefined();
    vi.unstubAllGlobals();
  });
});

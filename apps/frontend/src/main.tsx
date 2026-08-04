import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AppStateProvider } from './state/app-state';
import './index.scss';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppStateProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AppStateProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

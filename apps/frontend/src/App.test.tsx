import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App shell', () => {
  it('renders the Carbon UIShell header', () => {
    render(<App />);
    expect(screen.getAllByText('AgentForge').length).toBeGreaterThan(0);
    expect(screen.getByText('Task Board')).toBeDefined();
  });
});

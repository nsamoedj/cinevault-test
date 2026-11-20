import type { UserDto } from '@cinevault/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { mockApi, renderAt } from './helpers.js';

const anna: UserDto = {
  id: 'user-1',
  username: 'anna',
  displayName: 'Anna',
  role: 'ADMIN',
  avatarColor: '#4F9DE0',
  createdAt: '2026-10-16T20:00:00.000Z',
};

const home = {
  'GET /api/libraries': () => [],
  'GET /api/continue': () => [],
  'GET /api/stats/codecs': () => ({ files: 0 }),
};

afterEach(() => localStorage.clear());

describe('signing in', () => {
  it('makes the first account on a new server', async () => {
    const calls = mockApi({
      'GET /api/auth/status': () => ({ setupRequired: true }),
      'POST /api/auth/setup': () => ({ user: anna }),
      ...home,
    });
    renderAt('/', <App />);

    expect(await screen.findByRole('heading', { name: 'Welkom bij CineVault' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Naam'), 'Anna');
    await userEvent.type(screen.getByLabelText('Gebruikersnaam'), 'anna');
    await userEvent.type(screen.getByLabelText(/^Wachtwoord \(minstens/), 'een-lang-wachtwoord');
    await userEvent.type(screen.getByLabelText('Wachtwoord nog een keer'), 'een-lang-wachtwoord');
    await userEvent.click(screen.getByRole('button', { name: 'Account maken' }));

    expect(await screen.findByRole('button', { name: 'Profiel van Anna' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      displayName: 'Anna',
      username: 'anna',
      password: 'een-lang-wachtwoord',
    });
    // Remembered for "Wie kijkt er?", without the password.
    expect(localStorage.getItem('cinevault.profiles')).toBe(
      JSON.stringify([{ username: 'anna', displayName: 'Anna', avatarColor: '#4F9DE0' }]),
    );
  });

  it('asks who is watching, and says when the password is wrong', async () => {
    localStorage.setItem(
      'cinevault.profiles',
      JSON.stringify([{ username: 'anna', displayName: 'Anna' }]),
    );
    let attempts = 0;
    const calls = mockApi({
      'GET /api/auth/status': () => ({ setupRequired: false }),
      'POST /api/auth/login': () =>
        attempts++ === 0
          ? Response.json({ error: 'wrong username or password' }, { status: 401 })
          : { user: anna },
      ...home,
    });
    renderAt('/', <App />);

    expect(await screen.findByRole('heading', { name: 'Wie kijkt er?' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Anna' }));
    await userEvent.type(screen.getByLabelText('Wachtwoord'), 'verkeerd-wachtwoord');
    await userEvent.click(screen.getByRole('button', { name: 'Inloggen' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Verkeerde naam of wachtwoord.');

    await userEvent.type(screen.getByLabelText('Wachtwoord'), 'een-lang-wachtwoord');
    await userEvent.click(screen.getByRole('button', { name: 'Inloggen' }));
    expect(await screen.findByRole('button', { name: 'Profiel van Anna' })).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
      username: 'anna',
      password: 'een-lang-wachtwoord',
    });
  });

  it('shows the admin pages only to admins', async () => {
    let signedIn = true;
    mockApi({
      'GET /api/auth/status': () => ({
        setupRequired: false,
        ...(signedIn && { user: { ...anna, role: 'USER' } }),
      }),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return {};
      },
      ...home,
    });
    renderAt('/', <App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Profiel van Anna' }));
    expect(screen.getByRole('menuitem', { name: 'Profiel' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Accounts' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Aandacht nodig' })).toBeNull();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Ander profiel / uitloggen' }));
    expect(await screen.findByRole('heading', { name: 'Inloggen' })).toBeTruthy();
    expect(signedIn).toBe(false);
  });
});

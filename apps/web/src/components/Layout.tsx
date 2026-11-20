import { ageLabel, type LibrarySummary } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import { libraryTypeLabel } from '../format.js';
import { Avatar } from './Avatar.js';
import { Icon, type IconName } from './Icon.js';
import { NotificationBell } from './NotificationBell.js';

const LIBRARY_ICON: Record<LibrarySummary['type'], IconName> = {
  MOVIES: 'film',
  SHOWS: 'tv',
  ANIME: 'sparkles',
};

/** "Films", "Series", "Anime"; the folder name when there are two of a kind. */
export function libraryLabel(library: LibrarySummary, all: LibrarySummary[]): string {
  const sameType = all.filter((l) => l.type === library.type).length;
  return sameType === 1 ? libraryTypeLabel[library.type] : library.name;
}

function useLibraries() {
  return useQuery({ queryKey: keys.libraries, queryFn: api.libraries }).data ?? [];
}

function ScanIndicator() {
  const { data } = useQuery({
    queryKey: keys.scan,
    queryFn: api.scanStatus,
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : 15_000),
  });
  if (!data?.running) return null;
  const done = data.itemsMatched + data.itemsUnmatched + data.itemsFailed;
  const phase =
    data.phase === 'metadata'
      ? `metadata ${done}/${data.itemsTotal}`
      : data.phase === 'probe'
        ? 'bestanden lezen'
        : 'bestanden zoeken';
  return (
    <Link to="/admin" className="scan-indicator" role="status">
      <span className="pulse" aria-hidden="true" />
      <span className="scan-text">
        Scan bezig{data.libraryName ? `: ${data.libraryName}` : ''} · {phase}
      </span>
    </Link>
  );
}

/** TMDB asks for their logo next to the attribution. */
function TmdbLogo() {
  const [available, setAvailable] = useState(true);
  if (!available) return null;
  return (
    <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="tmdb-logo">
      <img src="/branding/tmdb-logo.svg" alt="TMDB" onError={() => setAvailable(false)} />
    </a>
  );
}

export function Attribution() {
  return (
    <footer className="attribution">
      <TmdbLogo />
      <div>
        <p>
          Metadata en afbeeldingen van{' '}
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
            The Movie Database (TMDB)
          </a>
          . This product uses the TMDB API but is not endorsed or certified by TMDB.
        </p>
        <p>
          Seriegegevens deels van{' '}
          <a href="https://www.tvmaze.com" target="_blank" rel="noreferrer">
            TVmaze
          </a>
          , onder{' '}
          <a
            href="https://creativecommons.org/licenses/by-sa/4.0/"
            target="_blank"
            rel="noreferrer"
          >
            CC BY-SA 4.0
          </a>
          .
        </p>
      </div>
    </footer>
  );
}

function ProfileMenu() {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | TouchEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    document.addEventListener('keydown', escape);
    // The first item, so a remote can go straight down the list.
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (!user) return null;
  const go = (path: string) => {
    setOpen(false);
    void navigate(path);
  };
  return (
    <div className="profile-menu" ref={menu} data-focus-scope={open ? 'menu' : undefined}>
      <button
        ref={button}
        type="button"
        className="profile-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Profiel van ${user.displayName}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={user.displayName} color={user.avatarColor} />
        <Icon name="chevronDown" className="caret" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <Avatar name={user.displayName} color={user.avatarColor} />
            <div>
              <strong>{user.displayName}</strong>
              <span>
                {isAdmin
                  ? 'Beheerder'
                  : user.maxAge !== undefined
                    ? `Kinderprofiel · t/m ${ageLabel(user.maxAge)}`
                    : 'Lid'}
              </span>
            </div>
          </div>
          <button type="button" role="menuitem" onClick={() => go('/profile')}>
            <Icon name="user" /> Profiel
          </button>
          <button type="button" role="menuitem" onClick={() => go('/my-list')}>
            <Icon name="plus" /> Mijn lijst
          </button>
          <button type="button" role="menuitem" onClick={() => go('/collections')}>
            <Icon name="grid" /> Collecties
          </button>
          <button type="button" role="menuitem" onClick={() => go('/calendar')}>
            <Icon name="calendar" /> Agenda
          </button>
          {user.maxAge === undefined && (
            <button type="button" role="menuitem" onClick={() => go('/discover')}>
              <Icon name="compass" /> Ontdekken en verzoeken
            </button>
          )}
          {isAdmin && (
            <button type="button" role="menuitem" onClick={() => go('/admin')}>
              <Icon name="settings" /> Beheer
            </button>
          )}
          {isAdmin && (
            <button type="button" role="menuitem" onClick={() => go('/accounts')}>
              <Icon name="users" /> Accounts
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => void logout()}>
            <Icon name="logout" /> Ander profiel / uitloggen
          </button>
        </div>
      )}
    </div>
  );
}

/** The search field in the top bar (wide screens); on phones the tab bar has a search tab. */
function SearchBox() {
  const navigate = useNavigate();
  const onSearch = useMatch('/search');
  const [value, setValue] = useState('');
  if (onSearch) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void navigate(value.trim() ? `/search?q=${encodeURIComponent(value.trim())}` : '/search');
    setValue('');
  };
  return (
    <form className="nav-search" role="search" onSubmit={submit}>
      <Icon name="search" />
      <input
        type="search"
        placeholder="Titels zoeken"
        aria-label="Titels zoeken"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}

function TopNav({ overHero }: { overHero: boolean }) {
  const { isAdmin, isKid } = useAuth();
  const libraries = useLibraries();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`topnav${overHero && !scrolled ? ' clear' : ''}`}>
      <Link to="/" className="brand" aria-label="CineVault, naar de startpagina">
        Cine<span>Vault</span>
      </Link>
      <nav className="nav-links" aria-label="Hoofdmenu">
        <NavLink to="/" end>
          Home
        </NavLink>
        {libraries.map((library) => (
          <NavLink key={library.id} to={`/libraries/${library.id}`}>
            {libraryLabel(library, libraries)}
          </NavLink>
        ))}
        <NavLink to="/my-list">Mijn lijst</NavLink>
        {!isKid && <NavLink to="/discover">Ontdekken</NavLink>}
        {isAdmin && <NavLink to="/attention">Aandacht nodig</NavLink>}
      </nav>
      <div className="nav-tools">
        {isAdmin && <ScanIndicator />}
        <SearchBox />
        <Link to="/search" className="icon-button nav-search-link" aria-label="Zoeken">
          <Icon name="search" />
        </Link>
        <NotificationBell />
        <ProfileMenu />
      </div>
    </header>
  );
}

/** Phones: the main sections as tabs at the bottom, within reach of a thumb. */
function TabBar() {
  const libraries = useLibraries();
  return (
    <nav className="tabbar" aria-label="Snel naar">
      <NavLink to="/" end>
        <Icon name="home" />
        <span>Home</span>
      </NavLink>
      {libraries.slice(0, 3).map((library) => (
        <NavLink key={library.id} to={`/libraries/${library.id}`}>
          <Icon name={LIBRARY_ICON[library.type]} />
          <span>{libraryLabel(library, libraries)}</span>
        </NavLink>
      ))}
      <NavLink to="/search">
        <Icon name="search" />
        <span>Zoeken</span>
      </NavLink>
    </nav>
  );
}

export function Layout() {
  const location = useLocation();
  // The start page and detail pages run their artwork under the top bar.
  const overHero = location.pathname === '/' || location.pathname.startsWith('/items/');

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Naar de inhoud
      </a>
      <TopNav overHero={overHero} />
      <main id="main" className={overHero ? 'with-hero' : undefined}>
        <Outlet />
      </main>
      <Attribution />
      <TabBar />
    </div>
  );
}
